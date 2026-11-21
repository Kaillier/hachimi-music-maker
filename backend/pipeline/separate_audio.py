"""Separate a local upload with the existing cached Demucs model only."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import soundfile as sf


ROOT = Path(__file__).resolve().parents[2]
STEMS = Path("demucs/adefossez_htdemucs/source")
DEFAULT_MODEL_CACHE = ROOT / "backend/runtime/demucs/huggingface"


def event(message: str) -> None:
    print("HACHIMI_EVENT " + json.dumps({"message": message}, ensure_ascii=True), flush=True)


def file_hash(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def find_cached_stems(signature: str, work: Path):
    for marker in sorted((ROOT / "projects").glob("*/source-sha256.txt")):
        if marker.parent.resolve() == work.resolve() or marker.read_text().strip() != signature:
            continue
        directory = marker.parent / STEMS
        vocals = directory / "vocals.wav"
        backing = directory / "minus_vocals.wav"
        if not backing.exists():
            backing = directory / "no_vocals.wav"
        if vocals.is_file() and backing.is_file():
            infos = [sf.info(path) for path in (vocals, backing)]
            if all(info.samplerate == 44100 and info.channels in (1, 2) for info in infos):
                return vocals, backing
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--result", type=Path, required=True)
    args = parser.parse_args()
    work = args.work.resolve()
    signature = file_hash(args.input)
    target = work / STEMS
    target.mkdir(parents=True, exist_ok=True)
    event("正在解码歌曲…")
    ffmpeg = shutil.which("ffmpeg")
    windows_ffmpeg = ROOT / "Vocal2Midi/ffmpeg.exe"
    if not ffmpeg and sys.platform == "win32" and windows_ffmpeg.is_file():
        ffmpeg = str(windows_ffmpeg)
    if not ffmpeg:
        raise RuntimeError("本机缺少 FFmpeg，无法解码歌曲")
    source = work / "source.wav"
    subprocess.run([ffmpeg, "-nostdin", "-v", "error", "-i", str(args.input.resolve()),
                    "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", str(source)], check=True)
    cached = find_cached_stems(signature, work)
    if cached:
        event("正在复用本机已完成的同一歌曲分轨…")
        shutil.copyfile(cached[0], target / "vocals.wav")
        shutil.copyfile(cached[1], target / "minus_vocals.wav")
    else:
        import torch

        device = "cuda" if torch.cuda.is_available() else "cpu"
        model_cache = Path(os.environ.get("HACHIMI_DEMUCS_CACHE") or DEFAULT_MODEL_CACHE).resolve()
        print(f"Demucs runtime: {sys.executable} ({device})", flush=True)
        event("Demucs 正在分离人声和伴奏…")
        env = dict(os.environ, HF_HOME=str(model_cache), HF_HUB_CACHE=str(model_cache / "hub"), HF_HUB_OFFLINE="1",
                   PYTHONDONTWRITEBYTECODE="1", PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
        completed = subprocess.run([sys.executable, "-m", "demucs.separate", "-n", "hf://adefossez/htdemucs",
                                    "--two-stems", "vocals", "--other-method", "minus", "--device", device,
                                    "--segment", "6", "--shifts", "0", "--overlap", "0.25", "--int24",
                                    "--out", str(work / "demucs"), str(source)], env=env)
        if completed.returncode:
            raise SystemExit(completed.returncode)
    vocals = target / "vocals.wav"
    backing = target / "minus_vocals.wav"
    info = sf.info(vocals)
    if info.frames == 0 or not backing.is_file():
        raise RuntimeError("分轨结果缺失或为空")
    (work / "source-sha256.txt").write_text(signature, encoding="utf-8")
    result = {
        "duration": info.duration,
        "cached": cached is not None,
        "vocals": vocals.relative_to(ROOT).as_posix(),
        "backing": backing.relative_to(ROOT).as_posix(),
        "original": source.relative_to(ROOT).as_posix(),
    }
    args.result.write_text(json.dumps(result, indent=2), encoding="utf-8")
    event("人声和伴奏已分离完成")


if __name__ == "__main__":
    main()
