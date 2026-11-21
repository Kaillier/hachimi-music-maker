import { SOUND_IDS, LABELS, SOUND_PACKS, DEFAULT_SOUND_PACK, SAMPLE_RATE, emptyDraft, restoreDraft, migrateDraft, repeatPattern, keepOriginal, phraseFilled, phraseKept, phraseDeleted, nearestActivePhrase, complete, isNativeRenderProject, nativeRenderPayload, nativePhrasePayload } from './audio-core.js';

const $ = id => document.getElementById(id);
const state = { catalog: null, project: null, draft: null, ready: false, audioReady: false, selected: 0, history: [],
  source: null, playback: null, generation: 0, ctx: null,
  previewCache: { mix: null, jobs: new Map(), decoded: null },
  samples: {}, sampleLoads: {}, original: null, decoder: null, storageOK: true, soundPack: DEFAULT_SOUND_PACK,
  remote: { status: 'idle', id: null, error: null, wavUrl: null, ustxUrl: null, token: 0, snapshot: null, controller: null } };
const icons = () => window.lucide?.createIcons();
const clock = t => Math.floor(Math.max(0, t) / 60).toString().padStart(2, '0') + ':' +
  Math.floor(Math.max(0, t) % 60).toString().padStart(2, '0');
const current = () => state.draft.current;
const phrase = () => state.project.phrases[current()];
const cleanLyrics = text => (text || '').trim().replace(/(\p{Script=Han})\s+(?=\p{Script=Han})/gu, '$1');
const phraseLyrics = (p, index) => {
  const edit = state.draft.phraseEdits[index];
  const filtered = !p.lyricsUnaligned && edit?.kept.some(Boolean) && !phraseKept(state.draft, index);
  return cleanLyrics(edit?.text ?? (filtered ? p.units.filter((_, i) => !edit.kept[i])
    .map(id => state.project.units[id].text).join(' ') : p.text));
};
const sequence = () => state.draft.sequences[current()] || [];
const isKept = index => keepOriginal(state.draft, current(), index);
const key = () => 'hachimi-arrangement:' + (state.project.arrangementFingerprint || state.project.fingerprint);
const renderBusy = () => state.remote.status === 'queued' || state.remote.status === 'running';
const renderCurrent = (token, snapshot) => state.remote.token === token && state.remote.snapshot === snapshot;
const auditionOnly = () => $('sound-mode-audition').checked;
const phraseAutoplay = $('phrase-autoplay');
const phraseAutoplayKey = 'hachimi-phrase-autoplay';
const firstEditable = sounds => {
  const empty = sounds.findIndex((sound, i) => !isKept(i) && !sound);
  return empty >= 0 ? empty : sounds.findIndex((_, i) => !isKept(i));
};
const packTones = {
  dagoujiao: 'copper', chuqujian: 'blue', daixingfenji: 'yellow',
  daiyiduan: 'violet', daishuji: 'gold', hesuan: 'teal', axiga: 'plum',
  wonanbeiluduo: 'teal', hayeguonailong: 'gold', omajili: 'blue', wasai: 'coral', youda: 'gold', zabu: 'violet',
};
const soundTones = new Map(SOUND_PACKS.flatMap(({ id, pattern }) =>
  packTones[id] ? pattern.map(sound => [sound, packTones[id]]) : []));
soundTones.set('clip_ding', 'coral');
soundTones.set('clip_dong', 'yellow');
soundTones.set('clip_ji2', 'blue');
soundTones.set('clip_dai2', packTones.daixingfenji);
const soundAttributes = (id, tone = soundTones.get(id)) => (tone ? ' data-tone="' + tone + '"' : '') + ' data-sound="' + id + '"';

function report(error) {
  $('error').textContent = error?.message || String(error);
  $('error').hidden = false;
}
function save() {
  try { localStorage.setItem(key(), JSON.stringify(state.draft)); }
  catch { state.storageOK = false; }
}
function invalidateRemoteResult() {
  if (renderBusy()) return;
  state.remote.status = 'idle';
  state.remote.id = null;
  state.remote.error = null;
  state.remote.wavUrl = null;
  state.remote.ustxUrl = null;
  state.remote.kind = null;
  state.remote.snapshot = null;
}
function attempt(action) {
  return async (...args) => {
    try { $('error').hidden = true; await action(...args); }
    catch (error) { report(error); }
  };
}
function bind(id, action) { $(id).addEventListener('click', attempt(action)); }

function stop() {
  state.generation++;
  if (state.source) {
    state.source.onended = null;
    try { state.source.stop(); } catch { /* A finished source is already stopped. */ }
    state.source.disconnect();
  }
  state.source = null;
  state.playback = null;
  $('stop').disabled = true;
  document.querySelectorAll('.slot.playing').forEach(el => el.classList.remove('playing'));
  if (state.ready) { draw(); $('status').textContent = '音频就绪'; }
}

