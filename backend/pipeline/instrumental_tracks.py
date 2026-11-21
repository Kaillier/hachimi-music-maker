"""Export unchanged MIDI tracks and fixed-timbre auditions for manual selection."""

from __future__ import annotations

import argparse
from bisect import bisect_right
from collections import defaultdict, deque
from io import BytesIO
import json
from math import tau
from pathlib import Path
import sys
import wave

import mido
import numpy as np


PERCUSSION_CHANNEL = 9
SAMPLE_RATE = 32_000
TIMING_EVENTS = {"set_tempo", "time_signature", "key_signature", "smpte_offset"}
INSTRUMENT_LABELS = {
    "acoustic piano": "钢琴",
    "electric piano": "电钢琴",
    "chromatic percussion": "有音高打击乐",
    "organ": "风琴",
    "acoustic guitar": "原声吉他",
    "clean electric guitar": "清音电吉他",
    "distorted electric guitar": "失真电吉他",
    "acoustic bass": "原声贝斯",
    "electric bass": "电贝斯",
    "violin": "小提琴",
    "viola": "中提琴",
    "cello": "大提琴",
    "contrabass": "低音提琴",
    "orchestral harp": "竖琴",
    "timpani": "定音鼓",
    "string ensemble": "弦乐组",
    "synth strings": "合成弦乐",
    "voice": "人声类音色",
    "orchestra hit": "管弦齐奏",
    "trumpet": "小号",
    "trombone": "长号",
    "tuba": "大号",
    "french horn": "圆号",
    "brass section": "铜管组",
    "soprano and alto sax": "高音与中音萨克斯",
    "tenor sax": "次中音萨克斯",
    "baritone sax": "上低音萨克斯",
    "oboe": "双簧管",
    "english horn": "英国管",
    "bassoon": "巴松管",
    "clarinet": "单簧管",
    "flutes": "长笛类",
    "synth lead": "合成器主奏音色",
    "synth pad": "合成器铺底音色",
}


def open_score(source: bytes) -> mido.MidiFile:
    try:
        return mido.MidiFile(file=BytesIO(source), charset="utf8")
    except UnicodeDecodeError:
        return mido.MidiFile(file=BytesIO(source))


def select_events(track, include):
    """Copy matching events while preserving their absolute ticks."""
    selected = mido.MidiTrack()
    elapsed = 0
    for message in track:
        elapsed += message.time
        if include(message):
            selected.append(message.copy(time=elapsed))
            elapsed = 0
    return selected


def note_start(message):
    return message.type == "note_on" and message.channel != PERCUSSION_CHANNEL and message.velocity > 0


class MidiTimeline:
    """Translate absolute ticks using the original score's tempo map."""

    def __init__(self, conductor, ticks_per_beat):
        self.ticks_per_beat = ticks_per_beat
        self.ticks = [0]
        self.times = [0.0]
        self.tempos = [500_000]
        tick = 0
        for message in conductor:
            tick += message.time
            if message.type != "set_tempo":
                continue
            if message.tempo <= 0:
                raise ValueError("MIDI 速度必须大于 0。")
            if tick == self.ticks[-1]:
                self.tempos[-1] = message.tempo
                continue
            self.times.append(self.seconds(tick))
            self.ticks.append(tick)
            self.tempos.append(message.tempo)

    def seconds(self, tick):
        index = bisect_right(self.ticks, tick) - 1
        return self.times[index] + mido.tick2second(tick - self.ticks[index], self.ticks_per_beat, self.tempos[index])

    def tick(self, seconds):
        index = bisect_right(self.times, seconds) - 1
        return self.ticks[index] + mido.second2tick(seconds - self.times[index], self.ticks_per_beat, self.tempos[index])


