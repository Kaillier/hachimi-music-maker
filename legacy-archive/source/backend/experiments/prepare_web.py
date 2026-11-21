"""Build the lyric-free, offline browser arrangement pack using cached models."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

from pitch_tracks import build_pitch_track

ROOT = Path(__file__).resolve().parents[2]
PROJECTS_ROOT = ROOT / "projects"
WORK = Path(os.environ.get("HACHIMI_WORK", "projects/current"))
if not WORK.is_absolute():
    WORK = ROOT / WORK
ANALYSIS = ROOT / "backend/runtime/game-rmvpe-world"
AI_PYTHON = Path("/home/kaillier/.local/share/hachimi/ai-venv/bin/python")
ANALYSIS_PYTHON = ANALYSIS / ".venv/bin/python"
SOUNDS = ("ha", "ji", "mi", "man", "bo")
VERSION = "openutau-native-v10-independent-modes"
NOTE_MODES = {
    "game-vocal": "GAME · 人声",
    "rosvot-vocal": "ROSVOT · 人声",
    "rosvot-original": "ROSVOT · 原曲",
}
PITCH_MODES = {
    "rmvpe-original": {"label": "RMVPE 原曲", "source": "原曲 source.wav"},
    "fcpe-vocal": {"label": "FCPE 人声", "source": "Demucs vocals.wav"},
    "note-only": {"label": "无音高", "source": "当前音符模式的 MIDI 音符"},
}
TIMING_MODES = {
    "beat": "拍子辅助",
    "raw": "无拍子辅助",
}

TIMESTAMP_RE = re.compile(r"\[(\d+):(\d+(?:\.\d+)?)\]")
CJK_RE = re.compile(r"[\u3400-\u9fff]")


def selected_song() -> Path:
    explicit = os.environ.get("HACHIMI_SONG_PATH")
    if explicit:
        song = Path(explicit).expanduser().resolve()
        if not song.is_file():
            raise ValueError(f"HACHIMI_SONG_PATH does not exist: {song}")
        return song
    files = sorted((ROOT / "music").glob("*.mp3"))
    requested = os.environ.get("HACHIMI_SONG")
    if requested:
        requested_name = Path(requested).name
        matches = [path for path in files if path.name == requested_name or path.stem == requested_name]
        if len(matches) != 1:
            raise ValueError(f"HACHIMI_SONG did not select exactly one MP3: {requested}")
        return matches[0]
    if len(files) != 1:
        raise ValueError("music contains multiple MP3 songs; set HACHIMI_SONG to choose one.")
    return files[0]


def song_info(song: Path) -> dict[str, str]:
    if song.stem == "薛之谦 - 天外来物":
        return {"title": "天外来物", "subtitle": "", "artist": "薛之谦"}
    if "琵琶曲" in song.stem:
        return {"title": "琵琶曲", "subtitle": "（东船与西舫）", "artist": "郑浩 Z-Hao / 冰洁"}
    if " - " in song.stem:
        artist, title = song.stem.split(" - ", 1)
        return {"title": title, "subtitle": "", "artist": artist}
    return {"title": song.stem, "subtitle": "", "artist": ""}


def find_lyrics_file(song: Path | None = None) -> Path | None:
    explicit = os.environ.get("HACHIMI_LYRICS_PATH")
    if explicit:
        lyrics = Path(explicit).expanduser().resolve()
        if not lyrics.is_file():
            raise ValueError(f"HACHIMI_LYRICS_PATH does not exist: {lyrics}")
        return lyrics
    files = sorted((ROOT / "music").glob("*.lrc"))
    if not files:
        return None
    song = song or selected_song()
    exact = [path for path in files if path.stem == song.stem]
    if len(exact) == 1:
        return exact[0]
    # Some downloaders add artist IDs or use different slash/full-width punctuation.
    song_chars = set(CJK_RE.findall(song.stem))
    scored = [(len(song_chars & set(CJK_RE.findall(path.stem))), path) for path in files]
    best = max(score for score, _ in scored)
    matches = [path for score, path in scored if score == best and score >= 3]
    if len(matches) == 1:
        return matches[0]
    raise ValueError(f"Could not match an LRC file to {song.name}.")


def parse_lrc(path: Path) -> tuple[dict, ...]:
    """Read LDDC per-character lines and line-level LRC/JSONL lyric exports."""
    lines = []
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        stripped = raw.strip()
        if stripped.startswith("{"):
            try:
                record = json.loads(stripped)
            except json.JSONDecodeError:
                continue
            text = "".join(part.get("tx", "") for part in record.get("c", []) if isinstance(part, dict))
            visible = text.strip()
            if not record.get("t") or not visible or any(not (CJK_RE.fullmatch(char) or char.isspace()) for char in visible):
                continue
            lines.append({"start": float(record["t"]) / 1000, "text": re.sub(r"\s+", " ", visible), "chars": None})
            continue
        matches = list(TIMESTAMP_RE.finditer(raw))
        if not matches:
            # Plain TXT lyrics have no timing authority. Keep their line text
            # as a validation/reference record and let the acoustic fallback
            # derive render units from GAME and the vocal signal.
            visible = stripped
            if visible and any(CJK_RE.fullmatch(char) for char in visible) and all(
                CJK_RE.fullmatch(char) or char.isspace() for char in visible
            ):
                lines.append({"start": 0.0, "text": re.sub(r"\s+", " ", visible), "chars": None})
            continue
        visible = TIMESTAMP_RE.sub("", raw).strip()
        # Metadata contains Latin labels or punctuation; song lines are CJK plus spaces.
        if not visible or any(not (CJK_RE.fullmatch(char) or char.isspace()) for char in visible):
            continue
        minutes = int(matches[0].group(1))
        seconds = float(matches[0].group(2))
        if len(matches) == 1:
            lines.append({
                "start": minutes * 60 + seconds,
                "text": re.sub(r"\s+", " ", visible),
                "chars": None,
            })
            continue
        chars = []
        for index, match in enumerate(matches):
            end = matches[index + 1].start() if index + 1 < len(matches) else len(raw)
            segment = raw[match.end():end]
            char = CJK_RE.search(segment)
            if char:
                minutes = int(match.group(1))
                seconds = float(match.group(2))
                chars.append({"start": minutes * 60 + seconds, "text": char.group(0)})
        if chars:
            lines.append({"start": chars[0]["start"], "text": "".join(c["text"] for c in chars), "chars": chars})
    if not lines:
        raise ValueError(f"No usable CJK lyrics found in {path.name}.")
    return tuple(lines)


def estimate_tempo_grid(backing_path, duration):
    """Use librosa's established beat tracker to create a score grid.

    This is deliberately kept as analysis input. OpenUtau remains the score
    and renderer; this function only supplies a tempo/grid estimate that can
    be inspected and corrected before a USTX is built.
    """
    import librosa
    import numpy as np

    audio, sample_rate = librosa.load(backing_path, sr=None, mono=True)
    tempo, beats = librosa.beat.beat_track(
        y=audio,
        sr=sample_rate,
        units="time",
        trim=False,
    )
    tempo_value = float(np.asarray(tempo).reshape(-1)[0]) if np.asarray(tempo).size else 120.0
    beats = np.asarray(beats, dtype=np.float64)
    beats = beats[(beats >= 0.0) & (beats <= duration)]
    if len(beats) >= 3:
        interval = float(np.median(np.diff(beats)))
        origin = float(beats[0])
    else:
        interval = 60.0 / max(tempo_value, 1e-6)
        origin = 0.0
        beats = origin + np.arange(0.0, duration + interval, interval)
    return {
        "bpm": round(tempo_value, 6),
        "beatOffset": round(origin, 6),
        "beatInterval": round(interval, 6),
        "gridStep": round(interval / 4.0, 6),
        "beats": [round(float(value), 6) for value in beats],
        "source": "librosa beat_track on Demucs accompaniment",
    }


def _beat_grid_candidates(tempo_info):
    import numpy as np

    beats = np.asarray(tempo_info.get("beats", []), dtype=np.float64)
    beats = beats[np.isfinite(beats)]
    if len(beats) >= 2:
        intervals = np.diff(beats)
        candidates = [
            float(left + (right - left) * subdivision / 4.0)
            for left, right in zip(beats[:-1], beats[1:])
            for subdivision in range(4)
        ]
        candidates.append(float(beats[-1]))
        tolerance = min(0.040, float(np.median(intervals)) / 4.0 * 0.30)
    else:
        step = float(tempo_info["gridStep"])
        origin = float(tempo_info["beatOffset"])
        candidates = [origin + index * step for index in range(10000)]
        tolerance = min(0.040, step * 0.30)
    return np.asarray(candidates, dtype=np.float64), tolerance


def align_game_notes_to_grid(game_notes, tempo_info):
    """Keep GAME note timing and only make a small local beat-grid correction."""
    import numpy as np

    if not game_notes:
        return ()
    note_type = type(game_notes[0])
    candidates, tolerance = _beat_grid_candidates(tempo_info)

    def snap(value):
        candidate = float(candidates[np.argmin(np.abs(candidates - value))])
        return candidate if abs(candidate - value) <= tolerance else value

    aligned = []
    for original in game_notes:
        start = snap(float(original.onset_seconds))
        end = snap(float(original.offset_seconds))
        if end - start < 0.025:
            start = float(original.onset_seconds)
            end = float(original.offset_seconds)
        if aligned and start < aligned[-1].offset_seconds:
            boundary = (aligned[-1].offset_seconds + start) / 2.0
            previous = aligned[-1]
            aligned[-1] = note_type(previous.onset_seconds, boundary, previous.pitch)
            start = boundary
        if end <= start:
            end = start + 0.020
        aligned.append(note_type(start, end, original.pitch))
    return tuple(aligned)


def _distance_to_interval(value, start, end):
    if value < start:
        return start - value
    if value > end:
        return value - end
    return 0.0


def partition_game_notes_by_characters(anchor_units, game_notes):
    """Use LDDC anchors only to group ordered GAME notes under lyric characters."""
    from math import inf

    character_count = len(anchor_units)
    note_count = len(game_notes)
    if character_count == 0:
        return []
    minimum_per_character = 1 if note_count >= character_count else 0
    costs = [[0.0] * (note_count + 1) for _ in range(character_count)]
    for character_index, anchor in enumerate(anchor_units):
        for note_index, note in enumerate(game_notes, start=1):
            midpoint = (note.onset_seconds + note.offset_seconds) / 2.0
            costs[character_index][note_index] = (
                costs[character_index][note_index - 1]
                + _distance_to_interval(
                    midpoint,
                    anchor.start_seconds,
                    anchor.end_seconds,
                ) / max(0.08, anchor.end_seconds - anchor.start_seconds)
            )

    dp = [[inf] * (note_count + 1) for _ in range(character_count + 1)]
    previous = [[None] * (note_count + 1) for _ in range(character_count + 1)]
    dp[0][0] = 0.0
    for character_index in range(character_count):
        for consumed in range(note_count + 1):
            if dp[character_index][consumed] == inf:
                continue
            minimum = minimum_per_character
            for end in range(consumed + minimum, note_count + 1):
                if character_index == character_count - 1 and end != note_count:
                    continue
                take = end - consumed
                block_cost = costs[character_index][end] - costs[character_index][consumed]
                if take == 0:
                    block_cost += 0.55
                candidate = dp[character_index][consumed] + block_cost
                if candidate < dp[character_index + 1][end]:
                    dp[character_index + 1][end] = candidate
                    previous[character_index + 1][end] = consumed

    if previous[character_count][note_count] is None:
        # This is only a defensive fallback for malformed or empty analysis.
        blocks = [[] for _ in anchor_units]
        for index, note in enumerate(game_notes):
            blocks[min(index, character_count - 1)].append(note)
        return blocks

    cuts = [note_count]
    consumed = note_count
    for character_index in range(character_count, 0, -1):
        consumed = previous[character_index][consumed]
        cuts.append(consumed)
    cuts.reverse()
    return [list(game_notes[left:right]) for left, right in zip(cuts, cuts[1:])]


def fill_empty_game_blocks(blocks, note_type):
    """Split a neighboring GAME interval when a lyric char has no detected note."""
    for index, block in enumerate(blocks):
        if block:
            continue
        previous = blocks[index - 1][-1] if index > 0 and blocks[index - 1] else None
        following = blocks[index + 1][0] if index + 1 < len(blocks) and blocks[index + 1] else None
        if previous and previous.offset_seconds - previous.onset_seconds >= 0.050:
            boundary = (previous.onset_seconds + previous.offset_seconds) / 2.0
            blocks[index - 1][-1] = note_type(previous.onset_seconds, boundary, previous.pitch)
            blocks[index] = [note_type(boundary, previous.offset_seconds, previous.pitch)]
        elif following and following.offset_seconds - following.onset_seconds >= 0.050:
            boundary = (following.onset_seconds + following.offset_seconds) / 2.0
            blocks[index] = [note_type(following.onset_seconds, boundary, following.pitch)]
            blocks[index + 1][0] = note_type(boundary, following.offset_seconds, following.pitch)


def _fallback_game_unit(blocks, index, note_type):
    """Create a minimal GAME-derived slot only when GAME missed a lyric character."""
    previous = next((block[-1] for block in reversed(blocks[:index]) if block), None)
    following = next((block[0] for block in blocks[index + 1:] if block), None)
    if previous and following and following.onset_seconds - previous.offset_seconds >= 0.025:
        return note_type(
            previous.offset_seconds,
            following.onset_seconds,
            previous.pitch,
        )
    reference = following or previous
    if reference is None:
        return note_type(0.0, 0.020, 60.0)
    center = reference.onset_seconds if following else reference.offset_seconds
    start = max(0.0, center - 0.010)
    return note_type(start, start + 0.020, reference.pitch)


def build_game_first_segmentation(lyrics, anchor_units, game_notes, times, pitch, *, preserve_game_timing=False):
    """Build lyric units from GAME timing, using LDDC only for character grouping."""
    import numpy as np

    expected = sum(len(line["chars"]) for line in lyrics)
    if len(anchor_units) != expected:
        raise ValueError(
            "LDDC character count does not match the OpenUtau lyric parser: "
            f"{expected} != {len(anchor_units)}"
        )
    note_type = type(game_notes[0]) if game_notes else None
    if note_type is None:
        raise ValueError("GAME produced no notes for lyric-guided segmentation")

    line_groups = []
    cursor = 0
    for line in lyrics:
        group = tuple(anchor_units[cursor : cursor + len(line["chars"])])
        cursor += len(group)
        line_groups.append(group)

    line_notes = []
    for line_index, group in enumerate(line_groups):
        left = (
            (line_groups[line_index - 1][-1].end_seconds + group[0].start_seconds) / 2.0
            if line_index
            else max(0.0, group[0].start_seconds - 0.5)
        )
        right = (
            (group[-1].end_seconds + line_groups[line_index + 1][0].start_seconds) / 2.0
            if line_index + 1 < len(line_groups)
            else group[-1].end_seconds + 0.5
        )
        line_notes.append([
            note for note in game_notes
            if left <= (note.onset_seconds + note.offset_seconds) / 2.0 < right
        ])

    units = []
    phrases = []
    cursor = 0
    for line_index, line in enumerate(lyrics):
        anchors = line_groups[line_index]
        blocks = partition_game_notes_by_characters(anchors, line_notes[line_index])
        if not preserve_game_timing:
            fill_empty_game_blocks(blocks, note_type)
        ids = []
        for lyric, anchor, block in zip(line["chars"], anchors, blocks):
            if not block:
                if preserve_game_timing:
                    previous = next((b[-1] for b in reversed(blocks[:len(ids)]) if b), None)
                    following = next((b[0] for b in blocks[len(ids) + 1:] if b), None)
                    reference = previous or following
                    position = previous.offset_seconds if previous else following.onset_seconds if following else 0.0
                    ids.append(len(units))
                    units.append({
                        "id": len(units), "start": float(position), "end": float(position),
                        "midi": float(reference.pitch) if reference else 60.0,
                        "text": lyric["text"], "notes": [], "timingMissing": True,
                        "lyricAnchorStart": float(anchor.start_seconds),
                        "lyricAnchorEnd": float(anchor.end_seconds),
                    })
                    continue
                fallback = _fallback_game_unit(blocks, len(ids), note_type)
                block = [fallback]
            start = float(block[0].onset_seconds)
            end = float(block[-1].offset_seconds)
            # The note mode owns the base MIDI tone. The pitch mode only
            # supplies an optional continuous curve later in OpenUtau.
            midi = float(np.median([note.pitch for note in block]))
            ids.append(len(units))
            units.append({
                "id": len(units),
                "start": start if preserve_game_timing else round(start, 4),
                "end": end if preserve_game_timing else round(max(start + 0.020, end), 4),
                "midi": round(midi, 2),
                "text": lyric["text"],
                "notes": [
                    {
                        "start": float(note.onset_seconds) if preserve_game_timing else round(float(note.onset_seconds), 4),
                        "end": float(note.offset_seconds) if preserve_game_timing else round(float(note.offset_seconds), 4),
                        "midi": int(np.clip(round(float(note.pitch)), 0, 127)),
                    }
                    for note in block
                ],
                # Diagnostic only: these anchors are never used as render times.
                "lyricAnchorStart": round(float(anchor.start_seconds), 4),
                "lyricAnchorEnd": round(float(anchor.end_seconds), 4),
            })
        if ids:
            voiced_units = [units[i] for i in ids if not units[i].get("timingMissing")]
            phrases.append({
                "id": len(phrases),
                "start": voiced_units[0]["start"] if voiced_units else units[ids[0]]["start"],
                "end": voiced_units[-1]["end"] if voiced_units else units[ids[-1]]["end"],
                "units": ids,
                "text": line["text"],
            })
        cursor += len(anchors)
    return phrases, units


def build_raw_note_segmentation(notes):
    """No word-timed lyrics: each detected GAME note is one replacement unit."""
    phrases, units = [], []
    for note in notes:
        start, end = float(note.onset_seconds), float(note.offset_seconds)
        if not phrases or start - phrases[-1]["end"] > .32 or end - phrases[-1]["start"] > 6.5:
            phrases.append({"id": len(phrases), "start": start, "end": end, "units": []})
        identifier = len(units)
        midi = int(round(note.pitch))
        units.append({"id": identifier, "start": start, "end": end, "midi": midi,
                      "notes": [{"start": start, "end": end, "midi": midi}]})
        phrases[-1]["units"].append(identifier)
        phrases[-1]["end"] = end
    return phrases, units


def build_acoustic_segmentation(notes, times, pitch, rms, duration, reference):
    """Fallback for projects without per-character LDDC timings."""
    import numpy as np
    from scipy.ndimage import gaussian_filter1d
    from scipy.signal import find_peaks

    energy = gaussian_filter1d(rms, 2)
    groups = []
    for note in notes:
        if not groups or note.onset_seconds - groups[-1][-1].offset_seconds > .32 or note.offset_seconds - groups[-1][0].onset_seconds > 6.5:
            groups.append([])
        groups[-1].append(note)
    phrases = []
    units = []
    for group in groups:
        start = max(0.0, group[0].onset_seconds - .035)
        end = min(duration, group[-1].offset_seconds + .08)
        cuts = [start]
        for left, right in zip(group, group[1:]):
            boundary = right.onset_seconds
            gap = right.onset_seconds - left.offset_seconds
            local = (times >= boundary - .085) & (times <= boundary + .035)
            valley = float(np.min(energy[local])) if np.any(local) else reference
            previous = (times >= max(cuts[-1], boundary - .24)) & (times < boundary)
            local_peak = float(np.max(energy[previous])) if np.any(previous) else reference
            if boundary - cuts[-1] >= .16 and (gap > .04 or valley < local_peak * .74):
                cuts.append(boundary)
        low, high = np.searchsorted(times, [start + .14, end - .14])
        valleys, _ = find_peaks(-energy[low:high], prominence=reference * .13, distance=32)
        for valley in valleys:
            point = float(times[low + valley])
            if min(abs(point - cut) for cut in cuts + [end]) >= .17:
                cuts.append(point)
        cuts = sorted(cuts) + [end]
        ids = []
        for left, right in zip(cuts, cuts[1:]):
            local = (times >= left) & (times < right) & np.isfinite(pitch)
            if not np.any(local):
                continue
            ids.append(len(units))
            units.append({
                "id": len(units),
                "start": round(left, 4),
                "end": round(right, 4),
                "midi": round(float(np.median(pitch[local])), 2),
            })
        if ids:
            phrases.append({
                "id": len(phrases),
                "start": round(max(0, start - .12), 4),
                "end": round(min(duration, end + .16), 4),
                "units": ids,
            })
    for left, right in zip(phrases, phrases[1:]):
        if left["end"] > right["start"]:
            boundary = (units[left["units"][-1]]["end"] + units[right["units"][0]]["start"]) / 2
            left["end"] = right["start"] = round(boundary, 4)
            units[left["units"][-1]]["end"] = min(units[left["units"][-1]]["end"], left["end"])
            units[right["units"][0]]["start"] = max(units[right["units"][0]]["start"], right["start"])
    return phrases, units


def run(command, name, env=None):
    print(name, flush=True)
    with (WORK / f"{name}.log").open("w") as log:
        subprocess.run([str(x) for x in command], check=True, stdout=log, stderr=subprocess.STDOUT, env=env)


def prepare():
    global WORK
    song = selected_song()
    if "HACHIMI_WORK" not in os.environ:
        WORK = PROJECTS_ROOT / song_id(song)
    WORK.mkdir(parents=True, exist_ok=True)
    os.environ["HACHIMI_WORK"] = str(WORK)
    lyrics_path = find_lyrics_file(song)
    if lyrics_path is not None:
        os.environ["HACHIMI_LYRICS_PATH"] = str(lyrics_path)
    else:
        os.environ.pop("HACHIMI_LYRICS_PATH", None)
    song_hash = hashlib.sha256(song.read_bytes()).hexdigest()
    signature_file = WORK / "source-sha256.txt"
    source_changed = not signature_file.exists() or signature_file.read_text() != song_hash
    source = WORK / "source.wav"
    if source_changed or not source.exists():
        import soundfile as sf
        audio, sr = sf.read(song, dtype="float32", always_2d=True)
        sf.write(source, audio, sr, subtype="PCM_24")
    vocals = WORK / "demucs/adefossez_htdemucs/source/vocals.wav"
    env = dict(os.environ, HF_HOME="/home/kaillier/.local/share/hachimi/huggingface", HF_HUB_OFFLINE="1", PYTHONDONTWRITEBYTECODE="1")
    if source_changed or not vocals.exists():
        run([AI_PYTHON, "-m", "demucs.separate", "-n", "hf://adefossez/htdemucs", "--two-stems", "vocals", "--other-method", "minus", "--device", "cuda", "--segment", "6", "--shifts", "0", "--overlap", "0.25", "--int24", "--out", WORK / "demucs", source], "01-separation", env)
    for directory in ("game", "rmvpe", "fcpe", "rosvot"):
        (WORK / directory).mkdir(exist_ok=True)
    if source_changed or not (WORK / "game/vocals.csv").exists():
        run([ANALYSIS_PYTHON, ANALYSIS / "tools/GAME-1.0.3/infer.py", "extract", vocals, "-m", ANALYSIS / "models/GAME-1.0-large/model.pt", "--language", "zh", "--batch-size", "1", "--num-workers", "0", "--output-formats", "mid,csv", "--pitch-format", "number", "--output-dir", WORK / "game"], "02-notes", env)
    if source_changed or not (WORK / "rmvpe/vocals-f0.csv").exists():
        run([ANALYSIS_PYTHON, ANALYSIS / "tools/RMVPE-230917/main.py", "-m", ANALYSIS / "models/model.pt", "-d", "cuda", "-i", vocals, "-o", WORK / "rmvpe/vocals-f0.csv", "-hop", "160", "-th", "0.03"], "03-pitch-rmvpe-vocal", env)
    if source_changed or not (WORK / "rmvpe/original-f0.csv").exists():
        run([ANALYSIS_PYTHON, ANALYSIS / "tools/RMVPE-230917/main.py", "-m", ANALYSIS / "models/model.pt", "-d", "cuda", "-i", source, "-o", WORK / "rmvpe/original-f0.csv", "-hop", "160", "-th", "0.03"], "03-pitch-rmvpe-original", env)
    if source_changed or not (WORK / "fcpe/vocals-f0.csv").exists():
        run([ANALYSIS_PYTHON, ROOT / "backend/experiments/extract_fcpe.py", vocals, WORK / "fcpe/vocals-f0.csv", "--device", "cuda"], "03-pitch-fcpe-vocal", env)
    def rosvot_ready(path: Path) -> bool:
        report = path.parent / "report.json"
        if not path.exists() or not (path.parent / "notes.csv").exists() or not report.exists():
            return False
        try:
            return json.loads(report.read_text(encoding="utf-8")).get("extractorVersion") == "rosvot-chunked-v2"
        except (OSError, json.JSONDecodeError):
            return False

    if source_changed or not rosvot_ready(WORK / "rosvot/original/f0.csv"):
        run([ANALYSIS_PYTHON, ROOT / "backend/experiments/extract_rosvot.py", source, WORK / "rosvot/original/f0.csv", "--python", ANALYSIS_PYTHON], "03-notes-rosvot-original", env)
    if source_changed or not rosvot_ready(WORK / "rosvot/vocal/f0.csv"):
        run([ANALYSIS_PYTHON, ROOT / "backend/experiments/extract_rosvot.py", vocals, WORK / "rosvot/vocal/f0.csv", "--python", ANALYSIS_PYTHON], "03-notes-rosvot-vocal", env)
    signature_file.write_text(song_hash)
    run([ANALYSIS_PYTHON, __file__, "--analyze"], "04-analysis", env)
    run([ANALYSIS_PYTHON, __file__, "--pack"], "05-pack", env)
    print("OpenUtau native website pack ready", flush=True)


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def write_pitch_modes(work: Path, pitch_tracks: dict[str, tuple], prefix: str = "") -> dict[str, str]:
    import numpy as np

    paths = {}
    for mode, (times, pitch, _anchors) in pitch_tracks.items():
        if not np.any(np.isfinite(pitch)):
            raise ValueError(f"No voiced pitch in GAME intervals for mode {mode}")
        path = work / f"pitch-{prefix}{mode}.csv"
        with path.open("w", encoding="utf-8") as handle:
            handle.write("time,midi\n")
            for time, value in zip(times, pitch):
                if np.isfinite(value):
                    handle.write(f"{float(time):.6f},{float(value):.6f}\n")
        paths[mode] = str(path.relative_to(ROOT)).replace("\\", "/")
    return paths


def pitch_mode_metadata(paths: dict[str, str]) -> dict[str, dict[str, str]]:
    return {
        mode: {**info, "pitch": paths.get(mode)}
        for mode, info in PITCH_MODES.items()
    }


def timing_mode_metadata(work: Path) -> dict[str, dict[str, str]]:
    return {
        "beat": {
            "label": TIMING_MODES["beat"],
            "analysis": str((work / "analysis.json").relative_to(ROOT)).replace("\\", "/"),
        },
        "raw": {
            "label": TIMING_MODES["raw"],
            "analysis": str((work / "analysis-game-raw.json").relative_to(ROOT)).replace("\\", "/"),
        },
    }


def write_raw_timing_variant(
    work: Path,
    song: Path,
    lyrics_path: Path | None,
    lyrics,
    duration: float,
    backing_path: Path,
    tempo_info: dict,
    raw_notes,
    anchor_units,
    exact_timestamps: bool,
) -> None:
    pitch_sources = {
        "rmvpe-vocal": work / "rmvpe/vocals-f0.csv",
        "rmvpe-original": work / "rmvpe/original-f0.csv",
        "fcpe-vocal": work / "fcpe/vocals-f0.csv",
        "rosvot-original": work / "rosvot/original/f0.csv",
    }
    pitch_tracks = {
        mode: build_pitch_track(raw_notes, path, duration=duration)
        for mode, path in pitch_sources.items()
    }
    times, pitch, _anchors = pitch_tracks["rmvpe-vocal"]
    if exact_timestamps:
        phrases, units = build_game_first_segmentation(
            lyrics, anchor_units, raw_notes, times, pitch,
            preserve_game_timing=True,
        )
        lyric_meta = {
            "source": lyrics_path.name,
            "mode": "GAME raw note timing; LDDC character grouping only",
            "lines": len(lyrics),
            "characters": len(anchor_units),
        }
    else:
        phrases, units = build_raw_note_segmentation(raw_notes)
        lyric_meta = None
    pitch_paths = write_pitch_modes(work, pitch_tracks, prefix="raw-")
    info = song_info(song)
    metadata = {
        "version": VERSION,
        **info,
        "sourceFile": song.name,
        "duration": duration,
        "sampleRate": 44100,
        "phrases": phrases,
        "units": units,
        "tempo": tempo_info,
        "timingMode": "game-raw",
        "timingModeDefault": "game-raw",
        "timingModes": timing_mode_metadata(work),
        "timingMissingCharacters": sum(bool(unit.get("timingMissing")) for unit in units),
        "pitchModeDefault": "rmvpe-vocal",
        "renderMode": "openutau-native",
        "nativeRender": {
            "voicebank": "audio",
            "backing": str(backing_path.relative_to(ROOT)).replace("\\", "/"),
            "analysis": str((work / "analysis-game-raw.json").relative_to(ROOT)).replace("\\", "/"),
            "pitch": pitch_paths["rmvpe-vocal"],
            "pitchModes": pitch_mode_metadata(pitch_paths),
            "renderer": "WORLDLINE-R",
            "resampler": "worldline",
            "wavtool": "convergence",
        },
        "method": "Demucs + GAME raw note timing + LDDC character grouping + selectable RMVPE/FCPE pitch sources + OpenUtau WORLDLINE-R",
    }
    if lyric_meta is not None:
        metadata["lyrics"] = lyric_meta
    (work / "analysis-game-raw.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2),
    )


def write_rosvot_timing_variant(
    fusion,
    work: Path,
    song: Path,
    lyrics_path: Path | None,
    lyrics,
    duration: float,
    backing_path: Path,
    tempo_info: dict,
    rosvot_notes,
    anchor_units,
    exact_timestamps: bool,
) -> None:
    pitch_sources = {
        "rmvpe-vocal": work / "rmvpe/vocals-f0.csv",
        "rmvpe-original": work / "rmvpe/original-f0.csv",
        "fcpe-vocal": work / "fcpe/vocals-f0.csv",
        "rosvot-original": work / "rosvot/original-f0.csv",
    }
    pitch_tracks = {
        mode: build_pitch_track(rosvot_notes, path, duration=duration)
        for mode, path in pitch_sources.items()
    }
    times, pitch, _anchors = pitch_tracks["rosvot-original"]
    if exact_timestamps:
        phrases, units = build_game_first_segmentation(
            lyrics, anchor_units, rosvot_notes, times, pitch,
            preserve_game_timing=True,
        )
        lyric_meta = {
            "source": lyrics_path.name,
            "mode": "ROSVOT note timing and pitch; LDDC character grouping only",
            "lines": len(lyrics),
            "characters": len(anchor_units),
        }
    else:
        phrases, units = build_raw_note_segmentation(rosvot_notes)
        lyric_meta = None
    pitch_paths = write_pitch_modes(work, pitch_tracks, prefix="rosvot-")
    info = song_info(song)
    metadata = {
        "version": VERSION,
        **info,
        "sourceFile": song.name,
        "duration": duration,
        "sampleRate": 44100,
        "phrases": phrases,
        "units": units,
        "tempo": tempo_info,
        "timingMode": "rosvot-score",
        "timingModeDefault": "rosvot-score",
        "timingModes": timing_mode_metadata(work),
        "pitchModeDefault": "rosvot-original",
        "renderMode": "openutau-native",
        "nativeRender": {
            "voicebank": "audio",
            "backing": str(backing_path.relative_to(ROOT)).replace("\\", "/"),
            "analysis": str((work / "analysis-rosvot-score.json").relative_to(ROOT)).replace("\\", "/"),
            "pitch": pitch_paths["rosvot-original"],
            "pitchModes": pitch_mode_metadata(pitch_paths),
            "renderer": "WORLDLINE-R",
            "resampler": "worldline",
            "wavtool": "convergence",
        },
        "method": "ROSVOT original-song note timing + pitch + LDDC character grouping + OpenUtau WORLDLINE-R",
    }
    if lyric_meta is not None:
        metadata["lyrics"] = lyric_meta
    (work / "analysis-rosvot-score.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2),
    )


def analyze():
    import numpy as np
    import soundfile as sf

    fusion = load_module(ANALYSIS / "run_world_fusion.py", "fusion")
    guide, sr = sf.read(WORK / "demucs/adefossez_htdemucs/source/vocals.wav", always_2d=True)
    mono = guide.mean(axis=1)
    duration = len(guide) / sr
    raw_notes = fusion.read_game_notes(WORK / "game/vocals.csv")
    rosvot_vocal_notes = fusion.read_game_notes(WORK / "rosvot/vocal/notes.csv")
    rosvot_original_notes = fusion.read_game_notes(WORK / "rosvot/original/notes.csv")
    notes = raw_notes
    song = selected_song()
    lyrics_path = find_lyrics_file(song)
    lyrics = parse_lrc(lyrics_path) if lyrics_path else None
    backing_path = WORK / "demucs/adefossez_htdemucs/source/minus_vocals.wav"
    if not backing_path.exists():
        backing_path = backing_path.with_name("no_vocals.wav")
    tempo_info = estimate_tempo_grid(backing_path, duration) if backing_path.exists() else {
        "bpm": 120.0,
        "beatOffset": 0.0,
        "beatInterval": 0.5,
        "gridStep": 0.125,
        "beats": [],
        "source": "fallback; accompaniment unavailable",
    }
    # GAME owns note timing. The beat grid can make a small local correction,
    # but it is never allowed to replace the detected note intervals wholesale.
    notes = align_game_notes_to_grid(raw_notes, tempo_info)
    pitch_sources = {
        "rmvpe-vocal": WORK / "rmvpe/vocals-f0.csv",
        "rmvpe-original": WORK / "rmvpe/original-f0.csv",
        "fcpe-vocal": WORK / "fcpe/vocals-f0.csv",
        "rosvot-original": WORK / "rosvot/original/f0.csv",
    }
    pitch_tracks = {
        mode: build_pitch_track(notes, path, duration=duration)
        for mode, path in pitch_sources.items()
    }
    times, pitch, anchors = pitch_tracks["rmvpe-vocal"]
    rms = fusion.frame_rms(mono, sr, times)
    active = rms[np.isfinite(anchors)]
    ref = float(np.quantile(active, .9)) if active.size else 1.0

    exact_timestamps = bool(lyrics) and all(line.get("chars") for line in lyrics)
    if exact_timestamps:
        # LDDC is used only to map lyric characters to ordered GAME note
        # blocks. Its timestamps remain diagnostic anchors, never render cuts.
        anchor_units = fusion.parse_word_timed_lrc(
            lyrics_path,
            source_offset=0.0,
            duration=duration,
        )
        phrases, units = build_game_first_segmentation(
            lyrics,
            anchor_units,
            notes,
            times,
            pitch,
        )
        pitch_paths = write_pitch_modes(WORK, pitch_tracks)
        lyric_meta = {
            "source": lyrics_path.name,
            "mode": "GAME note timing + local beat grid; LDDC character grouping only",
            "lines": len(lyrics),
            "characters": len(anchor_units),
        }
        np.savez(WORK / "analysis.npz", times=times, pitch=pitch, rms=rms, reference=ref)
        info = song_info(song)
        metadata = {
            "version": VERSION,
            **info,
            "sourceFile": song.name,
            "duration": duration,
            "sampleRate": 32000,
            "phrases": phrases,
            "units": units,
            "lyrics": lyric_meta,
            "tempo": tempo_info,
            "timingMode": "game-beat",
            "timingModeDefault": "game-beat",
            "timingModes": timing_mode_metadata(WORK),
            "pitchModeDefault": "rmvpe-vocal",
            "renderMode": "openutau-native",
            "nativeRender": {
                "voicebank": "audio",
                "backing": str(backing_path.relative_to(ROOT)).replace("\\", "/"),
                "analysis": str((WORK / "analysis.json").relative_to(ROOT)).replace("\\", "/"),
                "pitch": pitch_paths["rmvpe-vocal"],
                "pitchModes": pitch_mode_metadata(pitch_paths),
                "renderer": "WORLDLINE-R",
                "resampler": "worldline",
                "wavtool": "convergence",
            },
            "method": "Demucs + GAME-first note timing + local beat assist + LDDC character grouping + selectable RMVPE/FCPE pitch sources + OpenUtau WORLDLINE-R",
        }
        (WORK / "analysis.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2))
        write_raw_timing_variant(
            WORK, song, lyrics_path, lyrics, duration,
            backing_path, tempo_info, raw_notes, anchor_units, True,
        )
        write_rosvot_timing_variant(
            fusion, WORK, song, lyrics_path, lyrics, duration,
            backing_path, tempo_info, rosvot_notes, anchor_units, True,
        )
        print(json.dumps({"duration": duration, "notes": len(notes), "phrases": len(phrases), "units": len(units), "lyrics": lyric_meta, "tempo": tempo_info}, ensure_ascii=False))
        return

    # No per-character lyrics: retain the old acoustic fallback rather than
    # inventing character timings from line timestamps.
    active_notes = [
        note
        for note in notes
        if note.offset_seconds - note.onset_seconds >= .065
        and np.mean(rms[(times >= note.onset_seconds) & (times < note.offset_seconds)]) > max(.004, ref * .06)
    ]
    phrases, units = build_acoustic_segmentation(
        active_notes,
        times,
        pitch,
        rms,
        duration,
        ref,
    )
    np.savez(WORK / "analysis.npz", times=times, pitch=pitch, rms=rms, reference=ref)
    pitch_paths = write_pitch_modes(WORK, pitch_tracks)
    info = song_info(song)
    metadata = {"version": VERSION, **info, "sourceFile": song.name, "duration": duration, "sampleRate": 44100, "phrases": phrases, "units": units, "tempo": tempo_info, "timingMode": "game-beat", "timingModes": timing_mode_metadata(WORK), "pitchModeDefault": "rmvpe-vocal", "renderMode": "openutau-native", "nativeRender": {"voicebank": "audio", "backing": str(backing_path.relative_to(ROOT)).replace("\\", "/"), "analysis": str((WORK / "analysis.json").relative_to(ROOT)).replace("\\", "/"), "pitch": pitch_paths["rmvpe-vocal"], "pitchModes": pitch_mode_metadata(pitch_paths), "renderer": "WORLDLINE-R", "resampler": "worldline", "wavtool": "convergence"}, "method": "Demucs + GAME-first note timing + local beat assist + LDDC character grouping + selectable RMVPE/FCPE pitch sources + OpenUtau WORLDLINE-R"}
    metadata["timingModeDefault"] = "game-beat"
    (WORK / "analysis.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2))
    write_raw_timing_variant(
        WORK, song, lyrics_path, lyrics, duration,
        backing_path, tempo_info, raw_notes, None, False,
    )
    write_rosvot_timing_variant(
        fusion, WORK, song, lyrics_path, lyrics, duration,
        backing_path, tempo_info, rosvot_notes, None, False,
    )
    print(json.dumps({"duration": duration, "notes": len(notes), "phrases": len(phrases), "units": len(units), "first": phrases[:3]}))


def write_absolute_pitch_modes(work: Path, duration: float) -> dict[str, str | None]:
    """Write pitch curves independently of the selected note source."""
    import numpy as np

    sources = {
        "rmvpe-original": work / "rmvpe/original-f0.csv",
        "fcpe-vocal": work / "fcpe/vocals-f0.csv",
    }
    paths: dict[str, str | None] = {"note-only": None}
    for mode, source in sources.items():
        data = np.loadtxt(source, delimiter=",", ndmin=2)
        if data.shape[1] != 2:
            raise ValueError(f"Invalid F0 CSV: {source}")
        destination = work / f"pitch-{mode}.csv"
        with destination.open("w", encoding="utf-8") as handle:
            handle.write("time,midi\n")
            for time, f0 in data:
                if not np.isfinite(time) or not np.isfinite(f0) or time < 0 or time > duration or f0 <= 0:
                    continue
                midi = 69.0 + 12.0 * np.log2(float(f0) / 440.0)
                handle.write(f"{float(time):.6f},{midi:.6f}\n")
        paths[mode] = str(destination.relative_to(ROOT)).replace("\\", "/")
    return paths


def analysis_variant_path(work: Path, note_mode: str, timing_mode: str) -> Path:
    if note_mode == "game-vocal" and timing_mode == "beat":
        return work / "analysis.json"
    return work / f"analysis-{note_mode}-{timing_mode}.json"


def make_analysis_variant(
    *,
    work: Path,
    song: Path,
    lyrics_path: Path | None,
    lyrics,
    duration: float,
    backing_path: Path,
    tempo_info: dict,
    note_mode: str,
    timing_mode: str,
    notes,
    anchor_units,
    exact_timestamps: bool,
    pitch_paths: dict[str, str | None],
    fusion,
) -> dict:
    import numpy as np

    selected_notes = align_game_notes_to_grid(notes, tempo_info) if timing_mode == "beat" else notes
    timeline = np.arange(0.0, duration + 0.0025, 0.005, dtype=np.float64)
    empty_pitch = np.full(timeline.shape, np.nan, dtype=np.float64)
    if exact_timestamps:
        phrases, units = build_game_first_segmentation(
            lyrics, anchor_units, selected_notes, timeline, empty_pitch,
            preserve_game_timing=True,
        )
    else:
        phrases, units = build_raw_note_segmentation(selected_notes)
    filename = analysis_variant_path(work, note_mode, timing_mode)
    info = song_info(song)
    metadata = {
        "version": VERSION,
        **info,
        "sourceFile": song.name,
        "duration": duration,
        "sampleRate": 44100,
        "phrases": phrases,
        "units": units,
        "tempo": tempo_info,
        "noteMode": note_mode,
        "timingMode": timing_mode,
        "noteModeLabel": NOTE_MODES[note_mode],
        "timingModeLabel": TIMING_MODES[timing_mode],
        "pitchModeDefault": "rmvpe-original",
        "renderMode": "openutau-native",
        "nativeRender": {
            "voicebank": "audio",
            "backing": str(backing_path.relative_to(ROOT)).replace("\\", "/"),
            "analysis": str(filename.relative_to(ROOT)).replace("\\", "/"),
            "pitch": pitch_paths["rmvpe-original"],
            "pitchModes": pitch_mode_metadata(pitch_paths),
            "renderer": "WORLDLINE-R",
            "resampler": "worldline",
            "wavtool": "convergence",
        },
        "method": "independent note mode + timing mode + pitch mode + OpenUtau WORLDLINE-R",
    }
    if lyrics_path is not None:
        metadata["lyrics"] = {
            "source": lyrics_path.name,
            "mode": "selected note events; LDDC character grouping only",
            "lines": len(lyrics),
            "characters": sum(len(line.get("chars") or []) for line in lyrics),
        }
    (filename).write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    return metadata


def analyze_independent() -> None:
    import numpy as np
    import soundfile as sf

    fusion = load_module(ANALYSIS / "run_world_fusion.py", "fusion_independent")
    guide, sr = sf.read(WORK / "demucs/adefossez_htdemucs/source/vocals.wav", always_2d=True)
    duration = len(guide) / sr
    song = selected_song()
    lyrics_path = find_lyrics_file(song)
    lyrics = parse_lrc(lyrics_path) if lyrics_path else None
    exact_timestamps = bool(lyrics) and all(line.get("chars") for line in lyrics)
    anchor_units = (
        fusion.parse_word_timed_lrc(lyrics_path, source_offset=0.0, duration=duration)
        if exact_timestamps else None
    )
    backing_path = WORK / "demucs/adefossez_htdemucs/source/minus_vocals.wav"
    if not backing_path.exists():
        backing_path = backing_path.with_name("no_vocals.wav")
    tempo_info = estimate_tempo_grid(backing_path, duration) if backing_path.exists() else {
        "bpm": 120.0, "beatOffset": 0.0, "beatInterval": 0.5,
        "gridStep": 0.125, "beats": [], "source": "fallback; accompaniment unavailable",
    }
    note_sources = {
        "game-vocal": fusion.read_game_notes(WORK / "game/vocals.csv"),
        "rosvot-vocal": fusion.read_game_notes(WORK / "rosvot/vocal/notes.csv"),
        "rosvot-original": fusion.read_game_notes(WORK / "rosvot/original/notes.csv"),
    }
    pitch_paths = write_absolute_pitch_modes(WORK, duration)
    variants = {}
    for note_mode, notes in note_sources.items():
        for timing_mode in ("beat", "raw"):
            variants[(note_mode, timing_mode)] = make_analysis_variant(
                work=WORK, song=song, lyrics_path=lyrics_path, lyrics=lyrics,
                duration=duration, backing_path=backing_path, tempo_info=tempo_info,
                note_mode=note_mode, timing_mode=timing_mode, notes=notes,
                anchor_units=anchor_units, exact_timestamps=exact_timestamps,
                pitch_paths=pitch_paths, fusion=fusion,
            )
    base = variants[("game-vocal", "beat")]
    note_modes = {}
    for note_mode in NOTE_MODES:
        note_modes[note_mode] = {
            "label": NOTE_MODES[note_mode],
            "timingModes": {
                timing: {
                    "label": TIMING_MODES[timing],
                    "analysis": str(analysis_variant_path(WORK, note_mode, timing).relative_to(ROOT)).replace("\\", "/"),
                }
                for timing in ("beat", "raw")
            },
        }
    base["noteModes"] = note_modes
    base["noteModeDefault"] = "game-vocal"
    base["timingModeDefault"] = "beat"
    base["timingModes"] = {
        "beat": {"label": TIMING_MODES["beat"]},
        "raw": {"label": TIMING_MODES["raw"]},
    }
    (WORK / "analysis.json").write_text(json.dumps(base, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"duration": duration, "variants": len(variants), "notes": {key: len(value) for key, value in note_sources.items()}}, ensure_ascii=False))


def song_id(song: Path) -> str:
    explicit = os.environ.get("HACHIMI_PROJECT_ID")
    if explicit:
        return explicit
    stem = song.stem
    if "天外来物" in stem:
        return "tianwai-la-wu"
    if "琵琶曲" in stem:
        return "pipa-qu"
    slug = re.sub(r"[^a-z0-9]+", "-", stem.lower()).strip("-")
    return slug or hashlib.sha256(song.name.encode("utf-8")).hexdigest()[:12]


def pack_one(
    song: Path,
    work: Path,
    asset_root: Path,
    identifier: str,
    analysis_file: Path | None = None,
    output_name: str = "project.json",
) -> dict:
    import hashlib
    import numpy as np
    import soundfile as sf
    dest = asset_root / "songs" / identifier
    dest.mkdir(parents=True, exist_ok=True)
    analysis_file = analysis_file or (work / "analysis.json")
    meta = json.loads(analysis_file.read_text())
    meta["id"] = identifier
    meta["assetBase"] = f"songs/{identifier}"
    meta["originalFile"] = "song.mp3"
    # Keep existing user arrangements when only the synthesis changes.
    voicebank_files = sorted(path for path in (ROOT / "audio").iterdir() if path.is_file())
    voicebank_bytes = b"".join(path.name.encode() + b"\0" + path.read_bytes() for path in voicebank_files)
    meta["arrangementFingerprint"] = hashlib.sha256(analysis_file.read_bytes() +
        b"".join((ROOT / f"audio/{s}.wav").read_bytes() for s in SOUNDS) +
        song.read_bytes()).hexdigest()[:16]
    meta["fingerprint"] = hashlib.sha256(analysis_file.read_bytes() + voicebank_bytes +
        song.read_bytes()).hexdigest()[:16]
    meta["sampleRate"] = 44100
    backing = work / "demucs/adefossez_htdemucs/source/minus_vocals.wav"
    if not backing.exists():
        backing = backing.with_name("no_vocals.wav")
    pitch_reference = meta.get("nativeRender", {}).get("pitch")
    default_pitch = ROOT / pitch_reference if pitch_reference else work / "pitch-rmvpe-vocal.csv"
    if not default_pitch.exists():
        default_pitch = work / "pitch.csv"
    native_render = {
        **meta.get("nativeRender", {}),
        "voicebank": "audio",
        "backing": str(backing.relative_to(ROOT)).replace("\\", "/"),
        "analysis": str(analysis_file.relative_to(ROOT)).replace("\\", "/"),
        "pitch": str(default_pitch.relative_to(ROOT)).replace("\\", "/"),
        "renderer": "WORLDLINE-R",
        "resampler": "worldline",
        "wavtool": "convergence",
    }
    if meta.get("nativeRender", {}).get("pitchModes"):
        native_render["pitchModes"] = meta["nativeRender"]["pitchModes"]
    meta["nativeRender"] = native_render
    asset_root.mkdir(parents=True, exist_ok=True)
    for sound in SOUNDS:
        shutil.copyfile(ROOT / f"audio/{sound}.wav", asset_root / f"{sound}.wav")
    source, sr = sf.read(work / "source.wav", always_2d=True)
    shutil.copyfile(song, dest / "song.mp3")
    mono = source.mean(axis=1)
    meta["waveform"] = [round(float(np.max(np.abs(c))), 4) for c in np.array_split(mono, 1400)]
    meta["sounds"] = [{"id": s, "label": {"ha": "哈", "ji": "基", "mi": "米", "man": "曼", "bo": "波"}[s]} for s in SOUNDS]
    (dest / output_name).write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("Packed", len(meta["units"]), "units", len(meta["phrases"]), "phrases")
    return meta


def write_catalog(projects: list[dict]) -> None:
    asset_root = ROOT / "website/assets"
    asset_root.mkdir(parents=True, exist_ok=True)
    entries = []
    for meta in projects:
        entries.append({
            "id": meta["id"],
            "title": meta.get("title", meta["id"]),
            "subtitle": meta.get("subtitle", ""),
            "artist": meta.get("artist", ""),
            "project": f"songs/{meta['id']}/project.json",
        })
    default_song = "tianwai-la-wu" if any(item["id"] == "tianwai-la-wu" for item in entries) else entries[0]["id"]
    (asset_root / "catalog.json").write_text(json.dumps({
        "version": VERSION,
        "defaultSong": default_song,
        "songs": entries,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def find_pack_candidates() -> list[tuple[Path, Path, str]]:
    songs = sorted((ROOT / "music").glob("*.mp3"))
    by_name = {song.name: song for song in songs}
    candidates = []
    for work in sorted(PROJECTS_ROOT.glob("*/analysis.json")):
        meta = json.loads(work.read_text())
        source_file = meta.get("sourceFile")
        song = next((candidate for candidate in (
            work.parent / "input" / str(source_file or ""),
            work.parent / str(source_file or ""),
        ) if candidate.is_file()), by_name.get(source_file))
        if song is not None:
            candidates.append((song, work.parent, work.parent.name))
    if not candidates:
        raise ValueError("No analyzed web projects matched the songs in music.")
    return candidates


def pack():
    asset_root = ROOT / "website/assets"
    song = selected_song()
    project = pack_with_note_modes(song, WORK, asset_root, song_id(song))
    write_catalog([project])


def pack_all():
    asset_root = ROOT / "website/assets"
    projects = [pack_with_note_modes(song, work, asset_root, identifier) for song, work, identifier in find_pack_candidates()]
    write_catalog(projects)


def pack_with_note_modes(song: Path, work: Path, asset_root: Path, identifier: str) -> dict:
    project = pack_one(song, work, asset_root, identifier)
    note_modes = {}
    source_note_modes = project.get("noteModes", {})
    expected_outputs = {"project.json"}
    for note_mode, note_config in source_note_modes.items():
        timing_projects = {}
        for timing_mode, timing_config in note_config.get("timingModes", {}).items():
            analysis_file = ROOT / timing_config["analysis"]
            output_name = "project.json" if note_mode == "game-vocal" and timing_mode == "beat" else f"timing-{note_mode}-{timing_mode}.json"
            expected_outputs.add(output_name)
            if not analysis_file.is_file():
                raise FileNotFoundError(f"Missing analysis variant: {analysis_file}")
            if not (note_mode == "game-vocal" and timing_mode == "beat"):
                pack_one(song, work, asset_root, identifier, analysis_file=analysis_file, output_name=output_name)
            timing_projects[timing_mode] = {
                "label": timing_config["label"],
                "project": f"songs/{identifier}/{output_name}",
            }
        note_modes[note_mode] = {"label": note_config["label"], "timingModes": timing_projects}
    project_path = asset_root / "songs" / identifier / "project.json"
    for stale in project_path.parent.glob("timing-*.json"):
        if stale.name not in expected_outputs:
            stale.unlink()
    project = json.loads(project_path.read_text(encoding="utf-8"))
    project["noteModes"] = note_modes
    project["noteModeDefault"] = "game-vocal"
    project["timingModeDefault"] = "beat"
    project_path.write_text(json.dumps(project, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return project


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--analyze", action="store_true")
    parser.add_argument("--pack", action="store_true")
    parser.add_argument("--pack-all", action="store_true")
    args = parser.parse_args()
    if args.analyze:
        analyze_independent()
    elif args.pack:
        pack()
    elif args.pack_all:
        pack_all()
    else:
        prepare()