async function play(buffer, offset = 0, duration = buffer.duration, kind = 'sample', songOffset = 0) {
  stop();
  const generation = state.generation;
  state.ctx ??= new AudioContext();
  await state.ctx.resume();
  if (generation !== state.generation) return;
  const source = state.ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(state.ctx.destination);
  state.source = source;
  state.playback = { kind, started: state.ctx.currentTime, songOffset, duration };
  source.onended = () => {
    if (state.source !== source) return;
    source.disconnect();
    state.source = null;
    state.playback = null;
    $('stop').disabled = true;
    $('status').textContent = '音频就绪';
    document.querySelectorAll('.slot.playing').forEach(el => el.classList.remove('playing'));
    draw();
  };
  source.start(0, offset, Math.min(duration, buffer.duration - offset));
  $('stop').disabled = false;
  $('status').textContent = { original: '正在播放原段', preview: '正在试听改编', full: '正在试听整首', sample: '音效试听' }[kind];
}

async function original() {
  const p = phrase();
  if (!p) return;
  await play(state.original, p.start, p.end - p.start, 'original', p.start);
}
async function preview() {
  if (!phrase() || !phraseFilled(state.draft, current())) return;
  await requestNativeAudio('/api/preview', nativePhrasePayload(state.project, state.draft, current()), 'preview');
}

function rememberPhrase() {
  const index = current();
  state.history[index] ??= [];
  state.history[index].push({ sounds: [...sequence()], edit: state.draft.phraseEdits[index], confirmed: state.draft.confirmed[index] });
  if (state.history[index].length > 100) state.history[index].shift();
}

function changeSequence(next, selected = state.selected) {
  if (renderBusy() || !phrase()) return;
  stop();
  const index = current();
  rememberPhrase();
  state.draft.sequences[index] = next;
  state.draft.confirmed[index] = false;
  invalidateRemoteResult();
  state.selected = selected;
  save(); render();
}

