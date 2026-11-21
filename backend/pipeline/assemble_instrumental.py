"""Build a melody MIDI from the instruments chosen for successive time ranges."""

from __future__ import annotations

import argparse
from bisect import bisect_right
from collections import defaultdict, deque
from dataclasses import dataclass
import json
from math import isfinite
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

import mido

from instrumental_tracks import MidiTimeline, PERCUSSION_CHANNEL, TIMING_EVENTS, note_start, open_score, select_events, track_audio


MIDI_FILE = "main-melody.mid"
PREVIEW_FILE = "main-melody.wav"
RESULT_FILE = "selection-result.json"
TIME_TOLERANCE = 1e-7


@dataclass(frozen=True)
class Segment:
    start: float
    end: float
    track_id: str | None


def read_selection(selection, duration, track_ids):
    def valid_time(time):
        return type(time) in (int, float) and isfinite(time) and time >= 0

    if not isinstance(selection, dict) or not isinstance(selection.get("segments"), list) or not selection["segments"]:
        raise ValueError("请选择各时间段的主旋律音轨或留空。")
    length = selection.get("duration", duration)
    if not valid_time(length) or length <= 0:
        raise ValueError("工程时长无效。")
    cursor = 0.0
    ranges = []
    for item in selection["segments"]:
        if not isinstance(item, dict) or not {"start", "end", "trackId"} <= item.keys():
            raise ValueError("选段格式无效。")
        start, end, track_id = item["start"], item["end"], item["trackId"]
        if not valid_time(start) or not valid_time(end) or abs(start - cursor) > TIME_TOLERANCE or end <= cursor:
            raise ValueError("时间段必须从 0 秒开始，依次相接且时长大于 0。")
        if track_id is not None and (not isinstance(track_id, str) or track_id not in track_ids):
            raise ValueError("选择了不存在的旋律音轨。")
        ranges.append(Segment(cursor, end, track_id))
        cursor = end
    if abs(cursor - length) > TIME_TOLERANCE:
        raise ValueError("选段需覆盖工程的完整时间轴。")
    return ranges, length


def picked_note_events(track, track_id, timeline, starts, ranges):
    pending = defaultdict(deque)
    note_events = set()
    channels = set()
    note_count = 0
    tick = 0
    for index, message in enumerate(track):
        tick += message.time
        if message.type not in {"note_on", "note_off"} or message.channel == PERCUSSION_CHANNEL:
            continue
        notes = pending[(message.channel, message.note)]
        if note_start(message):
            seconds = timeline.seconds(tick)
            # Tolerate roundoff at a pasted boundary. Notes at the boundary belong to the range on its right.
            segment = ranges[bisect_right(starts, seconds + TIME_TOLERANCE) - 1]
            selected = segment.track_id == track_id and seconds < segment.end
            notes.append(selected)
            if selected:
                channels.add(message.channel)
                note_events.add(index)
                note_count += 1
        elif notes and notes.popleft():
            note_events.add(index)
    return note_events, channels, note_count


def melody_track(source, note_events, channels, channel_map, port):
    """Copy note pairs and channel state using absolute tick spacing."""
    result = mido.MidiTrack()
    if port:
        result.append(mido.MetaMessage("midi_port", port=port))
    delta = 0
    for index, message in enumerate(source):
        delta += message.time
        if message.type in TIMING_EVENTS or message.type in {"midi_port", "end_of_track"}:
            continue
        if message.type in {"note_on", "note_off"}:
            if index not in note_events:
                continue
        elif not message.is_meta and getattr(message, "channel", None) not in channels:
            continue
        if getattr(message, "channel", None) in channel_map:
            message = message.copy(channel=channel_map[message.channel])
        result.append(message.copy(time=delta))
        delta = 0
    return result


def choose_channels(channels, used_ports):
    """Keep programs separate if MuScriptor reused a MIDI channel."""
    for port in range(256):
        occupied = used_ports[port]
        reserved = channels - occupied
        free = iter(sorted(set(range(16)) - {PERCUSSION_CHANNEL} - occupied - reserved))
        mapping = {channel: channel if channel in reserved else next(free, None) for channel in sorted(channels)}
        if None not in mapping.values():
            occupied.update(mapping.values())
            return mapping, port
    raise ValueError("所选音轨超过 MIDI 可用通道数量。")


def assemble_score(score, selection):
    if score.type == 2 or score.ticks_per_beat <= 0:
        raise ValueError("主旋律工程需要共享时间轴的 MIDI。")
    candidates = {f"track-{index}": track for index, track in enumerate(score.tracks, start=1)
                  if any(note_start(message) for message in track)}
    merged = mido.merge_tracks(score.tracks)
    conductor = select_events(merged, lambda message: message.type in TIMING_EVENTS)
    timeline = MidiTimeline(conductor, score.ticks_per_beat)
    source_end_tick = sum(message.time for message in merged)
    segments, duration = read_selection(selection, timeline.seconds(source_end_tick), candidates)
    starts = [segment.start for segment in segments]
    selected_ids = {segment.track_id for segment in segments}

    conductor_end = sum(message.time for message in conductor)
    conductor.append(mido.MetaMessage("end_of_track", time=max(0, timeline.tick(duration) - conductor_end)))
    result = mido.MidiFile(type=1, ticks_per_beat=score.ticks_per_beat, charset=score.charset)
    result.tracks.append(conductor)
    used_ports = defaultdict(set)
    note_count = 0
    for track_id, track in candidates.items():
        if track_id not in selected_ids:
            continue
        events, channels, count = picked_note_events(track, track_id, timeline, starts, segments)
        if events:
            channel_map, port = choose_channels(channels, used_ports)
            result.tracks.append(melody_track(track, events, channels, channel_map, port))
            note_count += count
    return result, duration, note_count


def export_selection(input_midi: Path, selection_file: Path, output_dir: Path):
    input_paths = {input_midi.resolve(), selection_file.resolve()}
    output_names = (MIDI_FILE, PREVIEW_FILE, RESULT_FILE)
    if any((output_dir / name).resolve() in input_paths for name in output_names):
        raise ValueError("导出文件不能覆盖源 MIDI 或选段。")
    source = input_midi.read_bytes()
    selection = selection_file.read_bytes()
    result, duration, note_count = assemble_score(open_score(source), json.loads(selection))

    data = {"duration": duration, "noteCount": note_count, "midi": MIDI_FILE, "preview": PREVIEW_FILE}
    output_dir.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix="assemble-", dir=output_dir) as staging:
        staging_dir = Path(staging)
        result.save(staging_dir / MIDI_FILE)
        track_audio(result, duration, staging_dir / PREVIEW_FILE)
        (staging_dir / RESULT_FILE).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf8")
        if input_midi.read_bytes() != source or selection_file.read_bytes() != selection:
            raise ValueError("导出期间源 MIDI 或选段发生了变化，请重试。")
        for name in output_names:
            (staging_dir / name).replace(output_dir / name)
    return data


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_midi", type=Path)
    parser.add_argument("selection", type=Path)
    parser.add_argument("output_dir", type=Path)
    args = parser.parse_args()
    try:
        export_selection(args.input_midi, args.selection, args.output_dir)
    except (OSError, ValueError, EOFError) as error:
        sys.exit(f"主旋律导出失败：{error}")


if __name__ == "__main__":
    main()
