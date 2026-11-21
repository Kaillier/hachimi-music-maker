import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPitchSource } from '../pitch-routing.mjs';

const ids = ['rmvpe-original', 'fcpe-vocal', 'note-only'];
const project = { pitchModeDefault: ids[0], nativeRender: { pitchModes:
  Object.fromEntries(ids.map(id => [id, { pitch: id === 'note-only' ? null : `projects/test/pitch-${id}.csv` }])) } };

test('each mode selects only its own server-owned pitch path', () => {
  for (const id of ids) assert.deepEqual(selectPitchSource(project, id), {
    mode: id, path: id === 'note-only' ? null : `projects/test/pitch-${id}.csv`,
  });
  assert.equal(selectPitchSource(project).mode, ids[0]);
  for (const invalid of ['missing', '../../pitch.csv', '__proto__']) {
    assert.throws(() => selectPitchSource(project, invalid), /未知/);
  }
});

test('legacy projects cannot silently substitute the default for a requested new mode', () => {
  const legacy = { nativeRender: { pitch: 'projects/test/pitch.csv' } };
  assert.equal(selectPitchSource(legacy).path, legacy.nativeRender.pitch);
  for (const id of ids.slice(1)) assert.throws(() => selectPitchSource(legacy, id), /尚未生成/);
});

test('note-only mode deliberately has no pitch CSV', () => {
  const projectWithNotes = { pitchModeDefault: 'note-only', nativeRender: {
    pitchModes: { 'note-only': { label: '只用音符（无音高曲线）', pitch: null } },
  } };
  assert.deepEqual(selectPitchSource(projectWithNotes), { mode: 'note-only', path: null });
});