function editPhrase(text, kept) {
  const index = current();
  const existing = state.draft.phraseEdits[index];
  if ((existing?.text ?? null) === text && kept.every((keep, i) => keep === isKept(i))) return;
  rememberPhrase();
  const audioChanged = kept.some((keep, i) => keep !== isKept(i));
  state.draft.phraseEdits[index] = !text && !kept.some(Boolean) ? null : { text, kept };
  if (audioChanged) {
    stop();
    state.draft.confirmed[index] = false;
    state.selected = firstEditable(sequence());
    invalidateRemoteResult();
  }
  save(); render();
}
async function playSample(id) {
  stop();
  const generation = state.generation;
  if (!state.samples[id]) {
    state.sampleLoads[id] ??= loadAudio('/api/sounds/' + id, state.decoder).finally(() => { delete state.sampleLoads[id]; });
    state.samples[id] = await state.sampleLoads[id];
  }
  if (generation === state.generation) await play(state.samples[id]);
}
async function choose(id) {
  if (renderBusy() || !state.ready || !state.audioReady || !SOUND_IDS.includes(id)) return;
  if (auditionOnly()) return playSample(id);
  const index = state.selected;
  if (index < 0 || isKept(index)) return;
  const next = [...sequence()];
  const changed = next[index] !== id;
  next[index] = id;
  const following = next.findIndex((_, i) => i > index && !isKept(i));
  const selected = following >= 0 ? following : next.findIndex((sound, i) => !sound && !isKept(i));
  if (changed) changeSequence(next, selected);
  else { state.selected = selected; render(); }
  if ($('audition').checked) await playSample(id);
}
function neighborPhrase(direction) {
  if (current() < 0) return -1;
  for (let i = current() + direction; i >= 0 && i < state.project.phrases.length; i += direction) {
    if (!phraseDeleted(state.draft, i)) return i;
  }
  return -1;
}
function scrollToCurrentPhrase() {
  $('phrases').querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
async function selectPhrase(index, autoplay = true) {
  if (renderBusy() || !state.ready || !state.project.phrases[index] || phraseDeleted(state.draft, index)) return;
  stop();
  state.draft.current = index;
  state.selected = firstEditable(sequence());
  save(); render();
  scrollToCurrentPhrase();
  if (autoplay && phraseAutoplay.checked && state.audioReady) await original();
}
async function confirm() {
  if (renderBusy() || !state.ready || !phrase() || !phraseFilled(state.draft, current())) return;
  stop();
  state.draft.confirmed[current()] = true;
  save(); render();
  const next = neighborPhrase(1);
  if (next >= 0) await selectPhrase(next);
  else $('export').focus();
}

function setPhraseDeleted(index, deleted) {
  if (renderBusy() || !state.ready || !state.project.phrases[index] || phraseDeleted(state.draft, index) === deleted) return;
  stop();
  state.draft.deleted[index] = deleted;
  state.draft.current = nearestActivePhrase(state.draft, index);
  state.selected = firstEditable(sequence());
  invalidateRemoteResult();
  save(); render(); scrollToCurrentPhrase();
  $(phrase() ? 'phrase-title' : 'show-deleted-phrases').focus({ preventScroll: true });
}

async function generatePattern(pattern) {
  if (renderBusy() || !state.ready || !state.audioReady || !phrase() || !isNativeRenderProject(state.project)) return;
  stop();
  let cursor = 0;
  state.history = [];
  state.draft.sequences = state.draft.sequences.map((sounds, index) => sounds.map((sound, slot) =>
    keepOriginal(state.draft, index, slot) ? sound : pattern[cursor++ % pattern.length]));
  state.draft.confirmed = state.draft.confirmed.map((confirmed, i) => phraseDeleted(state.draft, i) ? confirmed : true);
  state.draft.current = nearestActivePhrase(state.draft, 0);
  state.selected = firstEditable(sequence());
  invalidateRemoteResult();
  save(); render();
  await requestNativeAudio('/api/render', nativeRenderPayload(state.project, state.draft), 'export');
}

function renderSoundPads() {
  const hachimiIds = new Set(['axiga', 'wonanbeiluduo', 'hayeguonailong']);
  const dingdongIds = new Set(['dingdongji', 'dagoujiao', 'chuqujian', 'daixingfenji', 'daiyiduan', 'daishuji', 'hesuan']);
  const manboIds = new Set(['omajili', 'wasai', 'youda', 'zabu']);
  const isManboSound = id => id === 'man' || id === 'bo';
  const hachimi = { id: 'hachimi', label: '哈基米', pattern: DEFAULT_SOUND_PACK.pattern.filter(id => !isManboSound(id)) };
  const manbo = { id: 'manbo', label: '曼波', pattern: DEFAULT_SOUND_PACK.pattern.filter(isManboSound) };
  const renderPack = pack => {
    const title = 'sound-group-' + pack.id;
    const tone = pack.id === 'daiyiduan' ? packTones.daiyiduan : undefined;
    const pads = [...new Set(pack.pattern)].map(id => '<button type="button" class="sound-pad"' + soundAttributes(id, tone) +
      '><strong>' + LABELS[id] + '</strong></button>').join('');
    return '<section class="sound-group" aria-labelledby="' + title + '"><h4 id="' + title + '">' + pack.label +
      '</h4><div class="sound-group-pads">' + pads + '</div></section>';
  };
  const renderGroups = packs => '<div class="sound-groups">' + packs.map(renderPack).join('') + '</div>';
  const renderFamily = (id, name, packs, width, height) => {
    return '<section class="sound-family" id="sound-family-' + id + '" aria-label="' + name + '">' + renderGroups(packs) +
      '<img class="sound-family-art" src="/images/' + id + '.png" width="' + width + '" height="' + height +
      '" alt="" loading="lazy" decoding="async"></section>';
  };
  const hachimiPacks = SOUND_PACKS.filter(pack => hachimiIds.has(pack.id));
  const dingdongPacks = SOUND_PACKS.filter(pack => dingdongIds.has(pack.id));
  const manboPacks = SOUND_PACKS.filter(pack => manboIds.has(pack.id));
  const grouped = new Set([...hachimiPacks, ...dingdongPacks, ...manboPacks, DEFAULT_SOUND_PACK]);
  const remaining = SOUND_PACKS.filter(pack => !grouped.has(pack));
  $('sounds').innerHTML = renderFamily('hachimi', '哈基米', [hachimi, ...hachimiPacks], 423, 392) +
    renderFamily('manbo', '曼波', [manbo, ...manboPacks], 803, 804) +
    renderFamily('dingdongji', '叮咚鸡', dingdongPacks, 1132, 1044) +
    (remaining.length ? renderGroups(remaining) : '');
}

function renderControls() {
  const p = phrase();
  const currentKept = phraseKept(state.draft, current());
  const unitCount = p?.units.length ?? 0;
  const replaceCount = p?.units.filter((_, i) => !isKept(i)).length ?? 0;
  const filled = sequence().filter((sound, i) => sound && !isKept(i)).length;
  const deletedCount = state.draft.deleted.filter(Boolean).length;
  const total = state.project.phrases.length - deletedCount;
  const count = state.draft.confirmed.filter((confirmed, i) => !phraseDeleted(state.draft, i) &&
    (confirmed || phraseKept(state.draft, i))).length;
  const isComplete = complete(state.project, state.draft);
  const nativeProject = isNativeRenderProject(state.project);
  const busy = renderBusy();
  $('phase').textContent = currentKept ? '保留原声' : state.draft.confirmed[current()] ? '已确认' : filled === replaceCount ? '待确认' : '待编排';
  $('slot-count').textContent = filled + ' / ' + replaceCount + (replaceCount < unitCount ? ' · ' + (unitCount - replaceCount) + ' 格保留原声' : '');
  $('completed').textContent = count + ' / ' + total;
  $('progress').max = total || 1;
  $('progress').value = count;
  $('original').disabled = !p || busy || !state.audioReady;
  $('preview').disabled = !p || busy || !state.audioReady || filled !== replaceCount;
  $('confirm').disabled = !p || busy || filled !== replaceCount;
  $('edit-phrase').disabled = !p || busy;
  $('delete-phrase').disabled = !p || busy;
  $('show-deleted-phrases').hidden = !deletedCount;
  $('show-deleted-phrases').disabled = busy;
  $('deleted-phrase-count').textContent = '已删除 (' + deletedCount + ')';
  const nextLabel = phraseAutoplay.checked ? '确认并听下一段' : '确认并进入下一段';
  $('confirm').innerHTML = neighborPhrase(1) < 0
    ? '确认最后一段<i data-lucide="check" aria-hidden="true"></i>' : nextLabel + '<i data-lucide="arrow-right" aria-hidden="true"></i>';
  $('previous').disabled = busy || neighborPhrase(-1) < 0;
  $('undo').disabled = busy || !state.history[current()]?.length;
  $('clear').disabled = busy || !filled;
  $('remove').disabled = busy || state.selected < 0 || !sequence()[state.selected];
  $('repeat').disabled = busy || !filled || filled === replaceCount;
  $('full-play').disabled = busy || !state.audioReady || !isComplete;
  $('full-play').innerHTML = '<i data-lucide="headphones"></i>原生试听';
  $('export').disabled = busy || !state.audioReady || !isComplete || !nativeProject;
  $('export').innerHTML = state.remote.status === 'failed'
    ? '<i data-lucide="rotate-cw"></i>重试生成'
    : busy ? '<i data-lucide="loader-circle"></i>生成中…'
    : '<i data-lucide="download"></i>导出 WAV';
  if (busy) $('export-status').textContent = state.remote.reusingPreview ? '正在读取已渲染的试听…' : state.remote.kind === 'preview'
    ? 'OpenUtau 正在渲染本段试听…请勿编辑当前编排'
    : state.remote.kind === 'full'
      ? 'OpenUtau 正在渲染整首试听…请勿编辑当前编排'
      : 'OpenUtau 正在生成 WAV…请勿编辑当前编排';
  else if (state.remote.status === 'failed') $('export-status').textContent = '生成失败：' + state.remote.error + ' · 点击“重试生成”';
  else if (state.remote.status === 'completed' && state.remote.kind === 'export') $('export-status').textContent = 'OpenUtau WAV 已生成 · 可重新生成';
  else $('export-status').textContent = !total ? '整首保留原声' : isComplete ? '全部编排段已确认 · 最终导出使用 OpenUtau 原生渲染' : count + ' / ' + total + ' 段已确认';
  $('draft-status').textContent = state.storageOK ? '草稿已保存在本机' : '浏览器无法保存草稿';
  const sampleMode = auditionOnly();
  document.querySelectorAll('.sound-pad').forEach(el => { el.disabled = busy || !state.audioReady || (!sampleMode && state.selected < 0); });
  $('audition').disabled = busy || !state.audioReady || sampleMode;
  $('reset').disabled = busy || !state.ready;
  $('sound-pack').disabled = busy || !state.audioReady;
  $('pack-render').disabled = !total || busy || !state.audioReady || !nativeProject;
  $('song-select').disabled = busy;
  for (const prefix of ['backing', 'sound']) $(prefix + '-gain').disabled = busy;
  icons();
}
function renderPhraseNav() {
  $('phrases').replaceChildren(...state.project.phrases.flatMap((p, index) => {
    if (phraseDeleted(state.draft, index)) return [];
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.phrase = index;
    button.setAttribute('aria-current', String(index === current()));
    const number = document.createElement('span');
    number.className = 'phrase-number';
    number.textContent = String(index + 1).padStart(2, '0');
    const copy = document.createElement('span');
    copy.className = 'phrase-copy';
    const lyrics = document.createElement('span');
    lyrics.className = 'phrase-lyrics';
    lyrics.textContent = phraseLyrics(p, index) || '第 ' + (index + 1) + ' 段';
    const meta = document.createElement('small');
    meta.textContent = clock(p.start) + ' · ' + (phraseKept(state.draft, index) ? '保留原声' : p.units.length + ' 单元');
    copy.append(lyrics, meta);
    const marker = document.createElement(state.draft.confirmed[index] ? 'i' : 'span');
    if (state.draft.confirmed[index]) marker.dataset.lucide = 'check';
    button.append(number, copy, marker);
    return button;
  }));
}
function render() {
  if (!state.ready) return;
  const p = phrase();
  $('active-phrase').hidden = !p;
  $('phrase-sounds').hidden = !p;
  $('empty-phrases').hidden = Boolean(p);
  renderPhraseNav();
  if (!p) {
    $('slots').replaceChildren();
    renderControls(); draw(); return;
  }
  const lyrics = phraseLyrics(p, current());
  $('phrase-title').textContent = '第 ' + String(current() + 1).padStart(2, '0') + ' 段' + (lyrics ? ' · ' + lyrics : '');
  $('phrase-range').textContent = clock(p.start) + ' — ' + clock(p.end) + ' / ' + (p.end - p.start).toFixed(1) + ' 秒';
  $('slots').innerHTML = p.units.map((id, i) => {
    if (isKept(i)) return '';
    const value = sequence()[i];
    const unit = state.project.units[id];
    return '<button class="slot" data-index="' + i + '"' + (value ? soundAttributes(value) : '') +
      ' aria-pressed="' + (state.selected === i) + '" title="单元 ' + (i + 1) + ' · ' + (unit.end - unit.start).toFixed(2) +
      ' 秒" aria-label="单元 ' + (i + 1) + '，' + (value ? LABELS[value] : '未选择') + '">' +
      '<small>' + String(i + 1).padStart(2, '0') + '</small><strong>' + (value ? LABELS[value] : '·') + '</strong></button>';
  }).join('');
  renderControls(); draw();
}

function draw(songTime = null) {
  const canvas = $('waveform');
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(devicePixelRatio || 1, 2);
  const width = Math.round(rect.width * ratio);
  const height = Math.round(rect.height * ratio);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  if (!state.project || !state.draft) return;
  const p = phrase();
  const toX = t => t / state.project.duration * width;
  if (p) {
    ctx.fillStyle = '#dbece2';
    ctx.fillRect(toX(p.start), 0, toX(p.end - p.start), height);
  }
  const wave = state.project.waveform;
  const bars = Math.max(1, Math.floor(rect.width / 3));
  for (let i = 0; i < bars; i++) {
    const peak = wave[Math.min(wave.length - 1, Math.floor(i / bars * wave.length))];
    const size = Math.max(2, peak * height * .85);
    const time = i / bars * state.project.duration;
    ctx.fillStyle = p && time >= p.start && time <= p.end ? '#287656' : '#a8b5ae';
    ctx.fillRect(i / bars * width, (height - size) / 2, ratio, size);
  }
  if (songTime !== null) {
    ctx.fillStyle = '#b35452'; ctx.fillRect(toX(songTime), 0, 2 * ratio, height);
  }
}
function animate() {
  const playback = state.playback;
  if (playback && playback.kind !== 'sample') {
    const elapsed = Math.min(playback.duration, state.ctx.currentTime - playback.started);
    const time = playback.songOffset + elapsed;
    $('play-time').textContent = clock(time);
    draw(time);
    document.querySelectorAll('.slot').forEach(el => {
      const unit = state.project.units[phrase().units[Number(el.dataset.index)]];
      el.classList.toggle('playing', time >= unit.start && time < unit.end);
    });
  }
  requestAnimationFrame(animate);
}

async function loadAudio(file, decoder) {
  const url = file;
  const response = await fetch(url);
  if (!response.ok) throw new Error('音频缺失：' + file + ' (' + response.status + ')');
  return decoder.decodeAudioData(await response.arrayBuffer());
}
async function init() {
  icons();
  const catalogResponse = await fetch('/api/projects');
  if (!catalogResponse.ok) throw new Error('无法读取本地歌曲工程');
  state.catalog = await catalogResponse.json();
  const titleCounts = new Map();
  for (const song of state.catalog.songs) titleCounts.set(song.title, (titleCounts.get(song.title) || 0) + 1);
  const timestamp = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  $('song-select').replaceChildren(...state.catalog.songs.map(song => {
    const date = new Date(song.createdAt);
    const option = document.createElement('option');
    option.value = song.id;
    option.textContent = titleCounts.get(song.title) > 1 && !Number.isNaN(date.getTime())
      ? song.title + ' · ' + timestamp.format(date) : song.title;
    return option;
  }));
  if (!state.catalog.songs.length) {
    $('empty-state').hidden = false; $('studio').hidden = true;
    $('status').textContent = '尚无歌曲工程'; return;
  }
  const requestedId = new URLSearchParams(location.search).get('song');
  const entry = state.catalog.songs.find(song => song.id === requestedId) || state.catalog.songs[0];
  const response = await fetch(entry.project);
  if (!response.ok) throw new Error('无法读取歌曲工程');
  const project = await response.json();
  if (!isNativeRenderProject(project) || project.sampleRate !== SAMPLE_RATE || !project.phrases?.length) throw new Error('不是有效的 Vocal2Midi USTX 工程');
  state.project = project;
  $('studio').hidden = false; $('empty-state').hidden = true;
  $('song-select').value = project.id; $('song-select').disabled = false;
  $('song-select').addEventListener('change', event => { location.assign('/arrange?song=' + encodeURIComponent(event.target.value)); });
  state.draft = emptyDraft(project);
  try {
    const saved = JSON.parse(localStorage.getItem(key()));
    if (saved) state.draft = restoreDraft(project, saved);
    else if (project.arrangementMigration) {
      const old = localStorage.getItem('hachimi-arrangement:' + project.arrangementMigration.key);
      state.draft = migrateDraft(project, JSON.parse(old));
    }
  } catch { /* Ignore invalid local drafts. */ }
  $('source-score').href = project.scoreFile + '?download';
  $('source-vocals').href = project.vocalsUrl;
  state.selected = firstEditable(sequence());
  state.ready = true;
  document.title = (project.title || 'Hachimi') + ' | Hachimi 编排台';
  $('song-title').firstChild.textContent = project.title || 'Hachimi';
  $('song-subtitle').textContent = project.subtitle || '';
  $('song-artist').textContent = project.artist || '';
  $('analysis-summary').textContent = project.phrases.length + ' 段 · ' + project.units.length + ' 单元';
  for (const id of ['total-time', 'end-time']) $(id).textContent = clock(project.duration);
  $('middle-time').textContent = clock(project.duration / 2);
  $('reset').disabled = false;
  $('status').textContent = '正在载入原曲…';
  save(); render();

  state.decoder = new OfflineAudioContext(2, 1, SAMPLE_RATE);
  const [original] = await Promise.all([loadAudio(project.originalFile, state.decoder)]);
  state.original = original;
  state.audioReady = true;
  $('sound-pack').innerHTML = SOUND_PACKS.map(pack => '<option value="' + pack.id + '">' + pack.label + '</option>').join('');
  $('sound-pack').value = state.soundPack.id;
  renderSoundPads();
  $('sounds').addEventListener('click', attempt(event => {
    if (renderBusy()) return;
    const button = event.target.closest('button[data-sound]');
    if (button) return choose(button.dataset.sound);
  }));
  $('slots').addEventListener('click', event => {
    if (renderBusy()) return;
    const button = event.target.closest('button[data-index]');
    if (button) { state.selected = Number(button.dataset.index); render(); }
  });
  $('phrases').addEventListener('click', attempt(event => {
    if (renderBusy()) return;
    const button = event.target.closest('button[data-phrase]');
    if (button) return selectPhrase(Number(button.dataset.phrase));
  }));
  for (const [prefix, property] of [['backing', 'backingGain'], ['sound', 'soundGain']]) {
    $(prefix + '-gain').value = state.draft[property];
    $(prefix + '-value').textContent = Math.round(state.draft[property] * 100) + '%';
    $(prefix + '-gain').addEventListener('input', () => {
      if (renderBusy()) return;
      stop(); state.draft[property] = Number($(prefix + '-gain').value);
      invalidateRemoteResult();
      $(prefix + '-value').textContent = Math.round(state.draft[property] * 100) + '%';
      save(); renderControls();
    });
  }
  $('status').textContent = '音频就绪';
  save(); render();
  new ResizeObserver(() => draw()).observe($('waveform'));
  animate();
  await registerTools();
}

try { phraseAutoplay.checked = localStorage.getItem(phraseAutoplayKey) !== 'false'; }
catch { /* Use the default on browsers that block local storage. */ }
phraseAutoplay.addEventListener('change', () => {
  try { localStorage.setItem(phraseAutoplayKey, String(phraseAutoplay.checked)); }
  catch { /* Keep the preference for the current page. */ }
  if (state.ready) renderControls();
});

bind('original', original);
bind('preview', preview);
bind('stop', stop);
bind('previous', () => selectPhrase(neighborPhrase(-1)));
bind('confirm', confirm);
const phraseDialog = $('edit-phrase-dialog');
const phraseEditFields = () => [...$('edit-phrase-units').querySelectorAll('input')];
bind('edit-phrase', () => {
  if (renderBusy()) return;
  const p = phrase();
  $('edit-phrase-title').textContent = '编辑第 ' + (current() + 1) + ' 段';
  $('edit-phrase-lyrics').value = state.draft.phraseEdits[current()]?.text ?? '';
  $('edit-phrase-lyrics').placeholder = phraseLyrics(p, current());
  $('edit-phrase-units').replaceChildren(...p.units.map((unitId, index) => {
    const unit = state.project.units[unitId];
    const label = document.createElement('label');
    label.title = clock(unit.start) + ' · ' + (unit.end - unit.start).toFixed(2) + ' 秒';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = isKept(index);
    const text = document.createElement('span');
    text.textContent = (index + 1) + ' · ' + (unit.text || '—');
    label.append(input, text);
    return label;
  }));
  phraseDialog.showModal();
});
bind('keep-phrase', () => phraseEditFields().forEach(input => { input.checked = true; }));
bind('restore-phrase', () => phraseEditFields().forEach(input => { input.checked = false; }));
bind('cancel-edit-phrase', () => phraseDialog.close());
$('edit-phrase-form').addEventListener('submit', attempt(event => {
  event.preventDefault();
  if (renderBusy()) return;
  editPhrase($('edit-phrase-lyrics').value.trim() || null, phraseEditFields().map(input => input.checked));
  phraseDialog.close();
}));
const deletePhraseDialog = $('delete-phrase-dialog');
const deletedPhrasesDialog = $('deleted-phrases-dialog');
bind('delete-phrase', () => {
  if (renderBusy() || !phrase()) return;
  $('delete-phrase-target').textContent = $('phrase-title').textContent;
  deletePhraseDialog.returnValue = '';
  deletePhraseDialog.showModal();
});
deletePhraseDialog.addEventListener('close', () => {
  if (deletePhraseDialog.returnValue === 'delete') setPhraseDeleted(current(), true);
});
bind('show-deleted-phrases', () => {
  if (renderBusy()) return;
  $('deleted-phrase-list').replaceChildren(...state.project.phrases.flatMap((p, index) => {
    if (!phraseDeleted(state.draft, index)) return [];
    const row = document.createElement('li');
    const text = document.createElement('span');
    const lyrics = phraseLyrics(p, index);
    text.textContent = '第 ' + (index + 1) + ' 段 · ' + clock(p.start) + (lyrics ? ' · ' + lyrics : '');
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.textContent = '恢复';
    restore.setAttribute('aria-label', '恢复第 ' + (index + 1) + ' 段');
    restore.addEventListener('click', () => {
      deletedPhrasesDialog.close();
      setPhraseDeleted(index, false);
    });
    row.append(text, restore);
    return row;
  }));
  deletedPhrasesDialog.showModal();
});
bind('clear', () => {
  const cleared = sequence().map((sound, i) => isKept(i) ? sound : null);
  changeSequence(cleared, firstEditable(cleared));
});
bind('remove', () => {
  if (state.selected < 0) return;
  const next = [...sequence()]; next[state.selected] = null;
  changeSequence(next);
});
bind('repeat', () => {
  const active = repeatPattern(sequence().filter((_, i) => !isKept(i)));
  let cursor = 0;
  changeSequence(sequence().map((sound, i) => isKept(i) ? sound : active[cursor++]), -1);
});
bind('undo', () => {
  const previous = state.history[current()]?.pop();
  if (!previous) return;
  const changed = sequence().findIndex((sound, index) => sound !== previous.sounds[index] || isKept(index) !== (previous.edit?.kept[index] === true));
  stop(); state.draft.sequences[current()] = previous.sounds;
  state.draft.phraseEdits[current()] = previous.edit;
  state.draft.confirmed[current()] = previous.confirmed;
  state.selected = changed >= 0 && !isKept(changed) ? changed : firstEditable(previous.sounds);
  invalidateRemoteResult();
  save(); render();
});
bind('reset', () => $('reset-dialog').showModal());
$('reset-dialog').addEventListener('close', () => {
  if ($('reset-dialog').returnValue !== 'reset' || renderBusy()) return;
  stop(); state.draft = emptyDraft(state.project); state.history = []; state.selected = 0;
  invalidateRemoteResult();
  for (const prefix of ['backing', 'sound']) { $(prefix + '-gain').value = .5; $(prefix + '-value').textContent = '50%'; }
  save(); render();
});
bind('full-play', async () => {
  if (renderBusy() || !complete(state.project, state.draft)) return;
  await requestNativeAudio('/api/full-preview', nativeRenderPayload(state.project, state.draft), 'full');
});

async function responseData(response, fallback) {
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || fallback + '（HTTP ' + response.status + '）');
  return data;
}

