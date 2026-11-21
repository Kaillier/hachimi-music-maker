"""Extract unmodified F0 with the official bundled torchfcpe model."""
from __future__ import annotations

import argparse
import math
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly


TARGET_RATE = 16_000
HOP_SIZE = 160
CHUNK_SECONDS = 30.0
OVERLAP_SECONDS = 1.0


def load_fcpe_model(device: str):
    from torchfcpe import spawn_bundled_infer_model

    return spawn_bundled_infer_model(device=device)


def extract(input_path: Path, output_path: Path, device: str, max_seconds: float = 0.0) -> None:
    import torch

    audio, sample_rate = sf.read(input_path, dtype="float32", always_2d=True)
    mono = np.mean(audio, axis=1, dtype=np.float32)
    if max_seconds > 0:
        mono = mono[: round(max_seconds * sample_rate)]
    if sample_rate != TARGET_RATE:
        divisor = math.gcd(sample_rate, TARGET_RATE)
        mono = resample_poly(
            mono,
            TARGET_RATE // divisor,
            sample_rate // divisor,
        ).astype(np.float32, copy=False)
    if len(mono) < HOP_SIZE:
        raise ValueError(f"FCPE 输入过短：{input_path}")

    model = load_fcpe_model(device)
    if model.get_model_sr() != TARGET_RATE or model.get_hop_size() != HOP_SIZE:
        raise ValueError("Unexpected bundled FCPE sample rate or hop size")
    chunk_size = round(CHUNK_SECONDS * TARGET_RATE)
    overlap = round(OVERLAP_SECONDS * TARGET_RATE)
    frame_chunks = []
    with torch.inference_mode():
        for main_start in range(0, len(mono), chunk_size - 2 * overlap):
            main_end = min(len(mono), main_start + chunk_size - 2 * overlap)
            chunk_start = max(0, main_start - overlap)
            chunk_end = min(len(mono), main_end + overlap)
            chunk = torch.from_numpy(mono[chunk_start:chunk_end]).to(device)
            f0 = model.infer(
                chunk.unsqueeze(0).unsqueeze(-1),
                sr=TARGET_RATE,
                decoder_mode="local_argmax",
                threshold=0.006,
                interp_uv=False,
            )
            values = f0.detach().float().cpu().numpy().reshape(-1)
            # Integer frame indices avoid duplicate/missing frames at chunk seams.
            first = (main_start - chunk_start) // HOP_SIZE
            count = math.ceil((main_end - main_start) / HOP_SIZE)
            values = values[first:first + count]
            if len(values) != count:
                raise ValueError("FCPE returned fewer frames than the input duration")
            times = (main_start // HOP_SIZE + np.arange(count)) * HOP_SIZE / TARGET_RATE
            frame_chunks.append(np.column_stack([times, values]))
            if main_end >= len(mono):
                break

    frames = np.concatenate(frame_chunks, axis=0)
    if not np.all(np.isfinite(frames)) or np.any(frames[:, 1] < 0):
        raise ValueError("FCPE returned invalid F0 values")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_suffix(".csv.tmp")
    np.savetxt(temporary, frames, delimiter=",", fmt="%.8f")
    temporary.replace(output_path)
    print(f"FCPE wrote {len(frames)} frames to {output_path}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--max-seconds", type=float, default=0.0)
    args = parser.parse_args()
    extract(args.input, args.output, args.device, args.max_seconds)


if __name__ == "__main__":
    main()
