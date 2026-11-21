from __future__ import annotations

import argparse
import csv
import json
import math
import re
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly


FRAME_PERIOD_MS = 5.0
FRAME_SECONDS = FRAME_PERIOD_MS / 1000.0
LRC_TIMESTAMP_PATTERN = re.compile(
    r"\[(?P<minutes>\d{1,3}):(?P<seconds>\d{2}(?:\.\d{1,3})?)\]"
)


@dataclass(frozen=True, slots=True)
class LyricUnit:
    start_seconds: float
    end_seconds: float
    text: str


@dataclass(frozen=True, slots=True)
class GameNote:
    onset_seconds: float
    offset_seconds: float
    pitch: float


@dataclass(frozen=True, slots=True)
class RenderEvent:
    start_seconds: float
    end_seconds: float
    text: str
    game_pitches: tuple[int, ...]


def parse_args() -> argparse.Namespace:
    experiment_root = Path(__file__).resolve().parent
    project_root = experiment_root.parents[3]
    source_root = (
        project_root
        / "backend/runtime/experiments/xuezhiqian-bianfeiweibao"
    )
    parser = argparse.ArgumentParser(
        description=(
            "Fuse GAME notes, RMVPE pitch detail and word-timed lyrics, then "
            "render one continuous WORLD event per lyric character."
        )
    )
    parser.add_argument(
        "--guide",
        type=Path,
        default=source_root / "guide-70s-30s.wav",
    )
    parser.add_argument(
        "--accompaniment",
        type=Path,
        default=source_root / "accompaniment-70s-30s.wav",
    )
    parser.add_argument(
        "--material",
        type=Path,
        default=project_root / "audio/man.wav",
    )
    parser.add_argument(
        "--lyrics",
        type=Path,
        default=project_root
        / "music/薛之谦 - 变废为宝 (317342237).lrc",
    )
    parser.add_argument(
        "--game-csv",
        type=Path,
        default=experiment_root / "work/game/guide-70s-30s.csv",
    )
    parser.add_argument(
        "--rmvpe-csv",
        type=Path,
        default=experiment_root / "work/rmvpe/guide-70s-30s-f0.csv",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=experiment_root / "outputs",
    )
    parser.add_argument("--source-offset", type=float, default=70.0)
    parser.add_argument(
        "--boundary-snap",
        type=float,
        default=0.080,
        help=(
            "Snap GAME boundaries this close to lyric-character boundaries, "
            "in seconds."
        ),
    )
    parser.add_argument(
        "--vocal-gain",
        type=float,
        default=1.10,
        help="Gain of the rendered material before mixing.",
    )
    return parser.parse_args()


def timestamp_seconds(match: re.Match[str]) -> float:
    return int(match.group("minutes")) * 60.0 + float(
        match.group("seconds")
    )


def parse_word_timed_lrc(
    path: Path,
    *,
    source_offset: float,
    duration: float,
) -> tuple[LyricUnit, ...]:
    units: list[LyricUnit] = []
    contents = path.read_text(encoding="utf-8-sig")
    for line in contents.splitlines():
        timestamps = list(LRC_TIMESTAMP_PATTERN.finditer(line))
        if len(timestamps) < 2:
            continue
        # LDDC puts title/credit metadata in the same timestamped format as
        # lyrics. Keep only lines that are entirely CJK plus whitespace so
        # the renderer receives song characters, not credits or punctuation.
        visible = LRC_TIMESTAMP_PATTERN.sub("", line).strip()
        if not visible or any(
            not (character.isspace() or "\u3400" <= character <= "\u9fff")
            for character in visible
        ):
            continue
        for current, following in zip(timestamps[:-1], timestamps[1:]):
            text = line[current.end() : following.start()].strip()
            if not text or not all(
                character.isspace()
                or "\u3400" <= character <= "\u9fff"
                for character in text
            ):
                continue
            start = timestamp_seconds(current) - source_offset
            end = timestamp_seconds(following) - source_offset
            if end <= start or end <= 0.0 or start >= duration:
                continue
            start = max(0.0, start)
            end = min(duration, end)
            if end > start:
                units.append(LyricUnit(start, end, text))
    return tuple(sorted(units, key=lambda unit: unit.start_seconds))