function validateRenderJob(job) {
  if (!job || !job.id || !['queued', 'running', 'completed', 'failed'].includes(job.status)) {
    throw new Error('服务器返回了无效的渲染任务状态');
  }
  return job;
}

function waitForRenderPoll(signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 700);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Render request aborted', 'AbortError'));
    }, { once: true });
  });
}

function downloadServerWav(url) {
  if (!url) throw new Error('服务器已完成渲染，但没有返回 wavUrl');
  const link = document.createElement('a');
  const safeTitle = (state.project.title || '音乐').replace(/[\\/:*?"<>|]/g, '_');
  link.href = new URL(url, document.baseURI).href;
  link.download = safeTitle + '-我的音效编排.wav';
  link.rel = 'noopener';
  document.body.append(link); link.click(); link.remove();
}

async function pollRenderJob(token, snapshot, id, controller, job) {
  while (job.status === 'queued' || job.status === 'running') {
    if (!renderCurrent(token, snapshot)) return;
    state.remote.status = job.status;
    state.remote.id = id;
    renderControls();
    await waitForRenderPoll(controller.signal);
    if (!renderCurrent(token, snapshot)) return;
    const response = await fetch('/api/render/' + encodeURIComponent(id), { signal: controller.signal });
    job = validateRenderJob(await responseData(response, '查询渲染任务失败'));
  }
  if (!renderCurrent(token, snapshot)) return;
  if (job.status === 'failed') throw new Error(job.error || 'OpenUtau 原生渲染失败');
  return job;
}

async function decodeNativeAudio(url) {
  if (!url) throw new Error('服务器已完成渲染，但没有返回音频地址');
  const response = await fetch(url);
  if (!response.ok) throw new Error('读取 OpenUtau 音频失败（HTTP ' + response.status + '）');
  state.ctx ??= new AudioContext();
  return state.ctx.decodeAudioData(await response.arrayBuffer());
}

async function requestNativeAudio(endpoint, payload, kind) {
  if (renderBusy()) return;
  if (!isNativeRenderProject(state.project)) {
    const error = new Error('当前工程不是 Vocal2Midi USTX，请重新导入歌曲。');
    report(error); renderControls(); return;
  }
  const cache = kind === 'export' ? null : state.previewCache;
  const previewKey = kind === 'preview' ? payload.phraseIndex : 'full';
  const songOffset = kind === 'preview' ? Math.max(0, state.project.phrases[previewKey].start - .15) : 0;
  let cachedJob;
  if (cache) {
    // A preview renders the full score, then crops one section. Confirmations never change that audio.
    const mix = JSON.stringify([payload.songId, payload.fingerprint, payload.sequences, payload.backingGain, payload.soundGain]);
    if (cache.mix !== mix) {
      cache.mix = mix;
      cache.jobs.clear();
      cache.decoded = null;
    }
    cachedJob = cache.jobs.get(previewKey);
    if (cache.decoded?.key === previewKey) {
      const { buffer } = cache.decoded;
      $('error').hidden = true;
      await play(buffer, 0, buffer.duration, kind, songOffset);
      return;
    }
  }
  stop();
  const token = state.remote.token + 1;
  const snapshot = JSON.stringify(payload);
  const controller = new AbortController();
  state.remote = { status: 'queued', kind, id: null, error: null, wavUrl: null, ustxUrl: null,
    token, snapshot, controller, reusingPreview: Boolean(cachedJob) };
  $('error').hidden = true;
  $('status').textContent = cachedJob ? '正在读取已渲染的试听…' : '正在请求本地音频…';
  renderControls();
  try {
    let completed = cachedJob;
    if (!completed) {
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: snapshot, signal: controller.signal,
      });
      const job = validateRenderJob(await responseData(response, '提交渲染任务失败'));
      if (!renderCurrent(token, snapshot)) return;
      state.remote.id = job.id;
      if (job.cached && cache) {
        state.remote.reusingPreview = true;
        $('status').textContent = '正在读取已渲染的试听…';
        renderControls();
      } else if (job.status === 'queued' || job.status === 'running') {
        $('status').textContent = kind === 'preview' ? 'OpenUtau 正在渲染本段试听…' :
          kind === 'full' ? 'OpenUtau 正在渲染整首试听…' : 'OpenUtau 原生渲染已排队…';
      }
      completed = await pollRenderJob(token, snapshot, job.id, controller, job);
    }
    if (!renderCurrent(token, snapshot)) return;
    const buffer = kind === 'export' ? null : await decodeNativeAudio(completed.wavUrl);
    if (!renderCurrent(token, snapshot)) return;
    if (cache) {
      cache.jobs.set(previewKey, completed);
      cache.decoded = { key: previewKey, buffer };
    }
    state.remote.status = 'completed';
    state.remote.id = completed.id;
    state.remote.wavUrl = completed.wavUrl;
    state.remote.ustxUrl = completed.ustxUrl || null;
    state.remote.controller = null;
    renderControls();
    if (kind === 'export') {
      downloadServerWav(completed.wavUrl);
      $('status').textContent = completed.cached ? '已开始下载缓存的 WAV' : 'WAV 已生成并开始下载';
      return;
    }
    await play(buffer, 0, buffer.duration, kind, songOffset);
  } catch (error) {
    if (error?.name === 'AbortError' || !renderCurrent(token, snapshot)) return;
    if (cachedJob) cache.jobs.delete(previewKey);
    state.remote.status = 'failed';
    state.remote.error = error?.message || String(error);
    state.remote.controller = null;
    $('status').textContent = 'OpenUtau 原生渲染失败';
    report(error);
    renderControls();
  }
}

