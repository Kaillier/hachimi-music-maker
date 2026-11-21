import unittest
import importlib.util
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np

from prepare_web import parse_lrc, partition_game_notes_by_characters

FUSION_PATH = (
    Path(__file__).resolve().parents[1]
    / "runtime/game-rmvpe-world/run_world_fusion.py"
)
FUSION_SPEC = importlib.util.spec_from_file_location("test_world_fusion", FUSION_PATH)
FUSION = importlib.util.module_from_spec(FUSION_SPEC)
assert FUSION_SPEC.loader is not None
sys.modules[FUSION_SPEC.name] = FUSION
FUSION_SPEC.loader.exec_module(FUSION)
GameNote = FUSION.GameNote
snap_notes_to_lyrics = FUSION.snap_notes_to_lyrics


class LyricTests(unittest.TestCase):
    def test_lddc_file_uses_song_lines_only(self):
        root = Path(__file__).resolve().parents[2]
        path = root / "music/郑浩／冰洁 - 琵琶曲 (东船与西舫) (651640684).lrc"
        lyrics = parse_lrc(path)
        self.assertEqual(len(lyrics), 28)
        self.assertEqual(sum(len(line["chars"]) for line in lyrics), 324)
        self.assertEqual(lyrics[0]["text"], "东船与西舫琴音袅袅于心上")
        self.assertEqual(lyrics[-1]["text"], "回首人间笑谈你我初遇")
        self.assertGreater(lyrics[0]["start"], 2.4)

    def test_line_timestamp_lrc_keeps_lyric_lines_without_treating_metadata_as_lyrics(self):
        root = Path(__file__).resolve().parents[2]
        with TemporaryDirectory() as directory:
            path = Path(directory) / "line-level.lrc"
            path.write_text(
                '{"t":0,"c":[{"tx":"作词: "},{"tx":"薛之谦"}]}\n'
                "[00:18.042]你降落的 太突然了\n"
                "[00:24.240]我刚好呢 又路过了\n",
                encoding="utf-8",
            )
            lyrics = parse_lrc(path)
        self.assertEqual(len(lyrics), 2)
        self.assertTrue(all(line["chars"] is None for line in lyrics))
        self.assertEqual(lyrics[0]["text"], "你降落的 太突然了")
        self.assertEqual(lyrics[-1]["text"], "我刚好呢 又路过了")
        self.assertAlmostEqual(lyrics[0]["start"], 18.042)

    def test_plain_text_lyrics_are_reference_only(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "lyrics.txt"
            path.write_text("第一句歌词\n第二句歌词\n", encoding="utf-8")
            lyrics = parse_lrc(path)
        self.assertEqual([line["text"] for line in lyrics], ["第一句歌词", "第二句歌词"])
        self.assertTrue(all(line["chars"] is None for line in lyrics))

    def test_updated_song_has_per_character_anchors(self):
        root = Path(__file__).resolve().parents[2]
        path = next((root / "music").glob("薛之谦 - 天外来物*.lrc"))
        lyrics = parse_lrc(path)
        self.assertEqual(len(lyrics), 30)
        self.assertEqual(sum(len(line["chars"]) for line in lyrics), 307)
        self.assertTrue(all(line["chars"] for line in lyrics))
        self.assertAlmostEqual(lyrics[0]["chars"][0]["start"], 18.096)

    def test_game_note_snapping_keeps_boundaries_monotonic(self):
        lyrics = (
            type("Lyric", (), {"start_seconds": 1.0, "end_seconds": 2.0})(),
            type("Lyric", (), {"start_seconds": 2.0, "end_seconds": 3.0})(),
        )
        notes = (
            GameNote(1.0, 2.04, 60.0),
            GameNote(1.96, 3.0, 62.0),
        )
        aligned = snap_notes_to_lyrics(notes, lyrics, 0.08)
        self.assertLessEqual(aligned[0].offset_seconds, aligned[1].onset_seconds)

    def test_game_notes_define_character_blocks(self):
        anchors = []
        for start, end, text in ((10.0, 10.4, "甲"), (10.4, 10.8, "乙")):
            anchor = type("Anchor", (), {})()
            anchor.start_seconds = start
            anchor.end_seconds = end
            anchor.text = text
            anchors.append(anchor)
        notes = (
            GameNote(9.98, 10.20, 60.0),
            GameNote(10.21, 10.42, 62.0),
            GameNote(10.42, 10.80, 64.0),
        )
        blocks = partition_game_notes_by_characters(anchors, notes)
        self.assertEqual([[note.pitch for note in block] for block in blocks], [[60.0, 62.0], [64.0]])

    def test_rmvpe_pitch_is_raw_inside_game_intervals(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "f0.csv"
            hz = 440.0 * 2.0 ** ((np.array([60.0, 72.0, 48.0]) - 69.0) / 12.0)
            np.savetxt(
                path,
                np.column_stack([np.arange(3) * 0.01, hz]),
                delimiter=",",
            )
            notes = (GameNote(0.0, 0.03, 60.0),)
            times, pitch, _ = FUSION.build_pitch_track(notes, path, duration=0.03)
        expected = np.interp(times, [0.0, 0.01, 0.02], [60.0, 72.0, 48.0])
        np.testing.assert_allclose(pitch[np.isfinite(pitch)], expected[:-1], atol=1e-6)


if __name__ == "__main__":
    unittest.main()
