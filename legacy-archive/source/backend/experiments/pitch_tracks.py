"""Convert model F0 output to OpenUtau pitch data, without pitch correction."""
from pathlib import Path

import numpy as np


def build_pitch_track(notes, f0_path: Path, *, duration: float):
    data = np.loadtxt(f0_path, delimiter=",", ndmin=2)
    if data.shape[1] != 2 or not len(data) or not np.all(np.isfinite(data)):
        raise ValueError(f"Invalid time/F0 CSV: {f0_path}")
    source_times, f0 = data.T
    if np.any(np.diff(source_times) <= 0) or source_times[0] < 0 or np.any(f0 < 0):
        raise ValueError(f"Invalid timestamps or F0: {f0_path}")
    source_pitch = np.full(f0.shape, np.nan)
    voiced = f0 > 0
    source_pitch[voiced] = 69.0 + 12.0 * np.log2(f0[voiced] / 440.0)
    times = np.arange(0.0, duration + 0.0025, 0.005)
    pitch = np.full(times.shape, np.nan)
    anchors = np.full(times.shape, np.nan)
    for note in notes:
        mask = (times >= note.onset_seconds) & (times < note.offset_seconds)
        anchors[mask] = round(note.pitch)
        local = voiced & (source_times >= note.onset_seconds) & (source_times <= note.offset_seconds)
        if np.any(local):
            # F0=0 is undefined pitch, not MIDI zero. Retain the existing
            # linear interpolation/edge hold only to represent gaps in USTX.
            pitch[mask] = np.interp(times[mask], source_times[local], source_pitch[local])
    return times, pitch, anchors
