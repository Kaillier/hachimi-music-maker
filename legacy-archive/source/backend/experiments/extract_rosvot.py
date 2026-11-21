"""Run the official ROSVOT transcription model on an original song mix."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[2]
ROSVOT_ROOT = ROOT / "backend/runtime/rosvot-source"
EXTRACTOR_VERSION = "rosvot-chunked-v2"
CHUNK_SECONDS = 150.0
OVERLAP_SECONDS = 2.0


def extract(input_path: Path, output_path: Path, python_path: Path) -> None:
    import pretty_midi

    input_path = input_path if input_path.is_absolute() else (ROOT / input_path).resolve()
    output_path = output_path if output_path.is_absolute() else (ROOT / output_path).resolve()
    # Keep the venv symlink intact; resolving it would bypass the venv's site packages.
    python_path = python_path if python_path.is_absolute() else ROOT / python_path
    output_path.parent.mkdir(parents=True, exist_ok=True)
    run_dir = output_path.parent / "inference"
    if run_dir.exists():
        shutil.rmtree(run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)
    audio, sample_rate = sf.read(input_path, dtype="float32", always_2d=True)
    duration = len(audio) / sample_rate
    env = dict(os.environ, PYTHONPATH=str(ROSVOT_ROOT), PYTHONWARNINGS="ignore")

    chunks = []
    start = 0.0
    while start < duration - 1e-6:
        end = min(duration, start + CHUNK_SECONDS)
        chunks.append((start, end))
        if end >= duration:
            break
        start = end - OVERLAP_SECONDS

    generated_inputs = []
    all_notes = []
    for index, (chunk_start, chunk_end) in enumerate(chunks):
        if len(chunks) == 1:
            chunk_input = input_path
        else:
            chunk_input = run_dir / f"chunk-{index:03d}.wav"
            left = round(chunk_start * sample_rate)
            right = round(chunk_end * sample_rate)
            sf.write(chunk_input, audio[left:right], sample_rate, subtype="PCM_16")
            generated_inputs.append(chunk_input)
        chunk_output = run_dir / f"chunk-{index:03d}"
        command = [
            str(python_path), "inference/rosvot.py",
            "-p", str(chunk_input),
            "-o", str(chunk_output),
            "--ds_workers", "0",
            "--no_save_every_npy",
            "--no_save_final_npy",
        ]
        subprocess.run(command, cwd=ROSVOT_ROOT, env=env, check=True)
        midi_path = chunk_output / "midi/output.mid"
        if not midi_path.is_file():
            raise FileNotFoundError(f"ROSVOT did not produce MIDI: {midi_path}")
        midi = pretty_midi.PrettyMIDI(str(midi_path))
        keep_start = chunk_start if index == 0 else chunk_start + OVERLAP_SECONDS / 2
        keep_end = chunk_end if index == len(chunks) - 1 else chunk_end - OVERLAP_SECONDS / 2
        for instrument in midi.instruments:
            for note in instrument.notes:
                onset = chunk_start + float(note.start)
                offset = min(duration, chunk_start + float(note.end))
                if onset < keep_start or onset >= keep_end or offset <= onset:
                    continue
                all_notes.append((onset, offset, float(note.pitch)))

    # The overlap gives the detector context at boundaries. Only merge an
    # accidental duplicate from the two contexts; note events stay otherwise raw.
    all_notes.sort(key=lambda item: (item[0], item[1], item[2]))
    notes = []
    for onset, offset, pitch in all_notes:
        if notes and abs(onset - notes[-1][0]) < 0.08 and abs(pitch - notes[-1][2]) < 0.5:
            notes[-1] = (notes[-1][0], max(notes[-1][1], offset), notes[-1][2])
        else:
            notes.append((onset, offset, pitch))
    for path in generated_inputs:
        path.unlink(missing_ok=True)

    frame_times = np.arange(0.0, duration + 0.0025, 0.005)
    notes_path = output_path.parent / "notes.csv"
    with notes_path.open("w", encoding="utf-8") as handle:
        handle.write("onset,offset,pitch\n")
        for onset, offset, pitch in notes:
            handle.write(f"{onset:.8f},{offset:.8f},{pitch:.6f}\n")
    f0 = np.zeros(frame_times.shape, dtype=np.float64)
    for onset, offset, pitch in notes:
        mask = (frame_times >= onset) & (frame_times < offset)
        f0[mask] = 440.0 * 2.0 ** ((pitch - 69.0) / 12.0)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_suffix(".csv.tmp")
    np.savetxt(temporary, np.column_stack([frame_times, f0]), delimiter=",", fmt="%.8f")
    temporary.replace(output_path)
    report = {
        "extractorVersion": EXTRACTOR_VERSION,
        "source": str(input_path),
        "notes": len(notes),
        "notesCsv": str(notes_path),
        "duration": duration,
        "chunks": len(chunks),
        "output": str(output_path),
    }
    (output_path.parent / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"ROSVOT wrote {len(notes)} notes to {output_path}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--python", type=Path, required=True)
    args = parser.parse_args()
    extract(args.input, args.output, args.python)


if __name__ == "__main__":
    main()