def audition_notes(track, timeline, duration):
    active = defaultdict(deque)
    tick = 0
    for message in track:
        tick += message.time
        if message.type not in {"note_on", "note_off"} or message.channel == PERCUSSION_CHANNEL:
            continue
        time = timeline.seconds(tick)
        key = (message.channel, message.note)
        if note_start(message):
            active[key].append((time, message.velocity))
        elif active[key]:
            start, velocity = active[key].popleft()
            yield start, time, message.note, velocity
    for (_, pitch), pending in active.items():
        for start, velocity in pending:
            yield start, duration, pitch, velocity


def track_audio(score: mido.MidiFile, duration: float, path: Path) -> None:
    timeline = MidiTimeline(mido.merge_tracks(score.tracks), score.ticks_per_beat)
    audio = np.zeros(max(1, round(duration * SAMPLE_RATE)), dtype=np.float32)
    notes = (note for track in score.tracks for note in audition_notes(track, timeline, duration))
    for start, end, pitch, velocity in notes:
        first = round(start * SAMPLE_RATE)
        last = min(len(audio), round(end * SAMPLE_RATE))
        samples = np.arange(max(0, last - first), dtype=np.float32) / SAMPLE_RATE
        frequency = 440 * 2 ** ((pitch - 69) / 12)
        phase = samples * (tau * frequency)
        tone = np.sin(phase)
        for harmonic, level in ((2, .29), (3, .13)):
            if frequency * harmonic < SAMPLE_RATE / 2:
                tone += level * np.exp(-3 * samples) * np.sin(harmonic * phase)
        attack = np.minimum(samples / .012, 1)
        release = np.minimum((len(samples) / SAMPLE_RATE - samples) / .018, 1)
        envelope = attack * release * (.55 + .45 * np.exp(-1.5 * samples))
        audio[first:last] += tone * envelope * (velocity / 127) ** 1.3

    peak = np.max(np.abs(audio))
    if peak:
        audio *= .88 / peak
    with wave.open(str(path), "wb") as output:
        output.setparams((1, 2, SAMPLE_RATE, 0, "NONE", "not compressed"))
        output.writeframes((audio * 32767).astype("<i2").tobytes())


def export_tracks(input_midi: Path, output_dir: Path, original_audio: Path | None = None) -> dict:
    score = open_score(input_midi.read_bytes())
    if score.type == 2 or score.ticks_per_beat <= 0:
        raise ValueError("音轨试听需要共享时间轴的 MIDI 工程。")

    conductor = select_events(mido.merge_tracks(score.tracks), lambda msg: msg.type in TIMING_EVENTS)
    duration = score.length
    if original_audio is not None:
        with wave.open(str(original_audio), "rb") as original:
            duration = original.getnframes() / original.getframerate()
    output_dir.mkdir(parents=True, exist_ok=True)
    tracks = []
    for number, track in enumerate(score.tracks, start=1):
        note_count = sum(note_start(message) for message in track)
        if not note_count:
            continue
        track_id = f"track-{number}"
        midi_name, preview_name = f"{track_id}.mid", f"{track_id}.wav"
        midi_path = output_dir / midi_name
        if midi_path.resolve() == input_midi.resolve():
            raise ValueError("音轨导出路径与源 MIDI 重合。")
        selected = select_events(track, lambda msg: msg.type not in TIMING_EVENTS)
        single = mido.MidiFile(type=1, ticks_per_beat=score.ticks_per_beat, charset=score.charset)
        single.tracks.extend((conductor, selected))
        single.save(midi_path)
        track_audio(single, duration, output_dir / preview_name)
        name = track.name.strip()
        tracks.append({
            "id": track_id,
            "label": INSTRUMENT_LABELS.get(name.lower().replace("_", " "), name or f"音轨 {number}"),
            "noteCount": note_count,
            "midi": midi_name,
            "preview": preview_name,
        })

    result = {"duration": duration, "tracks": tracks}
    (output_dir / "tracks.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf8")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_midi", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--original-audio", type=Path)
    args = parser.parse_args()
    try:
        export_tracks(args.input_midi, args.output_dir, args.original_audio)
    except (OSError, ValueError) as error:
        sys.exit(f"音轨导出失败：{error}")


if __name__ == "__main__":
    main()
