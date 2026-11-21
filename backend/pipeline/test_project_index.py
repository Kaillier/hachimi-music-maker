from copy import deepcopy
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from lyric_reference import clean_lines, local_candidates, vocal2midi_line
from project_index import editor_groups, index_pages, make_pages, read_asr_lines, read_score_units, score_units, ScoreTimeline
from render_vocal2midi import replacement_plan
from test_vocal2midi_render import fixture


class IndexTests(unittest.TestCase):
    def test_digits_in_chinese_lyrics_are_readable_by_the_native_aligner(self):
        self.assertEqual(vocal2midi_line('当107路经过，等 １０７ 路', 'zh'), '当一零七路经过，等 一零七 路')
        self.assertEqual(vocal2midi_line('Route 107', 'en'), 'Route 107')

    def test_unrelated_asr_chunks_and_pitch_only_runs_do_not_merge_into_lyrics(self):
        sung_lines = ['晚风吹过长长的街道', '时间带走青春的电车']
        spoken = ['你们要出去吃饭吗', '记得把照片发给我']
        labels = [sung_lines[0], spoken[0], '窗外的小巷那一夜', sung_lines[1]]
        chunks = [
            {'Final Assigned Lyrics': lyric, 'ASR Output': raw,
             'Match Status': 'Fallback to ASR' if i == 1 else 'Matched with original lyrics'}
            for i, (lyric, raw) in enumerate(zip(labels, [sung_lines[0], *spoken, sung_lines[1]]))
        ]
        units = [{'id': i, 'text': char, 'start': i, 'end': i + 1}
                 for i, char in enumerate(''.join(labels[:-1]) + 'a' * 26 + labels[-1])]
        pages, _ = index_pages(units, sung_lines, (), chunks)
        self.assertEqual(pages[0]['units'], list(range(len(sung_lines[0]))))
        self.assertTrue(pages[1]['defaultExcluded'])
        self.assertTrue(all(page['lyricsUnaligned'] for page in pages[2:-1]))
        self.assertEqual([len(page['units']) for page in pages[2:-1]], [12, 12, 2])
        self.assertEqual(''.join(pages[-1]['text'].split()), sung_lines[1])
        self.assertEqual([i for page in pages for i in page['units']], list(range(len(units))))
        without_reference, _ = index_pages(units, (), (), chunks)
        self.assertFalse(any(page.get('defaultExcluded') for page in without_reference))

    def test_reference_line_lengths_become_editor_groups_only(self):
        score = fixture()
        score['voice_parts'][0]['notes'][0]['duration'] = 327
        for note, char in zip((n for n in score['voice_parts'][0]['notes'] if n['lyric'] not in ('+', '+~', '-')), '甲乙丙丁戊己'):
            note['lyric'] = char
        before = deepcopy(score)
        units = read_score_units(score)
        cuts, source = editor_groups(units, ['甲乙，', '丙丁戊', '己'], ['甲乙丙', '丁戊己'])
        self.assertEqual(source, 'reference')
        self.assertEqual([page['units'] for page in make_pages(units, cuts)], [[0, 1], [2, 3, 4], [5]])
        self.assertEqual(len(units[0]['notes']), 2)
        self.assertEqual(score, before)

    def test_unknown_lyrics_and_word_internal_cuts_do_not_force_a_match(self):
        units = [{'text': word} for word in ['New', 'York', 'City']]
        self.assertEqual(editor_groups(units, ['Other song'], ['New York', 'City']), ([0, 2, 3], 'asr'))
        self.assertEqual(editor_groups(units, ['New Y', 'ork City'], []), ([0, 3], 'pages'))

    def test_missing_and_repeated_boundary_characters_do_not_move_notes(self):
        units = [{'text': char} for char in '东船与西舫琴音袅袅于心上心上望样深情终究难放下']
        self.assertEqual(editor_groups(units, ['东船与西舫琴音袅袅于心上', '望姑娘样深情终究难放下'], []),
                         ([0, 14, len(units)], 'reference'))

    def test_reference_matching_and_cleanup(self):
        with TemporaryDirectory() as tmp:
            directory = Path(tmp)
            expected = directory / '甲／乙 - 歌名 (版本) (42).lrc'
            expected.touch()
            (directory / '丙 - 歌名 (版本) (43).lrc').touch()
            self.assertEqual(local_candidates(directory, '歌名（版本）', '甲Artist/乙', 'upload'), expected)
            self.assertIsNone(local_candidates(directory, '歌名（版本）', '', 'upload'))
            log = directory / 'lyrics.log'
            log.write_text('ASR Output: 第一行，第二行。\nFinal Assigned Lyrics: 第三行\n', encoding='utf8')
            self.assertEqual(read_asr_lines(log), ['第一行', '第二行'])
        self.assertEqual(clean_lines(['[ar:甲]', '歌名 - 甲', '词Lyricist：甲', '制作人Music Producer：乙', '歌名', '[00:01.3]歌<00:02.000>词'],
                                     '歌名', '甲'), ['歌名', '歌词'])

    def test_tempo_map_and_part_offset_are_respected(self):
        score = fixture()
        score['tempos'].append({'position': 960, 'bpm': 60})
        timeline = ScoreTimeline(score)
        self.assertAlmostEqual(timeline.time(480), .5)
        self.assertAlmostEqual(timeline.time(960), 1)
        self.assertAlmostEqual(timeline.time(1440), 2)
        score['voice_parts'][0]['position'] = 480
        units, _ = score_units(score)
        self.assertAlmostEqual(units[0]['start'], .5)
        self.assertAlmostEqual(units[0]['end'], 2)

    def test_extenders_group_without_changing_notes_or_filling_rests(self):
        score = fixture()
        score['voice_parts'][0]['notes'][0]['duration'] = 327
        before = deepcopy(score)
        units, pages = score_units(score)
        self.assertEqual(len(units), 6)
        self.assertEqual(len(units[0]['notes']), 2)
        self.assertAlmostEqual(units[0]['notes'][0]['end'], 327 / 960)
        self.assertAlmostEqual(units[0]['notes'][1]['start'], .5)
        self.assertEqual(pages[0]['units'], list(range(6)))
        self.assertEqual(score, before)

    def test_pages_are_only_display_groups_and_do_not_split_a_syllable(self):
        score = fixture()
        notes = score['voice_parts'][0]['notes']
        for index in range(8, 30):
            notes.append({'position': index * 480, 'duration': 480, 'tone': 60, 'lyric': 'a'})
        units, pages = score_units(score)
        self.assertEqual([len(page['units']) for page in pages], [12, 12, 4])
        self.assertEqual(sum(len(unit['notes']) for unit in units), 30)

    def test_exact_selection_applies_once_per_primary_unit_including_gapped_sustain(self):
        score = fixture()
        score['voice_parts'][0]['notes'][0]['duration'] = 327
        values = ['bo', 'man', 'mi', 'ji', 'ha', 'bo']
        plan, count, _, restarts = replacement_plan(score, values, repeat=False)
        self.assertEqual(plan[0], ['bo', 'bo', 'man', 'mi', 'ji', 'ha', 'bo', '+~'])
        self.assertEqual(count, len(values))
        self.assertEqual(restarts[0]['alias'], 'bo')
        with self.assertRaises(ValueError):
            replacement_plan(score, values[:-1], repeat=False)
        with self.assertRaises(ValueError):
            replacement_plan(score, values + ['ha'], repeat=False)


if __name__ == '__main__':
    unittest.main()
