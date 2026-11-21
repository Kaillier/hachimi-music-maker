"""Index Vocal2Midi's USTX for the browser, without changing or detecting notes."""
from __future__ import annotations

import argparse
from bisect import bisect_right
from itertools import groupby
from difflib import SequenceMatcher
import hashlib
import json
from pathlib import Path
import re
import sys

import mido
import numpy as np
import soundfile as sf
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
from render_vocal2midi import CATALOGUE, validate_score
from lyric_reference import normalized

ROOT = Path(__file__).resolve().parents[2]
PIPELINE = "vocal2midi-ustx-v1"
PAGE_SIZE = 12
ASR_BREAK = re.compile(r"[，。！？；、,!?;…]+|\.(?=\s|$)")


class ScoreTimeline:
    def __init__(self, score):
        self.resolution = score["resolution"]
        events = {item["position"]: item["bpm"] for item in score["tempos"]}
        events.setdefault(0, score.get("bpm", 120))
        self.ticks = sorted(events)
        self.bpms = [events[tick] for tick in self.ticks]
        self.seconds = [0.0]
        for index in range(1, len(self.ticks)):
            self.seconds.append(self.seconds[-1] + mido.tick2second(
                self.ticks[index] - self.ticks[index - 1], self.resolution,
                60_000_000 / self.bpms[index - 1],
            ))

    def time(self, tick):
        index = max(0, bisect_right(self.ticks, tick) - 1)
        return self.seconds[index] + mido.tick2second(tick - self.ticks[index], self.resolution, 60_000_000 / self.bpms[index])


def lyric_cuts(units, lines):
    words = [normalized(unit["text"]) for unit in units]
    rows = [row for line in lines if (row := normalized(line))]
    score_text, reference_text = "".join(words), "".join(rows)
    if not score_text or not reference_text:
        return None
    owner = [i for i, word in enumerate(words) for _ in word]
    matcher = SequenceMatcher(None, reference_text, score_text, autojunk=False)
    matched = {block.a + i: block.b + i for block in matcher.get_matching_blocks() for i in range(block.size)}
    if len(matched) / max(len(reference_text), len(score_text)) < 0.8:
        return None
    cuts = []
    offset = 0
    for row, next_row in zip(rows, rows[1:]):
        offset += len(row)
        left = next((matched[i] for i in range(offset - 1, offset - min(3, len(row)) - 1, -1) if i in matched), None)
        right = next((matched[i] for i in range(offset, offset + min(3, len(next_row))) if i in matched), None)
        if left is None or right is None:
            continue
        extra = score_text[left + 1:right]
        if owner[right - 1] + 1 == owner[right] and (not extra or row.endswith(extra)):
            cuts.append(owner[right])
    # A missing character at one boundary must not discard the rest of a reliable match.
    cuts = sorted(set(cuts))
    return cuts if len(cuts) * 3 >= (len(rows) - 1) * 2 else None


def editor_groups(units, reference_lines, asr_lines):
    for source, lines in (("reference", reference_lines), ("asr", asr_lines)):
        cuts = lyric_cuts(units, lines)
        if cuts is not None:
            return [0, *cuts, len(units)], source
    return [*range(0, len(units), PAGE_SIZE), len(units)], "pages"


def read_asr_lines(path):
    if not path or not path.is_file():
        return []
    marker = "ASR Output: "
    return [chunk for line in path.read_text(encoding="utf-8-sig").splitlines() if line.startswith(marker)
            for chunk in ASR_BREAK.split(line[len(marker):]) if normalized(chunk)]


def read_asr_chunks(path):
    if not path or not path.is_file():
        return []
    chunks = re.split(r"(?m)^\[chunk_\d+\]\s*$", path.read_text(encoding="utf-8-sig"))
    return [dict(line.split(": ", 1) for line in chunk.splitlines() if ": " in line)
            for chunk in chunks[1:]]


