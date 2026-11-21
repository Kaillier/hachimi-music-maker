"""Regression checks for imported-score replacement without re-transcription."""
from copy import deepcopy
import unittest

from render_vocal2midi import replacement_plan, score_content, validate_replacement, validate_score


def fixture():
    lyrics = ["a", "+~", "b", "c", "d", "e", "f", "+~"]
    return {
        "ustx_version": "0.7",
        "resolution": 480,
        "tempos": [{"position": 0, "bpm": 120.0}],
        "time_signatures": [{"bar_position": 0, "beat_per_bar": 4, "beat_unit": 4}],
        "voice_parts": [{
            "position": 0,
            "notes": [
                {"position": index * 480, "duration": 480, "tone": 60 + index, "lyric": lyric}
                for index, lyric in enumerate(lyrics)
            ],
            "curves": [{"abbr": "pitd", "xs": [0, 5], "ys": [10, -20]}],
        }],
    }


def replacement(source):
    result = deepcopy(source)
    lyrics = ["ha", "+~", "ji", "mi", "man", "bo", "ha", "+~"]
    for note, lyric in zip(result["voice_parts"][0]["notes"], lyrics):
        note["lyric"] = lyric
    return result


class ImportedScoreTests(unittest.TestCase):
    def test_import_validation_accepts_original_score(self):
        validate_score(fixture())

    def test_newer_versions_and_wave_parts_are_not_silently_rewritten(self):
        score = fixture()
        score["ustx_version"] = "0.9"
        with self.assertRaises(ValueError):
            validate_score(score)
        score = fixture()
        score["wave_parts"] = [{"file_path": "original-vocals.wav"}]
        with self.assertRaises(ValueError):
            validate_score(score)

    def test_sustain_notes_do_not_advance_the_cycle(self):
        source = fixture()
        self.assertEqual(validate_replacement(source, replacement(source)), (6, 2))
        self.assertEqual(source["voice_parts"][0]["notes"][0]["lyric"], "a")

    def test_timing_changes_are_rejected(self):
        source = fixture()
        rendered = replacement(source)
        rendered["voice_parts"][0]["notes"][0]["position"] += 1
        with self.assertRaisesRegex(ValueError, "changed source"):
            validate_replacement(source, rendered)

    def test_pitch_curve_changes_are_rejected(self):
        source = fixture()
        rendered = replacement(source)
        rendered["voice_parts"][0]["curves"][0]["ys"][0] += 1
        with self.assertRaisesRegex(ValueError, "changed source"):
            validate_replacement(source, rendered)

    def test_retriggered_sustain_is_rejected(self):
        source = fixture()
        rendered = replacement(source)
        rendered["voice_parts"][0]["notes"][1]["lyric"] = "ji"
        with self.assertRaisesRegex(ValueError, "Unexpected replacement"):
            validate_replacement(source, rendered)

    def test_gapped_extenders_rearticulate_without_advancing_pattern_or_changing_score(self):
        source = fixture()
        source["voice_parts"][0]["notes"][0]["duration"] = 327
        source["voice_parts"][0]["notes"][6]["duration"] = 403
        before = deepcopy(source)
        rendered = replacement(source)
        rendered["voice_parts"][0]["notes"][1]["lyric"] = "ha"
        rendered["voice_parts"][0]["notes"][7]["lyric"] = "ha"
        self.assertEqual(validate_replacement(source, rendered), (6, 2))
        self.assertEqual([item["gapTicks"] for item in replacement_plan(source)[3]], [153, 77])
        self.assertEqual(score_content(source), score_content(rendered))
        self.assertEqual(source, before)

    def test_gapped_extender_uses_own_syllable_not_first_sound(self):
        source = fixture()
        notes = source["voice_parts"][0]["notes"]
        notes[1]["lyric"] = "b"
        notes[1]["duration"] = 100
        notes[2]["lyric"] = "+~"
        expected, syllables, sustains, restarts = replacement_plan(source)
        self.assertEqual(expected[0][:4], ["ha", "ji", "ji", "mi"])
        self.assertEqual((syllables, sustains), (6, 2))
        self.assertEqual(restarts[0]["alias"], "ji")

    def test_contiguous_extender_after_restart_still_extends_the_same_alias(self):
        source = fixture()
        notes = source["voice_parts"][0]["notes"]
        notes[0]["duration"] = 327
        notes[2]["lyric"] = "+~"
        expected, syllables, sustains, restarts = replacement_plan(source)
        self.assertEqual(expected[0][:4], ["ha", "ha", "+~", "ji"])
        self.assertEqual((syllables, sustains, len(restarts)), (5, 3, 1))

    def test_orphan_and_overlapping_extenders_are_not_guessed_or_retimed(self):
        source = fixture()
        source["voice_parts"][0]["notes"][0]["lyric"] = "+~"
        with self.assertRaises(ValueError):
            replacement_plan(source)
        source = fixture()
        source["voice_parts"][0]["notes"][0]["duration"] = 600
        with self.assertRaises(ValueError):
            replacement_plan(source)

    def test_gap_is_not_filled_and_tempo_cannot_change(self):
        source = fixture()
        source["voice_parts"][0]["notes"][0]["duration"] = 327
        rendered = replacement(source)
        rendered["voice_parts"][0]["notes"][1]["lyric"] = "ha"
        rendered["voice_parts"][0]["notes"][0]["duration"] = 480
        with self.assertRaisesRegex(ValueError, "changed source"):
            validate_replacement(source, rendered)
        rendered = replacement(source)
        rendered["tempos"][0]["bpm"] = 121
        with self.assertRaisesRegex(ValueError, "changed source"):
            validate_replacement(source, rendered)


if __name__ == "__main__":
    unittest.main()
