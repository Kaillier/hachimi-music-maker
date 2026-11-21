import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
import wave

import mido

from instrumental_tracks import SAMPLE_RATE, TIMING_EVENTS, export_tracks


def events(track, keep):
    tick = 0
    messages = []
    for message in track:
        tick += message.time
        if keep(message):
            messages.append((tick, message.copy(time=0)))
    return messages


class InstrumentalTracksTests(unittest.TestCase):
    def test_export_preserves_selected_track_and_tempo_ticks(self):
        with TemporaryDirectory(prefix="音轨 文件 ") as folder:
            root = Path(folder)
            source = root / "完整乐谱.mid"
            output = root / "可选音轨"
            score = mido.MidiFile(type=1, ticks_per_beat=480, charset="utf8")
            conductor = mido.MidiTrack([
                mido.MetaMessage("set_tempo", tempo=500000, time=0),
                mido.MetaMessage("time_signature", numerator=3, time=10),
                mido.MetaMessage("set_tempo", tempo=750000, time=330),
            ])
            pitched = mido.MidiTrack([
                mido.MetaMessage("track_name", name="弦乐"),
                mido.Message("program_change", channel=3, program=48),
                mido.Message("note_on", channel=3, note=69, velocity=71, time=120),
                mido.MetaMessage("set_tempo", tempo=600000, time=40),
                mido.Message("pitchwheel", channel=3, pitch=-92, time=35),
                mido.Message("note_off", channel=3, note=69, time=160),
                mido.Message("note_on", channel=3, note=70, velocity=55, time=95),
                mido.Message("note_on", channel=3, note=70, velocity=0, time=100),
            ])
            drums = mido.MidiTrack([
                mido.Message("note_on", channel=9, note=36, time=43),
                mido.Message("note_off", channel=9, note=36, time=380),
            ])
            score.tracks.extend((conductor, pitched, drums))
            score.save(source)
            original_bytes = source.read_bytes()

            result = export_tracks(source, output)
            self.assertEqual(result["tracks"], [{
                "id": "track-2", "label": "弦乐", "noteCount": 2,
                "midi": "track-2.mid", "preview": "track-2.wav",
            }])
            self.assertEqual(result, json.loads((output / "tracks.json").read_text(encoding="utf8")))
            self.assertEqual(source.read_bytes(), original_bytes)

            single = mido.MidiFile(output / "track-2.mid", charset="utf8")
            self.assertEqual(single.ticks_per_beat, score.ticks_per_beat)
            self.assertEqual(
                events(single.tracks[0], lambda msg: msg.type in TIMING_EVENTS),
                events(mido.merge_tracks(score.tracks), lambda msg: msg.type in TIMING_EVENTS),
            )
            keep = lambda msg: msg.type not in TIMING_EVENTS | {"end_of_track"}
            self.assertEqual(events(single.tracks[1], keep), events(pitched, keep))

            with wave.open(str(output / "track-2.wav")) as preview:
                self.assertEqual(preview.getnframes(), round(score.length * SAMPLE_RATE))
                self.assertEqual(preview.readframes(4000), bytes(8000))
                self.assertTrue(any(preview.readframes(1500)))

    def test_drum_only_score_has_no_choices(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "drums.mid"
            score = mido.MidiFile(type=0)
            score.tracks.append(mido.MidiTrack([
                mido.Message("note_on", channel=9, note=37),
                mido.Message("note_off", channel=9, note=37, time=120),
            ]))
            score.save(source)
            output = root / "out"
            self.assertEqual(export_tracks(source, output)["tracks"], [])
            self.assertEqual(list(output.iterdir()), [output / "tracks.json"])

    def test_track_audition_includes_silence_at_the_end_of_the_recording(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "source.mid"
            original = root / "original.wav"
            score = mido.MidiFile(type=0)
            score.tracks.append(mido.MidiTrack([
                mido.Message("note_on", note=60),
                mido.Message("note_off", note=60, time=120),
            ]))
            score.save(source)
            with wave.open(str(original), "wb") as audio:
                audio.setparams((1, 2, 44100, 0, "NONE", "not compressed"))
                audio.writeframes(bytes(44100 * 2))

            output = root / "tracks"
            result = export_tracks(source, output, original)
            self.assertEqual(result["duration"], 1)
            with wave.open(str(output / "track-1.wav"), "rb") as preview:
                self.assertEqual(preview.getnframes(), SAMPLE_RATE)
                preview.setpos(SAMPLE_RATE // 2)
                self.assertEqual(preview.readframes(SAMPLE_RATE // 2), bytes(SAMPLE_RATE))


if __name__ == "__main__":
    unittest.main()
