import catalogue from './sound-packs.json' with { type: 'json' };

export const LABELS = catalogue.labels;
export const SOUND_SOURCE_ALIASES = catalogue.sourceAliases;
export const SOUND_IDS = Object.keys(LABELS);
const draftAliasReplacements = new Map(Object.entries(catalogue.draftAliasReplacements));
export const SOUND_PACKS = catalogue.packs;
export const DEFAULT_SOUND_PACK = SOUND_PACKS.find(pack => pack.id === catalogue.defaultPack);
export const SAMPLE_RATE = 44100;
export const KEEP_ORIGINAL = '@original';

export function emptyDraft(project) {
  const deleted = project.phrases.map(p => p.defaultExcluded === true);
  return { fingerprint: project.fingerprint, current: deleted.indexOf(false),
    sequences: project.phrases.map(p => Array(p.units.length).fill(null)),
    confirmed: project.phrases.map(() => false), phraseEdits: project.phrases.map(() => null),
    deleted, backingGain: .5, soundGain: .5 };
}
export function nearestActivePhrase(draft, index) {
  const next = draft.deleted.findIndex((deleted, i) => !deleted && i >= index);
  return next >= 0 ? next : draft.deleted.lastIndexOf(false);
}
export function restoreDraft(project, value) {
  const draft = emptyDraft(project);
  if (!value || value.fingerprint !== project.fingerprint) return draft;
  project.phrases.forEach((page, index) => {
    if (typeof value.deleted?.[index] === 'boolean') draft.deleted[index] = value.deleted[index];
    const edit = value.phraseEdits?.[index];
    if (edit && Array.isArray(edit.kept) && edit.kept.length === page.units.length) {
      draft.phraseEdits[index] = { text: typeof edit.text === 'string' ? edit.text.trim().slice(0, 500) : null,
        kept: edit.kept.map(keep => keep === true) };
    }
    const saved = value.sequences?.[index];
    if (Array.isArray(saved) && saved.length === page.units.length) {
      draft.sequences[index] = saved.map(sound => {
        const alias = draftAliasReplacements.get(sound) ?? sound;
        return SOUND_IDS.includes(alias) ? alias : null;
      });
      draft.confirmed[index] = value.confirmed?.[index] === true &&
        draft.sequences[index].every((sound, slot) => draft.phraseEdits[index]?.kept[slot] || SOUND_IDS.includes(sound));
    }
  });
  draft.current = nearestActivePhrase(draft, Number.isInteger(value.current) ? value.current : 0);
  for (const name of ['backingGain', 'soundGain']) {
    if (Number.isFinite(value[name])) draft[name] = Math.max(0, Math.min(1.5, value[name]));
  }
  return draft;
}

export function migrateDraft(project, previous) {
  const migration = project.arrangementMigration;
  if (!migration || previous?.fingerprint !== migration.fingerprint) return emptyDraft(project);
  const oldSlots = new Map();
  migration.phrases.forEach((units, index) => units.forEach((id, slot) => oldSlots.set(id, { index, slot })));
  const draft = emptyDraft(project);
  const distance = project.phrases.map((page, index) => {
    const ids = page.units.map(id => migration.previousUnitIds[id]);
    const sources = ids.map(id => oldSlots.get(id));
    const origin = sources[0]?.index;
    const oldPage = migration.phrases[origin];
    const samePage = oldPage?.length === ids.length && ids.every((id, slot) => id === oldPage[slot]);
    draft.sequences[index] = sources.map(src => src ? previous.sequences?.[src.index]?.[src.slot] ?? null : null);
    if (sources.every(src => src && previous.deleted?.[src.index] === true)) draft.deleted[index] = true;
    const kept = sources.map(src => !!src && (previous.deleted?.[src.index] === true ||
      previous.phraseEdits?.[src.index]?.kept?.[src.slot] === true));
    const text = samePage ? previous.phraseEdits?.[origin]?.text ?? null : null;
    if (text || kept.some(Boolean)) draft.phraseEdits[index] = { text, kept };
    draft.confirmed[index] = sources.every(src => src && previous.confirmed?.[src.index] === true);
    return Math.min(...sources.filter(Boolean).map(src => Math.abs(src.index - (previous.current ?? 0))));
  });
  const closest = Math.min(...distance);
  return restoreDraft(project, { ...draft, current: closest < Infinity ? distance.indexOf(closest) : draft.current,
    backingGain: previous.backingGain, soundGain: previous.soundGain });
}
export function repeatPattern(sequence) {
  const pattern = sequence.filter(Boolean);
  return pattern.length ? sequence.map((_, i) => pattern[i % pattern.length]) : [...sequence];
}
export const phraseDeleted = (draft, index) => draft.deleted?.[index] === true;
export const keepOriginal = (draft, phraseIndex, index) => phraseDeleted(draft, phraseIndex) || draft.phraseEdits?.[phraseIndex]?.kept[index] === true;
export const phraseFilled = (draft, index) =>
  draft.sequences[index].every((sound, slot) => keepOriginal(draft, index, slot) || SOUND_IDS.includes(sound));
export const phraseKept = (draft, index) => phraseDeleted(draft, index) || draft.phraseEdits?.[index]?.kept.every(Boolean) === true;
export function complete(project, draft) {
  return project.phrases.length > 0 && project.phrases.every((page, i) => (draft.confirmed[i] || phraseKept(draft, i)) &&
    draft.sequences[i]?.length === page.units.length && phraseFilled(draft, i));
}
export const isNativeRenderProject = project => project?.renderMode === 'openutau-ustx' && project?.pipeline === 'vocal2midi-ustx-v1';
export function nativeRenderPayload(project, draft) {
  return { songId: project.id, fingerprint: project.fingerprint,
    sequences: draft.sequences.map((sequence, i) => sequence.map((sound, slot) => keepOriginal(draft, i, slot) ? KEEP_ORIGINAL : sound)),
    confirmed: draft.confirmed.map((confirmed, i) => confirmed || phraseKept(draft, i)),
    backingGain: draft.backingGain, soundGain: draft.soundGain };
}
export function nativePhrasePayload(project, draft, phraseIndex) {
  return { ...nativeRenderPayload(project, draft), phraseIndex };
}
export const nativeRenderSnapshot = (project, draft) => JSON.stringify(nativeRenderPayload(project, draft));
