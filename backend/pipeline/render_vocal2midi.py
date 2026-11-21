"""Render a Vocal2Midi USTX with the original and selected local samples."""
from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
from uuid import uuid4

import soundfile as sf
import yaml


ROOT = Path(__file__).resolve().parents[2]
CATALOGUE = json.loads((ROOT / "website/sound-packs.json").read_text(encoding="utf-8"))
SOUND_IDS = frozenset(CATALOGUE["labels"])
PACKS = {pack["id"]: tuple(pack["pattern"]) for pack in CATALOGUE["packs"]}
PATTERN = PACKS[CATALOGUE["defaultPack"]]
EXTRA_BANK = ROOT / "voicebanks/selected"


def validate_score(score: dict) -> None:
    if not isinstance(score, dict) or not score.get("voice_parts"):
        raise ValueError("USTX 中没有可用的歌声音符轨道")
    if score.get("wave_parts"):
        raise ValueError("请上传仅包含歌声轨道的 USTX，伴奏请在网页中单独选择")
    try:
        version = tuple(int(value) for value in str(score["ustx_version"]).split("."))
    except (KeyError, ValueError):
        raise ValueError("USTX 格式或版本信息无效") from None
    if version > (0, 7):
        raise ValueError("当前本机渲染器支持 USTX 0.7，请使用 Vocal2Midi 原始导出工程，不要用新版编辑器另存为 0.9")
    parts = score["voice_parts"]
    if len({part.get("track_no", 0) for part in parts}) != 1:
        raise ValueError("请只保留一个需要替换的歌声音轨")
    notes = [note for part in parts for note in part.get("notes", [])]
    if not notes or len(notes) > 30000:
        raise ValueError("USTX 音符为空或数量超过本机处理限制")
    for note in notes:
        for key in ("position", "duration", "tone"):
            if not isinstance(note.get(key), int):
                raise ValueError("USTX 音符包含无效的位置、时长或音高")
        if note["position"] < 0 or note["duration"] <= 0 or not 0 <= note["tone"] <= 127:
            raise ValueError("USTX 音符的位置、时长或音高越界")
    if not score.get("tempos") or any(
        not isinstance(tempo.get("bpm"), (int, float)) or not math.isfinite(tempo["bpm"]) or not 0 < tempo["bpm"] <= 400
        for tempo in score["tempos"]
    ):
        raise ValueError("USTX 速度信息无效")


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def score_content(score: dict) -> dict:
    """Only the lyrics and singer/renderer binding may change in this workflow."""
    return {
        "resolution": score["resolution"],
        "tempos": score["tempos"],
        "time_signatures": score["time_signatures"],
        "parts": [
            {
                "position": part["position"],
                "notes": [
                    {key: note[key] for key in ("position", "duration", "tone")}
                    for note in part["notes"]
                ],
                "curves": part.get("curves", []),
            }
            for part in score["voice_parts"]
        ],
    }


def replacement_plan(source: dict, sequence=PATTERN, *, repeat=True):
    if not sequence or any(alias not in SOUND_IDS for alias in sequence):
        raise ValueError("音效序列包含未知音效")
    expected_parts = [[None] * len(part["notes"]) for part in source["voice_parts"]]
    syllables = 0
    sustains = 0
    current_alias = None
    restarts = []
    for part_index, source_part in sorted(enumerate(source["voice_parts"]), key=lambda item: item[1]["position"]):
        previous = None
        for note_index, before in sorted(enumerate(source_part["notes"]), key=lambda item: item[1]["position"]):
            original = before.get("lyric", "")
            if original.startswith("+") or original == "-":
                if current_alias is None:
                    raise ValueError("延音之前没有可继续的发音单位，无法确定音效；未修改原工程")
                previous_end = previous["position"] + previous["duration"] if previous else None
                if previous_end is not None and previous_end > before["position"]:
                    raise ValueError("延音与前音符重叠；请检查原工程，程序不会自动修改时间")
                if previous_end is None or previous_end < before["position"]:
                    expected = current_alias
                    restarts.append({
                        "partIndex": part_index, "noteIndex": note_index,
                        "position": source_part["position"] + before["position"],
                        "gapTicks": before["position"] - previous_end if previous_end is not None else None,
                        "alias": current_alias,
                    })
                else:
                    expected = "+" if original == "-" else original
                sustains += 1
            else:
                if not repeat and syllables >= len(sequence):
                    raise ValueError("音效序列数量不足")
                expected = sequence[syllables % len(sequence)]
                current_alias = expected
                syllables += 1
            expected_parts[part_index][note_index] = expected
            previous = before
    if not repeat and syllables != len(sequence):
        raise ValueError("音效序列与 USTX 发音单位数量不一致")
    return expected_parts, syllables, sustains, restarts