def likely_dialogue(words, lines, chunks):
    """Locate strongly corroborated dialogue for the editor using native logs."""
    references = [key for line in lines if (key := normalized(line))]
    if not references or not chunks:
        return {}
    windows = references + [left + right for left, right in zip(references, references[1:])]
    assigned = [normalized(chunk.get("Final Assigned Lyrics", "")) for chunk in chunks]
    chunk_owner = [i for i, word in enumerate(assigned) for _ in word]
    unit_owner = [i for i, word in enumerate(words) for _ in word]
    positions = [[] for _ in chunks]
    matcher = SequenceMatcher(None, "".join(assigned), "".join(words), autojunk=False)
    for left, right, size in matcher.get_matching_blocks():
        for i in range(size):
            positions[chunk_owner[left + i]].append(unit_owner[right + i])

    candidates = []
    for labels, indices, chunk in zip(assigned, positions, chunks):
        raw = chunk.get("ASR Output", "")
        spoken = normalized(raw)
        candidate = None
        if len(spoken) >= 8 and indices and len(indices) == len(labels):
            start, end = indices[0], indices[-1] + 1
            # Never exclude a unit only partially accounted for by the log.
            if "".join(words[start:end]) == labels and all(words[start:end]):
                support = max(sum(block.size for block in SequenceMatcher(None, spoken, line, autojunk=False)
                                  .get_matching_blocks()) / len(spoken) for line in windows)
                if support <= .30:
                    fallback = chunk.get("Match Status", "").startswith("Fallback to ASR")
                    candidate = start, end, raw, fallback
        candidates.append(candidate)

    regions = {}
    run = []

    def save_run():
        if len(run) >= 2 and any(item[3] for item in run):
            start, end = run[0][0], run[-1][1]
            regions[(start, end)] = {"text": "疑似对白 · " + " ".join(item[2] for item in run), "defaultExcluded": True}

    for item in [*candidates, None]:
        if not item or (run and run[-1][1] != item[0]):
            save_run()
            run = []
        if item:
            run.append(item)
    return regions


