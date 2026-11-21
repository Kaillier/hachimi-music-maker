import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyDraft, restoreDraft, migrateDraft, repeatPattern, complete, nativePhrasePayload, nativeRenderPayload, isNativeRenderProject } from '../audio-core.js';

const project = {
  id: 'native-test',
  fingerprint: 'native-test',
  phrases: [
    { id: 0, units: [0, 1] },
    { id: 1, units: [2] },
  ],
};

test('draft restoration and completion only accept the current native project shape', () => {
  const draft = emptyDraft(project);
  assert.equal(complete(project, draft), false);
  draft.sequences = [['ha', 'ji'], ['mi']];
  draft.confirmed = [true, true];
  assert.equal(complete(project, draft), true);
  const restored = restoreDraft(project, { ...draft, fingerprint: 'stale' });
  assert.equal(complete(project, restored), false);
  assert.deepEqual(repeatPattern(['ha', 'ji', null]), ['ha', 'ji', 'ha']);
});

test('regenerated score keeps matching edits and defaults suspected dialogue to original audio', () => {
  const next = { fingerprint: 'corrected', phrases: [
    { units: [0], defaultExcluded: true }, { units: [1, 2] },
  ], arrangementMigration: { fingerprint: project.fingerprint, phrases: [[0, 1], [2]], previousUnitIds: [0, 2, null] } };
  const old = { ...emptyDraft(project), sequences: [['ha', 'ji'], ['bo']], confirmed: [true, true] };
  const migrated = migrateDraft(next, old);
  assert.equal(migrated.current, 1);
  assert.deepEqual(migrated.confirmed, [true, false]);
  assert.deepEqual(nativeRenderPayload(next, migrated).sequences, [['@original'], ['bo', null]]);
  migrated.deleted[0] = false;
  assert.equal(restoreDraft(next, migrated).deleted[0], false);
});
test('native payloads preserve selected order, phrase index, and gains', () => {
  const draft = { ...emptyDraft(project), sequences: [['ha', 'bo'], ['man']], backingGain: .8, soundGain: .9 };
  assert.deepEqual(nativePhrasePayload(project, draft, 1), {
    songId: 'native-test', fingerprint: 'native-test', phraseIndex: 1, sequences: [['ha', 'bo'], ['man']], confirmed: [false, false], backingGain: .8, soundGain: .9,
  });
  assert.deepEqual(nativeRenderPayload(project, draft), {
    songId: 'native-test', fingerprint: 'native-test', sequences: [['ha', 'bo'], ['man']], confirmed: [false, false], backingGain: .8, soundGain: .9,
  });
});

test('only the USTX pipeline is accepted and historical draft modes are discarded', () => {
  assert.equal(isNativeRenderProject({ renderMode: 'openutau-native' }), false);
  assert.equal(isNativeRenderProject({ renderMode: 'openutau-ustx', pipeline: 'vocal2midi-ustx-v1' }), true);
  const draft = restoreDraft(project, { ...emptyDraft(project), pitchMode: 'legacy', timingMode: 'raw' });
  assert.equal('pitchMode' in draft, false);
  assert.equal('timingMode' in nativeRenderPayload(project, draft), false);
});
