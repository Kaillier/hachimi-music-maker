"""Export MuScriptor's detected instrument tracks from local audio."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory


ROOT = Path(__file__).resolve().parents[2]
DEPENDENCIES = ROOT / "backend/runtime/muscriptor-windows/deps"


def event(message: str) -> None:
    print("HACHIMI_EVENT " + json.dumps({"message": message}), flush=True)


def load_runtime():
    sys.path.insert(0, str(DEPENDENCIES))
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    try:
        import torch
        from muscriptor import TranscriptionModel
        from muscriptor.events import ProgressEvent
        from muscriptor.utils.midi import ExportOptions
    except ImportError as error:
        raise RuntimeError(f"请先运行 setup_muscriptor.bat 安装纯音乐转录环境（{error}）") from error
    return torch, TranscriptionModel, ProgressEvent, ExportOptions


def decode_audio(audio: Path, wav: Path) -> None:
    bundled = ROOT / "Vocal2Midi/ffmpeg.exe"
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg and sys.platform == "win32" and bundled.is_file():
        ffmpeg = str(bundled)
    if not ffmpeg:
        raise RuntimeError("本机缺少 FFmpeg，无法解码纯音乐")
    result = subprocess.run(
        [ffmpeg, "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", str(audio),
         "-vn", "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", str(wav)],
    )
    if result.returncode:
        raise RuntimeError("无法解码纯音乐，请检查音频格式或查看任务日志")


def transcribe(audio: Path, output: Path, weights: Path, keep_decoded_audio: bool = False) -> None:
    if weights.suffix.lower() != ".safetensors" or not weights.is_file() or not weights.with_name("config.json").is_file():
        raise RuntimeError("纯音乐转录需要本地 .safetensors 权重和同目录的 config.json，请运行 setup_muscriptor.bat 查看配置方法")

    torch, model_type, progress_type, export_options = load_runtime()
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    dtype = torch.float16 if device.type == "cuda" else torch.float32
    print(f"MuScriptor runtime: {sys.executable} ({device})", flush=True)
    output.mkdir(parents=True, exist_ok=True)

    with TemporaryDirectory(prefix="transcribe-", dir=output) as temporary:
        temporary_dir = Path(temporary)
        wav = temporary_dir / "input.wav"
        event("正在解码纯音乐…")
        decode_audio(audio, wav)
        event("正在加载 MuScriptor 模型…")
        model = model_type.load_model(weights, device=device, dtype=dtype)
        event("正在识别乐器音轨…")
        events = []
        for entry in model.transcribe(wav):
            if isinstance(entry, progress_type):
                event(f"正在识别乐器音轨（{entry.completed}/{entry.total}）…")
            else:
                events.append(entry)

        # Keep the decoder's note timings and instrument labels in the source MIDI.
        midi_file = temporary_dir / "multitrack.mid"
        midi_file.write_bytes(model.events_to_midi_bytes(iter(events), export=export_options()))
        midi_file.replace(output / "multitrack.mid")
        if keep_decoded_audio:
            wav.replace(output / "original.wav")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--model", type=Path,
                        default=Path(os.environ.get("HACHIMI_MUSCRIPTOR_MODEL") or ROOT / "model.safetensors"))
    parser.add_argument("--keep-decoded-audio", action="store_true")
    args = parser.parse_args()
    transcribe(args.input.resolve(), args.output_dir.resolve(), args.model.resolve(), args.keep_decoded_audio)


if __name__ == "__main__":
    main()