def validate_replacement(source: dict, rendered: dict, sequence=PATTERN, *, repeat=True) -> tuple[int, int]:
    if score_content(source) != score_content(rendered):
        raise ValueError("The rendered project changed source notes, timing, tempo or pitch curves")
    expected_parts, syllables, sustains, _restarts = replacement_plan(source, sequence, repeat=repeat)
    for expected_notes, rendered_part in zip(expected_parts, rendered["voice_parts"]):
        for expected, after in zip(expected_notes, rendered_part["notes"]):
            if after["lyric"] != expected:
                raise ValueError(f"Unexpected replacement at tick {after['position']}: {after['lyric']}")
    return syllables, sustains


def additional_sample_files(sequence):
    aliases = set(sequence) - set(PATTERN)
    if not aliases:
        return {}, []
    oto = EXTRA_BANK / "oto.ini"
    entries = {row.partition("=")[0]: row for row in oto.read_text(encoding="ascii").splitlines() if "=" in row}
    selected = {}
    rows = []
    for alias in sorted(aliases):
        wav = EXTRA_BANK / f"{alias}.wav"
        frq = EXTRA_BANK / f"{alias}_wav.frq"
        if wav.name not in entries or not wav.is_file() or not frq.is_file():
            raise ValueError(f"本地声库缺少音效或配套文件：{alias}")
        rows.append(entries[wav.name])
        selected[wav] = digest(wav)
        selected[frq] = digest(frq)
    selected[oto] = digest(oto)
    return selected, rows


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--backing", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--preview-start", type=float, default=0.0)
    parser.add_argument("--preview-duration", type=float, default=30.0)
    parser.add_argument("--mix-gain", type=float, default=1.0)
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument("--sequence-file", type=Path)
    selection.add_argument("--sound-pack", choices=PACKS, default=CATALOGUE["defaultPack"])
    parser.add_argument("--backing-gain", type=float)
    parser.add_argument("--sound-gain", type=float)
    parser.add_argument("--keep-original", type=Path)
    parser.add_argument("--original", type=Path)
    args = parser.parse_args()
    source = args.source.resolve()
    backing = args.backing.resolve()
    info = sf.info(backing)
    if info.samplerate != 44100 or info.channels not in (1, 2):
        raise ValueError("The accompaniment must be 44.1 kHz mono or stereo")
    if not 0 <= args.preview_start < info.duration or args.preview_duration <= 0:
        raise ValueError("Invalid preview range")
    if not 0 < args.mix_gain <= 1.5:
        raise ValueError("Mix gain must be between zero and 1.5")
    original = yaml.safe_load(source.read_text(encoding="utf-8-sig"))
    validate_score(original)
    sequence = json.loads(args.sequence_file.read_text(encoding="utf-8")) if args.sequence_file else PACKS[args.sound_pack]
    repeat = args.sequence_file is None
    _expected, _syllables, _sustains, sustain_restarts = replacement_plan(original, sequence, repeat=repeat)
    keep = None
    if args.keep_original or args.original:
        if not args.keep_original or not args.original or repeat:
            raise ValueError("Keeping original audio requires an exact sequence and an original track")
        keep = json.loads(args.keep_original.read_text(encoding="utf-8"))
        audio_info = sf.info(args.original)
        if audio_info.samplerate != info.samplerate or audio_info.channels not in (1, 2) or audio_info.frames != info.frames:
            raise ValueError("Original audio and accompaniment must share the same timeline")
    voicebank = ROOT / "audio"
    originals = {path: digest(path) for path in voicebank.iterdir() if path.is_file()}
    extra_files, extra_oto = additional_sample_files(sequence)
    originals.update(extra_files)
    originals[source] = digest(source)
    originals[backing] = digest(backing)
    if keep:
        originals[args.original] = digest(args.original)
    output_dir = args.output_dir or source.parent / ("hachimi-manbo-" + datetime.now().strftime("%Y%m%d-%H%M%S"))
    output_dir = output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=False)
    job_dir = ROOT / "backend/runtime/web-server/native-jobs" / str(uuid4())
    job_dir.mkdir(parents=True)
    # Native render caches must never alter the user's original voicebank.
    task_voicebank = job_dir / "voicebank"
    shutil.copytree(voicebank, task_voicebank)
    if extra_oto:
        selected = task_voicebank / "selected"
        selected.mkdir()
        for path in extra_files:
            if path.suffix != ".ini":
                shutil.copyfile(path, selected / path.name)
        (selected / "oto.ini").write_text("\n".join(extra_oto) + "\n", encoding="ascii")
    stem = ("hachimi-manbo" if set(sequence) <= set(PATTERN)
            else args.sound_pack if repeat else "arrangement")
    output = output_dir / f"{stem}.wav"
    ustx = output_dir / f"{stem}.ustx"
    request = {
        "sourceUstx": str(source),
        "voicebank": str(task_voicebank),
        "backing": str(backing),
        "output": str(output),
        "ustx": str(ustx),
        "sequence": list(sequence),
        "sequenceMode": "pattern" if repeat else "units",
        "rangeStart": 0,
        "rangeEnd": info.duration,
        "backingGain": args.backing_gain if args.backing_gain is not None else args.mix_gain,
        "soundGain": args.sound_gain if args.sound_gain is not None else args.mix_gain,
    }
    if keep:
        request.update(originalAudio=str(args.original.resolve()), mutedUnits=keep["units"], originalRanges=keep["ranges"])
    request_path = job_dir / "request.json"
    request_path.write_text(json.dumps(request, indent=2), encoding="utf-8")
    executable = ROOT / "backend/runtime/openutau-native/bin/Release/net8.0/Hachimi.OpenUtau.Native.exe"
    worker_log = job_dir / "worker.log"
    try:
        with worker_log.open("w", encoding="utf-8") as log:
            subprocess.run([str(executable), "--request", str(request_path)], cwd=executable.parent,
                           stdout=log, stderr=subprocess.STDOUT, check=True)
    except subprocess.CalledProcessError:
        raise RuntimeError("OpenUtau 渲染失败：" + worker_log.read_text(encoding="utf-8", errors="replace")[-1800:]) from None
    rendered = yaml.safe_load(ustx.read_text(encoding="utf-8-sig"))
    syllables, sustains = validate_replacement(original, rendered, sequence, repeat=repeat)
    if keep:
        native = json.loads(Path(str(output) + ".json").read_text(encoding="utf-8"))
        if native["mutedUnits"] != keep["units"] or native["originalRanges"] != keep["ranges"]:
            raise ValueError("OpenUtau did not apply the requested original-audio selection")
    snap_adjustments = sum(
        before.get("pitch") != after.get("pitch")
        for source_part, rendered_part in zip(original["voice_parts"], rendered["voice_parts"])
        for before, after in zip(source_part["notes"], rendered_part["notes"])
    )
    if any(digest(path) != expected for path, expected in originals.items()):
        raise ValueError("A source file was unexpectedly modified")
    preview = output_dir / "preview.wav"
    with sf.SoundFile(output) as handle:
        handle.seek(round(args.preview_start * handle.samplerate))
        audio = handle.read(round(args.preview_duration * handle.samplerate), dtype="float32", always_2d=True)
        sf.write(preview, audio, handle.samplerate, subtype="PCM_16")
    report = {
        "source": str(source),
        "sourceSha256": originals[source],
        "backing": str(backing),
        "sequence": list(sequence),
        "sequenceMode": request["sequenceMode"],
        "syllables": syllables,
        "sustainNotes": sustains,
        "restartedSustainNotes": len(sustain_restarts),
        "sustainRestarts": sustain_restarts,
        "notesTimingTempoAndPitchCurvesPreserved": True,
        "nativeOpenUtauSnapFirstAdjustments": snap_adjustments,
        "commonMixGain": args.mix_gain,
        "sourceFilesUnchanged": True,
        "duration": sf.info(output).duration,
        "mix": str(output),
        "vocal": str(output) + ".vocal.wav",
        "project": str(ustx),
        "preview": str(preview),
        "previewStart": args.preview_start,
        "request": str(request_path),
    }
    if keep:
        report["keepOriginal"] = keep
    (output_dir / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