def read_game_notes(path: Path) -> tuple[GameNote, ...]:
    notes: list[GameNote] = []
    with path.open("r", encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            note = GameNote(
                onset_seconds=float(row["onset"]),
                offset_seconds=float(row["offset"]),
                pitch=float(row["pitch"]),
            )
            if note.offset_seconds > note.onset_seconds:
                notes.append(note)
    return tuple(notes)


def snap_notes_to_lyrics(
    notes: tuple[GameNote, ...],
    lyrics: tuple[LyricUnit, ...],
    tolerance_seconds: float,
) -> tuple[GameNote, ...]:
    if tolerance_seconds <= 0.0 or not lyrics:
        return notes
    boundaries = np.unique(
        np.array(
            [
                boundary
                for lyric in lyrics
                for boundary in (lyric.start_seconds, lyric.end_seconds)
            ],
            dtype=np.float64,
        )
    )

    def snap(value: float) -> float:
        nearest_index = int(np.argmin(np.abs(boundaries - value)))
        nearest = float(boundaries[nearest_index])
        return nearest if abs(nearest - value) <= tolerance_seconds else value

    aligned: list[GameNote] = []
    for note in notes:
        onset = snap(note.onset_seconds)
        offset = snap(note.offset_seconds)
        if offset - onset < 0.020:
            onset = note.onset_seconds
            offset = note.offset_seconds
        if aligned and onset < aligned[-1].offset_seconds:
            # Snapping both sides independently can make adjacent GAME notes
            # overlap. Keep a single monotonic boundary before USTX creation.
            boundary = (aligned[-1].offset_seconds + onset) / 2.0
            previous = aligned[-1]
            aligned[-1] = GameNote(previous.onset_seconds, boundary, previous.pitch)
            onset = boundary
        if offset <= onset:
            offset = onset + 0.020
        aligned.append(GameNote(onset, offset, note.pitch))
    return tuple(aligned)


def load_audio(path: Path) -> tuple[np.ndarray, int]:
    audio, sample_rate = sf.read(
        path,
        dtype="float64",
        always_2d=True,
    )
    return np.asarray(audio, dtype=np.float64), int(sample_rate)


def resample_audio(audio: np.ndarray, source_rate: int, target_rate: int):
    if source_rate == target_rate:
        return audio
    divisor = math.gcd(source_rate, target_rate)
    return resample_poly(
        audio,
        target_rate // divisor,
        source_rate // divisor,
        axis=0,
    )


def fit_audio_length(audio: np.ndarray, samples: int) -> np.ndarray:
    if len(audio) >= samples:
        return audio[:samples].copy()
    return np.pad(audio, ((0, samples - len(audio)), (0, 0)))


def midi_from_f0(f0: np.ndarray) -> np.ndarray:
    result = np.full(f0.shape, np.nan, dtype=np.float64)
    voiced = f0 > 0.0
    result[voiced] = 69.0 + 12.0 * np.log2(f0[voiced] / 440.0)
    return result


def f0_from_midi(midi: np.ndarray) -> np.ndarray:
    return 440.0 * np.power(2.0, (midi - 69.0) / 12.0)


def build_pitch_track(
    notes: tuple[GameNote, ...],
    rmvpe_path: Path,
    *,
    duration: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Place raw RMVPE MIDI values inside GAME note intervals.

    GAME supplies the note rectangles. RMVPE supplies the absolute pitch
    values inside those rectangles; no centering, filtering, scaling, or
    pitch limiting is applied here.
    """
    frame_times = np.arange(
        0.0,
        duration + FRAME_SECONDS * 0.5,
        FRAME_SECONDS,
        dtype=np.float64,
    )
    target = np.full(frame_times.shape, np.nan, dtype=np.float64)
    anchors = np.full(frame_times.shape, np.nan, dtype=np.float64)
    rmvpe_data = np.loadtxt(rmvpe_path, delimiter=",", ndmin=2)
    rmvpe_times = np.arange(len(rmvpe_data), dtype=np.float64) * 0.01
    rmvpe_midi = midi_from_f0(rmvpe_data[:, 1])

    for note in notes:
        mask = (frame_times >= note.onset_seconds) & (
            frame_times < note.offset_seconds
        )
        if not np.any(mask):
            continue
        anchor = float(round(note.pitch))
        anchors[mask] = anchor
        local_times = frame_times[mask]
        voiced = np.isfinite(rmvpe_midi) & (
            rmvpe_times >= note.onset_seconds
        ) & (rmvpe_times <= note.offset_seconds)
        if not np.any(voiced):
            continue
        target[mask] = np.interp(
            local_times,
            rmvpe_times[voiced],
            rmvpe_midi[voiced],
        )
    return frame_times, target, anchors


def frame_rms(
    audio_mono: np.ndarray,
    sample_rate: int,
    frame_times: np.ndarray,
    window_seconds: float = 0.025,
) -> np.ndarray:
    squared = np.square(audio_mono, dtype=np.float64)
    cumulative = np.r_[0.0, np.cumsum(squared)]
    half_window = max(1, round(window_seconds * sample_rate / 2.0))
    centers = np.rint(frame_times * sample_rate).astype(np.int64)
    left = np.clip(centers - half_window, 0, len(audio_mono))
    right = np.clip(centers + half_window, 0, len(audio_mono))
    counts = np.maximum(1, right - left)
    return np.sqrt((cumulative[right] - cumulative[left]) / counts)


def event_pitch_curve(
    frame_times: np.ndarray,
    target_midi: np.ndarray,
    start: float,
    end: float,
) -> tuple[np.ndarray, np.ndarray]:
    event_times = np.arange(
        start,
        end + FRAME_SECONDS * 0.5,
        FRAME_SECONDS,
        dtype=np.float64,
    )
    valid = np.isfinite(target_midi)
    if not np.any(valid):
        return event_times, np.full(event_times.shape, np.nan)
    curve = np.interp(
        event_times,
        frame_times[valid],
        target_midi[valid],
    )
    return event_times, curve


def make_source_frame_indices(
    target_frames: int,
    source_frames: int,
) -> np.ndarray:
    attack_frames = min(round(0.085 / FRAME_SECONDS), source_frames // 2)
    sustain_start = min(attack_frames, max(0, source_frames - 2))
    sustain_end = max(sustain_start + 1, source_frames - 5)
    forward = np.arange(sustain_start, sustain_end, dtype=np.int64)
    backward = forward[-2:0:-1]
    cycle = np.r_[forward, backward]
    if not len(cycle):
        cycle = np.array([max(0, source_frames - 1)], dtype=np.int64)
    indices = np.empty(target_frames, dtype=np.int64)
    direct = min(target_frames, attack_frames)
    indices[:direct] = np.arange(direct, dtype=np.int64)
    if direct < target_frames:
        indices[direct:] = cycle[
            np.arange(target_frames - direct, dtype=np.int64) % len(cycle)
        ]
    return np.clip(indices, 0, source_frames - 1)


def analyse_material(
    material_mono: np.ndarray,
    sample_rate: int,
) -> tuple[np.ndarray, np.ndarray, float, dict[str, float | int]]:
    import pyworld as pw

    material_mono = np.ascontiguousarray(material_mono, dtype=np.float64)
    f0, temporal_positions = pw.harvest(
        material_mono,
        sample_rate,
        f0_floor=45.0,
        f0_ceil=900.0,
        frame_period=FRAME_PERIOD_MS,
    )
    f0 = pw.stonemask(
        material_mono,
        f0,
        temporal_positions,
        sample_rate,
    )
    spectral_envelope = pw.cheaptrick(
        material_mono,
        f0,
        temporal_positions,
        sample_rate,
    )
    aperiodicity = pw.d4c(
        material_mono,
        f0,
        temporal_positions,
        sample_rate,
    )
    source_rms = float(np.sqrt(np.mean(np.square(material_mono))))
    voiced_f0 = f0[f0 > 0.0]
    report = {
        "source_frames": int(len(f0)),
        "source_rms": source_rms,
        "source_voiced_ratio": float(np.mean(f0 > 0.0)),
        "source_f0_median_hz": (
            float(np.median(voiced_f0)) if len(voiced_f0) else 0.0
        ),
    }
    return spectral_envelope, aperiodicity, source_rms, report


def render_variant(
    *,
    frame_times: np.ndarray,
    target_midi: np.ndarray,
    anchors: np.ndarray,
    lyrics: tuple[LyricUnit, ...],
    notes: tuple[GameNote, ...],
    guide_rms: np.ndarray,
    spectral_envelope: np.ndarray,
    aperiodicity: np.ndarray,
    source_rms: float,
    sample_rate: int,
    total_samples: int,
) -> tuple[np.ndarray, tuple[RenderEvent, ...], np.ndarray]:
    import pyworld as pw

    output = np.zeros(total_samples, dtype=np.float64)
    diagnostic_target = np.full(frame_times.shape, np.nan, dtype=np.float64)
    events: list[RenderEvent] = []
    note_ranges = tuple(
        (note.onset_seconds, note.offset_seconds, int(round(note.pitch)))
        for note in notes
    )
    all_active_rms = guide_rms[np.isfinite(anchors)]
    rms_reference = (
        float(np.quantile(all_active_rms, 0.90))
        if len(all_active_rms)
        else float(np.max(guide_rms))
    )
    rms_reference = max(rms_reference, 1e-6)

    for lyric in lyrics:
        overlaps = tuple(
            pitch
            for onset, offset, pitch in note_ranges
            if offset > lyric.start_seconds and onset < lyric.end_seconds
        )
        if not overlaps:
            continue
        event_times, curve = event_pitch_curve(
            frame_times,
            target_midi,
            lyric.start_seconds,
            lyric.end_seconds,
        )
        if not np.all(np.isfinite(curve)):
            continue
        target_f0 = np.ascontiguousarray(f0_from_midi(curve))
        source_indices = make_source_frame_indices(
            len(target_f0),
            len(spectral_envelope),
        )
        event_audio = pw.synthesize(
            target_f0,
            np.ascontiguousarray(spectral_envelope[source_indices]),
            np.ascontiguousarray(aperiodicity[source_indices]),
            sample_rate,
            FRAME_PERIOD_MS,
        )
        event_audio = np.asarray(event_audio, dtype=np.float64)
        event_audio -= float(np.mean(event_audio))
        event_rms = float(np.sqrt(np.mean(np.square(event_audio))))
        if event_rms > 1e-7:
            event_audio *= source_rms / event_rms

        local_rms = np.interp(event_times, frame_times, guide_rms)
        local_strength = np.clip(
            np.power(local_rms / rms_reference, 0.68),
            0.0,
            1.25,
        )
        event_level = float(np.quantile(local_strength, 0.65))
        local_strength = 0.56 * local_strength + 0.44 * event_level
        local_strength = np.maximum(local_strength, 0.32)

        start_sample = max(0, round(lyric.start_seconds * sample_rate))
        end_sample = min(
            total_samples,
            round(lyric.end_seconds * sample_rate),
        )
        wanted_samples = end_sample - start_sample
        if wanted_samples <= 0:
            continue
        if len(event_audio) < wanted_samples:
            event_audio = np.pad(
                event_audio,
                (0, wanted_samples - len(event_audio)),
                mode="edge",
            )
        else:
            event_audio = event_audio[:wanted_samples]
        sample_times = (
            np.arange(wanted_samples, dtype=np.float64) / sample_rate
            + lyric.start_seconds
        )
        strength_samples = np.interp(
            sample_times,
            event_times,
            local_strength,
        )
        edge_samples = min(
            round(0.010 * sample_rate),
            wanted_samples // 3,
        )
        edge_envelope = np.ones(wanted_samples, dtype=np.float64)
        if edge_samples > 1:
            fade = np.sin(
                np.linspace(0.0, np.pi / 2.0, edge_samples)
            ) ** 2
            edge_envelope[:edge_samples] = fade
            edge_envelope[-edge_samples:] = fade[::-1]
        event_audio *= strength_samples * edge_envelope
        output[start_sample:end_sample] += event_audio

        diagnostic_mask = (frame_times >= lyric.start_seconds) & (
            frame_times <= lyric.end_seconds
        )
        diagnostic_target[diagnostic_mask] = np.interp(
            frame_times[diagnostic_mask],
            event_times,
            curve,
        )
        events.append(
            RenderEvent(
                start_seconds=lyric.start_seconds,
                end_seconds=lyric.end_seconds,
                text=lyric.text,
                game_pitches=tuple(overlaps),
            )
        )
    return output, tuple(events), diagnostic_target


def safe_mix(
    accompaniment: np.ndarray,
    rendered_mono: np.ndarray,
    vocal_gain: float,
) -> tuple[np.ndarray, float]:
    vocal = np.repeat(rendered_mono[:, None], accompaniment.shape[1], axis=1)
    mixed = accompaniment + vocal_gain * vocal
    peak = float(np.max(np.abs(mixed)))
    limiter_gain = min(1.0, 0.985 / max(peak, 1e-9))
    return mixed * limiter_gain, limiter_gain


def write_diagnostics(
    path: Path,
    *,
    frame_times: np.ndarray,
    anchors: np.ndarray,
    rmvpe_target: np.ndarray,
    guide_rms: np.ndarray,
) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
                "time_seconds",
                "game_anchor_midi",
                "rmvpe_render_midi",
                "guide_rms",
            ]
        )
        for values in zip(
            frame_times,
            anchors,
            rmvpe_target,
            guide_rms,
        ):
            writer.writerow(
                [
                    f"{values[0]:.3f}",
                    "" if not np.isfinite(values[1]) else f"{values[1]:.4f}",
                    "" if not np.isfinite(values[2]) else f"{values[2]:.4f}",
                    f"{values[3]:.8f}",
                ]
            )


def main() -> None:
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    guide, sample_rate = load_audio(args.guide)
    accompaniment, accompaniment_rate = load_audio(args.accompaniment)
    if accompaniment_rate != sample_rate:
        accompaniment = resample_audio(
            accompaniment,
            accompaniment_rate,
            sample_rate,
        )
    total_samples = min(len(guide), len(accompaniment))
    guide = fit_audio_length(guide, total_samples)
    accompaniment = fit_audio_length(accompaniment, total_samples)
    duration = total_samples / sample_rate

    material, material_rate = load_audio(args.material)
    material = resample_audio(material, material_rate, sample_rate)
    material_mono = np.mean(material, axis=1)
    peak = float(np.max(np.abs(material_mono)))
    if peak > 1e-9:
        material_mono = material_mono / peak * 0.92

    lyrics = parse_word_timed_lrc(
        args.lyrics,
        source_offset=args.source_offset,
        duration=duration,
    )
    original_notes = read_game_notes(args.game_csv)
    notes = snap_notes_to_lyrics(
        original_notes,
        lyrics,
        max(0.0, args.boundary_snap),
    )
    frame_times, raw_track, anchors = build_pitch_track(
        notes,
        args.rmvpe_csv,
        duration=duration,
    )
    guide_mono = np.mean(guide, axis=1)
    guide_rms = frame_rms(
        guide_mono,
        sample_rate,
        frame_times,
    )
    spectral_envelope, aperiodicity, source_rms, source_report = (
        analyse_material(material_mono, sample_rate)
    )

    variants = {"game-rmvpe": raw_track}
    report: dict[str, object] = {
        "sample_rate": sample_rate,
        "duration_seconds": duration,
        "source_offset_seconds": args.source_offset,
        "game_note_count": len(notes),
        "game_boundary_snap_seconds": args.boundary_snap,
        "game_boundaries_changed": sum(
            original != aligned
            for original, aligned in zip(original_notes, notes)
        ),
        "lyric_unit_count": len(lyrics),
        "rmvpe_pitch_mode": "raw absolute RMVPE MIDI inside GAME intervals",
        "vocal_gain": args.vocal_gain,
        "material_analysis": source_report,
        "variants": {},
    }
    rendered_diagnostics: dict[str, np.ndarray] = {}
    for variant_name, target_track in variants.items():
        rendered, events, diagnostic_target = render_variant(
            frame_times=frame_times,
            target_midi=target_track,
            anchors=anchors,
            lyrics=lyrics,
            notes=notes,
            guide_rms=guide_rms,
            spectral_envelope=spectral_envelope,
            aperiodicity=aperiodicity,
            source_rms=source_rms,
            sample_rate=sample_rate,
            total_samples=total_samples,
        )
        unscaled_peak = float(np.max(np.abs(rendered)))
        render_gain = min(1.0, 0.78 / max(unscaled_peak, 1e-9))
        rendered *= render_gain
        mixed, limiter_gain = safe_mix(
            accompaniment,
            rendered,
            args.vocal_gain,
        )
        rendered_peak = float(np.max(np.abs(rendered)))
        rendered_rms = float(np.sqrt(np.mean(np.square(rendered))))
        sf.write(
            args.output_dir / f"man-{variant_name}.wav",
            rendered,
            sample_rate,
            subtype="PCM_24",
        )
        sf.write(
            args.output_dir / f"mix-{variant_name}.wav",
            mixed,
            sample_rate,
            subtype="PCM_24",
        )
        rendered_diagnostics[variant_name] = diagnostic_target
        report["variants"][variant_name] = {
            "event_count": len(events),
            "unscaled_rendered_peak": unscaled_peak,
            "render_gain": render_gain,
            "rendered_peak": rendered_peak,
            "rendered_rms": rendered_rms,
            "mix_limiter_gain": limiter_gain,
            "events": [asdict(event) for event in events],
        }

    write_diagnostics(
        args.output_dir / "pitch-targets.csv",
        frame_times=frame_times,
        anchors=anchors,
        rmvpe_target=rendered_diagnostics["game-rmvpe"],
        guide_rms=guide_rms,
    )
    (args.output_dir / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
