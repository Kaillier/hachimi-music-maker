export const SOUND_IDS = ['ha', 'ji', 'mi', 'man', 'bo'];
export const LABELS = { ha: '哈', ji: '基', mi: '米', man: '曼', bo: '波' };
export const SAMPLE_RATE = 44100;

export function emptyDraft(project) {
  return { fingerprint: project.fingerprint, current: 0, noteMode: defaultNoteMode(project), pitchMode: defaultPitchMode(project), timingMode: defaultTimingMode(project),
    sequences: project.phrases.map(p => Array(p.units.length).fill(null)),
    confirmed: project.phrases.map(() => false), backingGain: 1, soundGain: 1 };
}

export function restoreDraft(project, value) {
  const draft = emptyDraft(project);
  if (!value || value.fingerprint !== project.fingerprint) return draft;
  const savedNote = value.noteMode ?? defaultNoteMode(project);
  const noteAvailable = noteModeEntries(project).some(mode => mode.id === savedNote);
  if (noteAvailable) draft.noteMode = savedNote;
  const savedMode = value.pitchMode ?? defaultPitchMode(project);
  const modeAvailable = pitchModeEntries(project).some(mode => mode.id === savedMode);
  if (modeAvailable) draft.pitchMode = savedMode;
  const savedTiming = value.timingMode ?? defaultTimingMode(project);
  if (timingModeEntries(project, draft.noteMode).some(mode => mode.id === savedTiming)) draft.timingMode = savedTiming;
  project.phrases.forEach((p, i) => {
    const saved = value.sequences?.[i];
    if (Array.isArray(saved) && saved.length === p.units.length) {
      draft.sequences[i] = saved.map(s => SOUND_IDS.includes(s) ? s : null);
      draft.confirmed[i] = noteAvailable && modeAvailable && draft.noteMode === savedNote && draft.timingMode === savedTiming && draft.pitchMode === savedMode && value.confirmed?.[i] === true && draft.sequences[i].every(Boolean);
    }
  });
  if (Number.isInteger(value.current)) draft.current = Math.max(0, Math.min(value.current, project.phrases.length - 1));
  for (const name of ['backingGain', 'soundGain']) {
    if (Number.isFinite(value[name])) draft[name] = Math.max(0, Math.min(1.5, value[name]));
  }
  return draft;
}

export function repeatPattern(sequence) {
  const pattern = sequence.filter(Boolean);
  return pattern.length ? sequence.map((_, i) => pattern[i % pattern.length]) : [...sequence];
}

export function complete(project, draft) {
  return project.phrases.every((p, i) => draft.confirmed[i] &&
    draft.sequences[i]?.length === p.units.length && draft.sequences[i].every(s => SOUND_IDS.includes(s)));
}

export function isNativeRenderProject(project) {
  return project?.renderMode === 'openutau-native';
}

export function pitchModeEntries(project) {
  const modes = project?.nativeRender?.pitchModes;
  if (!modes || typeof modes !== 'object') return [{ id: 'default', label: '默认音高轨' }];
  return Object.entries(modes).map(([id, value]) => ({ id, label: value.label || id }));
}

export function noteModeEntries(project) {
  const modes = project?.noteModes;
  if (!modes || typeof modes !== 'object') return [{ id: 'game-vocal', label: 'GAME · 人声', timingModes: {} }];
  return Object.entries(modes).map(([id, value]) => ({ id, label: value.label || id, timingModes: value.timingModes || {} }));
}

export function defaultNoteMode(project) {
  const modes = noteModeEntries(project);
  return modes.find(mode => mode.id === project?.noteModeDefault)?.id || modes[0]?.id || 'game-vocal';
}

export function defaultPitchMode(project) {
  const modes = pitchModeEntries(project);
  return modes.find(mode => mode.id === project?.pitchModeDefault)?.id || modes[0]?.id || 'default';
}

export function timingModeEntries(project, noteMode = defaultNoteMode(project)) {
  const modes = project?.noteModes?.[noteMode]?.timingModes || project?.timingModes;
  if (!modes || typeof modes !== 'object') return [{ id: 'beat', label: '拍子辅助' }, { id: 'raw', label: '无拍子辅助' }];
  return Object.entries(modes).map(([rawId, value]) => {
    const id = rawId === 'game-beat' ? 'beat' : rawId === 'game-raw' ? 'raw' : rawId;
    return { id, label: value.label || (id === 'beat' ? '拍子辅助' : id === 'raw' ? '无拍子辅助' : id), project: value.project };
  });
}

export function defaultTimingMode(project, noteMode = defaultNoteMode(project)) {
  const modes = timingModeEntries(project, noteMode);
  const requested = project?.timingModeDefault === 'game-beat' ? 'beat' : project?.timingModeDefault === 'game-raw' ? 'raw' : project?.timingModeDefault;
  return modes.find(mode => mode.id === requested)?.id || modes[0]?.id || 'beat';
}

export function nativeRenderPayload(project, draft, noteMode = draft.noteMode || defaultNoteMode(project), timingMode = draft.timingMode || defaultTimingMode(project, noteMode), pitchMode = draft.pitchMode || defaultPitchMode(project)) {
  return {
    songId: project.id,
    fingerprint: project.fingerprint,
    noteMode,
    timingMode,
    pitchMode,
    sequences: draft.sequences.map(sequence => [...sequence]),
    confirmed: [...draft.confirmed],
    backingGain: draft.backingGain,
    soundGain: draft.soundGain,
  };
}

export function nativePhrasePayload(project, draft, phraseIndex, noteMode = draft.noteMode || defaultNoteMode(project), timingMode = draft.timingMode || defaultTimingMode(project, noteMode), pitchMode = draft.pitchMode || defaultPitchMode(project)) {
  return {
    songId: project.id,
    fingerprint: project.fingerprint,
    noteMode,
    timingMode,
    pitchMode,
    phraseIndex,
    sequence: [...draft.sequences[phraseIndex]],
    backingGain: draft.backingGain,
    soundGain: draft.soundGain,
  };
}

export function nativeRenderSnapshot(project, draft, noteMode = draft.noteMode || defaultNoteMode(project), timingMode = draft.timingMode || defaultTimingMode(project, noteMode), pitchMode = draft.pitchMode || defaultPitchMode(project)) {
  return JSON.stringify(nativeRenderPayload(project, draft, noteMode, timingMode, pitchMode));
}
