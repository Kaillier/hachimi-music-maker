import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyDraft, restoreDraft, repeatPattern, complete, nativePhrasePayload, nativeRenderPayload, timingModeEntries } from '../audio-core.js';

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
test('native payloads preserve selected order, phrase index, and gains', () => {
  const draft = { ...emptyDraft(project), sequences: [['ha', 'bo'], ['man']], backingGain: .8, soundGain: .9 };
  assert.deepEqual(nativePhrasePayload(project, draft, 1), {
    songId: 'native-test', fingerprint: 'native-test', noteMode: 'game-vocal', timingMode: 'beat', pitchMode: 'default', phraseIndex: 1, sequence: ['man'], backingGain: .8, soundGain: .9,
  });
  assert.deepEqual(nativeRenderPayload(project, draft), {
    songId: 'native-test', fingerprint: 'native-test', noteMode: 'game-vocal', timingMode: 'beat', pitchMode: 'default', sequences: [['ha', 'bo'], ['man']], confirmed: [false, false], backingGain: .8, soundGain: .9,
  });
});

test('timing mode is part of the local draft and native render payload', () => {
  const timingProject = {
    ...project,
    timingModeDefault: 'beat',
    timingModes: {
      beat: { label: '拍子辅助' },
      raw: { label: '无拍子辅助' },
    },
  };
  const draft = emptyDraft(timingProject);
  draft.timingMode = 'raw';
  draft.sequences = [['ha', 'ji'], ['mi']];
  draft.confirmed = [true, true];
  assert.deepEqual(timingModeEntries(timingProject).map(mode => mode.id), ['beat', 'raw']);
  assert.equal(nativeRenderPayload(timingProject, draft).timingMode, 'raw');
  assert.equal(restoreDraft(timingProject, { ...draft }).timingMode, 'raw');
});