async function requestNativeRender() {
  if (renderBusy() || !complete(state.project, state.draft)) return;
  await requestNativeAudio('/api/render', nativeRenderPayload(state.project, state.draft), 'export');
}

bind('export', requestNativeRender);
bind('pack-render', () => generatePattern(state.soundPack.pattern));
$('sound-pack').addEventListener('change', () => {
  if (renderBusy()) return;
  state.soundPack = SOUND_PACKS.find(pack => pack.id === $('sound-pack').value) || DEFAULT_SOUND_PACK;
  renderControls();
});
for (const mode of ['sound-mode-edit', 'sound-mode-audition']) {
  $(mode).addEventListener('change', () => { if (state.ready) renderControls(); });
}
window.addEventListener('keydown', attempt(event => {
  if (!state.ready || event.repeat || event.altKey || event.ctrlKey || event.metaKey ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) || event.target.isContentEditable ||
    $('reset-dialog').open || phraseDialog.open || deletePhraseDialog.open || deletedPhrasesDialog.open) return;
  if (/^[1-9]$/.test(event.key)) {
    const id = state.soundPack.pattern[Number(event.key) - 1];
    if (id) { event.preventDefault(); return choose(id); }
  }
  if (event.key === 'Escape') stop();
}));

async function registerTools() {
  const context = document.modelContext || navigator.modelContext;
  if (!context?.registerTool) return;
  const lifecycle = new AbortController();
  window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
  const result = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
  try {
    await context.registerTool({ name: 'get_arrangement', description: 'Read the current phrase and sound arrangement.',
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      inputSchema: { type: 'object', properties: {} },
      execute: async () => result({ current: current(), phrases: state.project.phrases, draft: state.draft }) }, { signal: lifecycle.signal });
    await context.registerTool({ name: 'set_phrase_sequence', description: 'Set one sound per detected unit in a phrase. Requires human preview and confirmation before export.',
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      inputSchema: { type: 'object', properties: { phraseIndex: { type: 'integer' }, sounds: { type: 'array', items: { type: 'string', enum: SOUND_IDS } } }, required: ['phraseIndex', 'sounds'] },
      execute: async ({ phraseIndex, sounds }) => {
        if (renderBusy()) throw new Error('OpenUtau 正在生成，暂时不能编辑编排');
        const p = state.project.phrases[phraseIndex];
        if (!Number.isInteger(phraseIndex) || !p || phraseDeleted(state.draft, phraseIndex) ||
            !Array.isArray(sounds) || sounds.length !== p.units.length || !sounds.every(id => SOUND_IDS.includes(id))) throw new Error('Invalid phrase sequence');
        await selectPhrase(phraseIndex, false);
        changeSequence([...sounds], -1);
        return result({ updated: phraseIndex, confirmed: false });
      } }, { signal: lifecycle.signal });
  } catch (error) { console.warn('Optional WebMCP registration unavailable', error); }
}
init().catch(error => { $('status').textContent = '载入失败'; report(error); });