def index_pages(units, reference_lines, asr_lines, asr_chunks):
    words = [normalized(unit["text"]) for unit in units]
    regions = likely_dialogue(words, reference_lines, asr_chunks)
    # Vocal2Midi writes literal 'a' when a pitch-only span has no lyric. Leave
    # those units editable, but don't display their labels as recognized lyrics.
    if any(re.search(r"[\u3400-\u9fff]", word) for word in words):
        for is_placeholder, positions in groupby(range(len(words)), key=lambda i: words[i] == "a"):
            span = list(positions)
            if is_placeholder and len(span) >= 4:
                for offset in range(0, len(span), PAGE_SIZE):
                    start = span[offset]
                    regions[(start, min(start + PAGE_SIZE, span[-1] + 1))] = {
                        "text": "歌词未对齐", "lyricsUnaligned": True,
                    }

    excluded = {i for start, end in regions for i in range(start, end)}
    visible = [i for i in range(len(units)) if i not in excluded]
    cuts, grouping = editor_groups([units[i] for i in visible], reference_lines, asr_lines)
    bounds = {0, len(units), *(visible[i] for i in cuts[1:-1]), *(edge for region in regions for edge in region)}
    for start, end in regions:
        bounds.difference_update(range(start + 1, end))
    ordered = sorted(bounds)
    for start, end in zip(ordered, ordered[1:]):
        if (start, end) in regions:
            continue
        while end - start > PAGE_SIZE * 2:
            choices = range(start + PAGE_SIZE // 2, min(start + PAGE_SIZE * 2, end - PAGE_SIZE // 2) + 1)
            cut = max(choices, key=lambda i: (units[i]["start"] - units[i - 1]["end"], -abs(i - start - PAGE_SIZE)))
            start = cut if units[cut]["start"] - units[cut - 1]["end"] >= .35 else start + PAGE_SIZE
            bounds.add(start)
    return make_pages(units, sorted(bounds), regions), grouping


def read_score_units(score):
    validate_score(score)
    timeline = ScoreTimeline(score)
    units = []
    current = None
    for part_index, part in sorted(enumerate(score["voice_parts"]), key=lambda item: item[1]["position"]):
        for note_index, note in sorted(enumerate(part["notes"]), key=lambda item: item[1]["position"]):
            lyric = note.get("lyric", "")
            if not (lyric.startswith("+") or lyric == "-"):
                current = {"id": len(units), "text": lyric, "notes": []}
                units.append(current)
            if current is None:
                raise ValueError("USTX 的第一个音符是孤立延音，无法归属")
            start_tick = part["position"] + note["position"]
            current["notes"].append({
                "partIndex": part_index, "noteIndex": note_index,
                "start": timeline.time(start_tick), "end": timeline.time(start_tick + note["duration"]),
                "midi": note["tone"],
            })
    for unit in units:
        unit["start"] = unit["notes"][0]["start"]
        unit["end"] = max(note["end"] for note in unit["notes"])
    return units


def make_pages(units, cuts, regions=None):
    pages = []
    for start, end in zip(cuts, cuts[1:]):
        group = units[start:end]
        pages.append({"id": len(pages), "start": group[0]["start"], "end": max(unit["end"] for unit in group),
                      "units": [unit["id"] for unit in group], "text": " ".join(unit["text"] for unit in group),
                      **(regions or {}).get((start, end), {})})
    return pages


def score_units(score):
    units = read_score_units(score)
    cuts, _ = editor_groups(units, (), ())
    pages = make_pages(units, cuts)
    return units, pages


def build_index(*, identifier, title, song, original, vocals, backing, score_path, reference_lines=(), asr_lines=(),
                asr_chunks=()):
    raw = score_path.read_bytes()
    score = yaml.safe_load(raw.decode("utf-8-sig"))
    units = read_score_units(score)
    pages, grouping = index_pages(units, reference_lines, asr_lines, asr_chunks)
    info = sf.info(backing)
    audio, rate = sf.read(original, dtype="float32", always_2d=True)
    if rate != 44100 or info.samplerate != 44100:
        raise ValueError("工程音频必须统一为 44.1 kHz")
    mono = audio.mean(axis=1)
    waveform = [round(float(np.max(np.abs(chunk))), 4) if len(chunk) else 0 for chunk in np.array_split(mono, 1400)]
    score_hash = hashlib.sha256(raw).hexdigest()
    input_hash = hashlib.sha256(song.read_bytes()).hexdigest()
    fingerprint = hashlib.sha256((PIPELINE + score_hash + input_hash + json.dumps(pages)).encode()).hexdigest()[:24]
    paths = {key: str(path.resolve().relative_to(ROOT)).replace("\\", "/") for key, path in {
        "input": song, "original": original, "vocals": vocals, "backing": backing, "score": score_path,
    }.items()}
    return {"id": identifier, "title": title, "artist": "", "subtitle": "", "pipeline": PIPELINE,
            "renderMode": "openutau-ustx", "ready": False, "fingerprint": fingerprint,
            "scoreSha256": score_hash, "sourceSha256": input_hash, "files": paths,
            "sampleRate": 44100, "duration": info.duration, "waveform": waveform,
            "units": units, "phrases": pages, "editorGrouping": grouping,
            "sourceNoteCount": sum(len(part["notes"]) for part in score["voice_parts"]),
            "originalFile": f"/api/projects/{identifier}/files/original",
            "scoreFile": f"/api/projects/{identifier}/files/score",
            "sounds": [{"id": key} for key in CATALOGUE["labels"]]}


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ("song", "original", "vocals", "backing", "score", "output"):
        parser.add_argument("--" + key, type=Path, required=True)
    parser.add_argument("--id", required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument("--lyrics-file", type=Path)
    parser.add_argument("--asr-log", type=Path)
    args = parser.parse_args()
    data = build_index(identifier=args.id, title=args.title, song=args.song, original=args.original,
                       vocals=args.vocals, backing=args.backing, score_path=args.score,
                       reference_lines=args.lyrics_file.read_text(encoding="utf-8").splitlines() if args.lyrics_file else (),
                       asr_lines=read_asr_lines(args.asr_log), asr_chunks=read_asr_chunks(args.asr_log))
    args.output.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"indexedUnits": len(data["units"]), "editorGrouping": data["editorGrouping"],
                      "scoreSha256": data["scoreSha256"]}), flush=True)


if __name__ == "__main__":
    main()
