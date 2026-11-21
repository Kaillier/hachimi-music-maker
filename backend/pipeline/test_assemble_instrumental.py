import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
import wave

import mido

from assemble_instrumental import assemble_score, export_selection
from instrumental_tracks import SAMPLE_RATE, TIMING_EVENTS


def make_score():
    score = mido.MidiFile(type=1, ticks_per_beat=480, charset="utf8")
    score.tracks.extend((
        mido.MidiTrack([
            mido.MetaMessage("set_tempo", tempo=500000),
            mido.MetaMessage("set_tempo", tempo=1000000, time=240),
        ]),
        mido.MidiTrack([
            mido.MetaMessage("track_name", name="提琴"),
            mido.Message("program_change", channel=4, program=40),
            mido.Message("note_on", channel=4, note=60, velocity=71, time=120),
            mido.Message("note_on", channel=4, note=66, velocity=81, time=120),
            mido.Message("note_off", channel=4, note=60, time=60),
            mido.Message("note_off", channel=4, note=66, time=30),
        ]),
        mido.MidiTrack([
            mido.MetaMessage("track_name", name="长笛"),
            mido.Message("program_change", channel=4, program=73),
            mido.Message("note_on", channel=4, note=55, velocity=65, time=239),
            mido.Message("note_on", channel=4, note=60, velocity=76, time=1),
            mido.Message("note_on", channel=4, note=67, velocity=70),
            mido.Message("note_off", channel=4, note=55, time=80),
            mido.Message("note_off", channel=4, note=60, time=40),
            mido.Message("note_on", channel=4, note=67, velocity=0, time=60),
            mido.Message("note_on", channel=4, note=75, velocity=63, time=60),
            mido.Message("note_off", channel=4, note=75, time=60),
        ]),
        mido.MidiTrack([
            mido.Message("note_on", channel=9, note=36, velocity=100),
            mido.Message("note_off", channel=9, note=36, time=480),
        ]),
    ))
    return score


def timeline_events(track, types):
    events = []
    tick = 0
    for message in track:
        tick += message.time
        if message.type in types:
            events.append((tick, message.copy(time=0)))
    return events


def note_signature(track):
    return [(tick, message.note, message.velocity)
            for tick, message in timeline_events(track, {"note_on", "note_off"})]


class InstrumentalRangeTests(unittest.TestCase):
    def test_exact_boundary_notes_changes_instruments_and_keeps_tails_and_chords(self):
        with TemporaryDirectory(prefix="选段 工程 ") as folder:
            root = Path(folder)
            source = root / "原曲.mid"
            selection_path = root / "选段.json"
            out = root / "导出"
            score = make_score()
            score.save(source)
            original = source.read_bytes()
            selection = {
                "duration": 1.5,
                "segments": [
                    {"start": 0, "end": 0.25, "trackId": "track-2"},
                    {"start": 0.25, "end": 0.75, "trackId": "track-3"},
                    {"start": 0.75, "end": 1.5, "trackId": None},
                ],
            }
            selection_path.write_text(json.dumps(selection), encoding="utf8")
            result = export_selection(source, selection_path, out)
            self.assertEqual(result, {
                "duration": 1.5, "noteCount": 3, "midi": "main-melody.mid", "preview": "main-melody.wav",
            })
            self.assertEqual(source.read_bytes(), original)
            self.assertEqual(json.loads(selection_path.read_text(encoding="utf8")), selection)
            self.assertEqual(json.loads((out / "selection-result.json").read_text(encoding="utf8")), result)

            melody = mido.MidiFile(out / result["midi"], charset="utf8")
            self.assertEqual(melody.ticks_per_beat, score.ticks_per_beat)
            self.assertAlmostEqual(melody.length, 1.5)
            self.assertEqual(timeline_events(melody.tracks[0], TIMING_EVENTS),
                             timeline_events(mido.merge_tracks(score.tracks), TIMING_EVENTS))
            violin, flute = melody.tracks[1:]
            self.assertEqual(violin.name, "提琴")
            self.assertEqual(note_signature(violin), [(120, 60, 71), (300, 60, 64)])
            self.assertEqual(flute.name, "长笛")
            self.assertEqual(note_signature(flute), [(240, 60, 76), (240, 67, 70), (360, 60, 64), (420, 67, 0)])
            state = [next(message for message in track if message.type == "program_change")
                     for track in (violin, flute)]
            self.assertEqual([message.program for message in state], [40, 73])
            self.assertNotEqual(state[0].channel, state[1].channel)

            with wave.open(str(out / result["preview"])) as preview:
                self.assertEqual(preview.getnframes(), round(1.5 * SAMPLE_RATE))
                self.assertEqual(preview.readframes(round(0.125 * SAMPLE_RATE)), bytes(round(0.125 * SAMPLE_RATE) * 2))
                self.assertTrue(any(preview.readframes(640)))
                preview.setpos(round(0.75 * SAMPLE_RATE))
                self.assertEqual(preview.readframes(640), bytes(1280))

    def test_silence_and_invalid_selection(self):
        score = make_score()
        silence = {"segments": [{"start": 0, "end": score.length, "trackId": None}]}
        midi, duration, count = assemble_score(score, silence)
        self.assertEqual(count, 0)
        self.assertEqual(len(midi.tracks), 1)
        self.assertAlmostEqual(duration, score.length)

        bad_segments = (
            [{"start": 0, "end": score.length, "trackId": "track-4"}],
            [{"start": 0, "end": score.length, "trackId": []}],
            [{"start": 0.1, "end": score.length, "trackId": None}],
            [{"start": 0, "end": 0.25, "trackId": None}, {"start": 0.2, "end": score.length, "trackId": None}],
            [{"start": 0, "end": 0.25, "trackId": None}, {"start": 0.3, "end": score.length, "trackId": None}],
            [{"start": 0, "end": 0.25, "trackId": None}],
            [{"start": 0, "end": float("nan"), "trackId": None}],
        )
        for segments in bad_segments:
            with self.subTest(segments=segments), self.assertRaises(ValueError):
                assemble_score(score, {"segments": segments})

    def test_audio_can_end_before_the_midi_without_clipping_selected_notes(self):
        score = make_score()
        midi, duration, count = assemble_score(score, {
            "duration": .3,
            "segments": [{"start": 0, "end": .3, "trackId": "track-3"}],
        })
        self.assertEqual(duration, .3)
        self.assertEqual(count, 3)
        self.assertEqual(note_signature(midi.tracks[1]), [
            (239, 55, 65), (240, 60, 76), (240, 67, 70),
            (320, 55, 64), (360, 60, 64), (420, 67, 0),
        ])


if __name__ == "__main__":
    unittest.main()
