import { SOUND_IDS, LABELS, SAMPLE_RATE, emptyDraft, restoreDraft, repeatPattern, complete, isNativeRenderProject, nativeRenderPayload, nativePhrasePayload, noteModeEntries, defaultNoteMode, pitchModeEntries, defaultPitchMode, timingModeEntries, defaultTimingMode } from './audio-core.js';

const $ = id => document.getElementById(id);
const state = { catalog: null, project: null, noteMode: 'game-vocal', pitchMode: 'default', timingMode: 'beat', draft: null, ready: false, audioReady: false, selected: 0, history: [],
  previewed: new Set(), source: null, playback: null, generation: 0, ctx: null,
  samples: {}, sampleLoads: {}, original: null, decoder: null, storageOK: true,
  remote: { status: 'idle', id: null, error: null, wavUrl: null, ustxUrl: null, token: 0, snapshot: null, controller: null } };
const icons = () => window.lucide?.createIcons();
const clock = t => Math.floor(Math.max(0, t) / 60).toString().padStart(2, '0') + ':' +
  Math.floor(Math.max(0, t) % 60).toString().padStart(2, '0');
const current = () => state.draft.current;
const phrase = () => state.project.phrases[current()];
const sequence = () => state.draft.sequences[current()];
const key = () => 'hachimi-arrangement:' + (state.project.arrangementFingerprint || state.project.fingerprint);
const renderBusy = () => state.remote.status === 'queued' || state.remote.status === 'running';
const renderCurrent = (token, snapshot) => state.remote.token === token && state.remote.snapshot === snapshot;

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

async function play(buffer, offset = 0, duration = buffer.duration, kind = 'sample', onEnd = null, songOffset = 0) {
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
    onEnd?.();
    draw();
  };
  source.start(0, offset, Math.min(duration, buffer.duration - offset));
  $('stop').disabled = false;
  $('status').textContent = { original: '正在播放原句', preview: '正在试听改编', full: '正在试听整首', sample: '音效试听' }[kind];
}

function toBuffer(channels) {
  const buffer = new AudioBuffer({ numberOfChannels: channels.length, length: channels[0].length, sampleRate: SAMPLE_RATE });
  channels.forEach((channel, i) => buffer.copyToChannel(channel, i));
  return buffer;
}
async function original() {
  const p = phrase();
  await play(state.original, p.start, p.end - p.start, 'original', null, p.start);
}
async function preview() {
  if (!sequence().every(Boolean)) return;
  await requestNativeAudio('/api/preview', nativePhrasePayload(state.project, state.draft, current(), state.noteMode, state.timingMode, state.pitchMode), 'preview', () => {
    state.previewed.add(current());
    renderControls();
  });
}

function changeSequence(next, selected = state.selected) {
  if (renderBusy()) return;
  stop();
  const index = current();
  state.history[index] ??= [];
  state.history[index].push([...sequence()]);
  if (state.history[index].length > 100) state.history[index].shift();
  state.draft.sequences[index] = next;
  state.draft.confirmed[index] = false;
  state.previewed.delete(index);
  invalidateRemoteResult();
  state.selected = selected;
  save(); render();
}
async function choose(id) {
  if (renderBusy() || !state.ready || !state.audioReady || state.selected < 0 || !SOUND_IDS.includes(id)) return;
  const next = [...sequence()];
  next[state.selected] = id;
  const from = state.selected + 1;
  let selected = next.findIndex((s, i) => i >= from && !s);
  if (selected < 0) selected = next.findIndex(s => !s);
  changeSequence(next, selected);
  if ($('audition').checked) {
    state.sampleLoads[id] ??= loadAudio(id + '.wav', state.decoder);
    state.samples[id] = await state.sampleLoads[id];
    await play(state.samples[id]);
  }
}
async function selectPhrase(index, autoplay = true) {
  if (renderBusy() || !state.ready || index < 0 || index >= state.project.phrases.length) return;
  stop();
  state.draft.current = index;
  state.selected = sequence().findIndex(s => !s);
  save(); render();
  $('phrases').querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (autoplay) await original();
}
async function confirm() {
  if (!sequence().every(Boolean) || !state.previewed.has(current())) return;
  stop();
  state.draft.confirmed[current()] = true;
  save(); render();
  if (current() < state.project.phrases.length - 1) await selectPhrase(current() + 1);
  else $('export').focus();
}

async function generateManbo() {
  if (renderBusy() || !state.ready || !state.audioReady || !isNativeRenderProject(state.project)) return;
  stop();
  let cursor = 0;
  state.history = [];
  state.draft.sequences = state.project.phrases.map(p => p.units.map(() => SOUND_IDS[cursor++ % SOUND_IDS.length]));
  state.draft.confirmed = state.project.phrases.map(() => true);
  state.draft.current = 0;
  state.selected = -1;
  state.previewed = new Set();
  invalidateRemoteResult();
  save(); render();
  await requestNativeAudio('/api/render', nativeRenderPayload(state.project, state.draft, state.noteMode, state.timingMode, state.pitchMode), 'export');
}

function changePitchMode(event) {
  if (renderBusy()) { event.target.value = state.pitchMode; return; }
  const mode = event.target.value;
  if (!pitchModeEntries(state.project).some(entry => entry.id === mode) || mode === state.pitchMode) return;
  stop();
  state.pitchMode = mode;
  state.draft.pitchMode = mode;
  state.previewed.clear();
  state.draft.confirmed = state.draft.confirmed.map(() => false);
  invalidateRemoteResult();
  $('status').textContent = '已切换音高模式，请重新试听当前乐句';
  save(); render();
}

function changeNoteMode(event) {
  if (renderBusy()) { event.target.value = state.noteMode; return; }
  const mode = event.target.value;
  if (!noteModeEntries(state.project).some(entry => entry.id === mode) || mode === state.noteMode) return;
  const query = new URLSearchParams({ song: state.project.id, note: mode, timing: state.timingMode, pitch: state.pitchMode });
  location.search = '?' + query.toString();
}

function changeTimingMode(event) {
  if (renderBusy()) { event.target.value = state.timingMode; return; }
  const mode = event.target.value;
  if (!timingModeEntries(state.project, state.noteMode).some(entry => entry.id === mode) || mode === state.timingMode) return;
  const query = new URLSearchParams({ song: state.project.id, note: state.noteMode, timing: mode, pitch: state.pitchMode });
  location.search = '?' + query.toString();
}

function renderControls() {
  const p = phrase();
  const filled = sequence().filter(Boolean).length;
  const count = state.draft.confirmed.filter(Boolean).length;
  const isComplete = complete(state.project, state.draft);
  const nativeProject = isNativeRenderProject(state.project);
  const busy = renderBusy();
  $('phase').textContent = state.draft.confirmed[current()] ? '已确认' :
    state.previewed.has(current()) ? '可确认' : filled === p.units.length ? '待试听' : '待编排';
  $('slot-count').textContent = filled + ' / ' + p.units.length;
  $('completed').textContent = count + ' / ' + state.project.phrases.length;
  $('progress').max = state.project.phrases.length;
  $('progress').value = count;
  $('original').disabled = busy || !state.audioReady;
  $('preview').disabled = busy || !state.audioReady || filled !== p.units.length;
  $('confirm').disabled = busy || !state.audioReady || filled !== p.units.length || !state.previewed.has(current());
  $('confirm').innerHTML = current() === state.project.phrases.length - 1
    ? '确认最后一句<i data-lucide="check"></i>' : '确认并听下一句<i data-lucide="arrow-right"></i>';
  $('previous').disabled = busy || current() === 0;
  $('undo').disabled = busy || !state.history[current()]?.length;
  $('clear').disabled = busy || !filled;
  $('remove').disabled = busy || state.selected < 0 || !sequence()[state.selected];
  $('repeat').disabled = busy || !filled || filled === p.units.length;
  $('full-play').disabled = busy || !state.audioReady || !isComplete;
  $('full-play').innerHTML = '<i data-lucide="headphones"></i>原生试听';
  $('export').disabled = busy || !state.audioReady || !isComplete || !nativeProject;
  $('export').innerHTML = state.remote.status === 'failed'
    ? '<i data-lucide="rotate-cw"></i>重试生成'
    : busy ? '<i data-lucide="loader-circle"></i>生成中…'
    : '<i data-lucide="download"></i>导出 WAV';
  if (busy) $('export-status').textContent = state.remote.kind === 'preview'
    ? 'OpenUtau 正在渲染本句试听…请勿编辑当前编排'
    : state.remote.kind === 'full'
      ? 'OpenUtau 正在渲染整首试听…请勿编辑当前编排'
      : 'OpenUtau 正在生成 WAV…请勿编辑当前编排';
  else if (state.remote.status === 'failed') $('export-status').textContent = '生成失败：' + state.remote.error + ' · 点击“重试生成”';
  else if (!nativeProject) $('export-status').textContent = isComplete
    ? '当前音频包需要重新生成 OpenUtau 工程'
    : count + ' / ' + state.project.phrases.length + ' 句已确认';
  else if (state.remote.status === 'completed' && state.remote.kind === 'export') $('export-status').textContent = 'OpenUtau WAV 已生成 · 可重新生成';
  else $('export-status').textContent = isComplete ? '全部乐句已确认 · 最终导出使用 OpenUtau 原生渲染' : count + ' / ' + state.project.phrases.length + ' 句已确认';
  $('draft-status').textContent = state.storageOK ? '草稿已保存在本机' : '浏览器无法保存草稿';
  document.querySelectorAll('.sound-pad').forEach(el => { el.disabled = busy || !state.audioReady || state.selected < 0; });
  $('reset').disabled = busy || !state.ready;
  $('manbo').disabled = busy || !state.audioReady || !nativeProject;
  $('pitch-mode').disabled = busy || !nativeProject;
  $('pitch-mode').value = state.pitchMode;
  $('note-mode').disabled = busy || !nativeProject;
  $('note-mode').value = state.noteMode;
  $('timing-mode').disabled = busy || !nativeProject;
  $('timing-mode').value = state.timingMode;
  icons();
}
function render() {
  if (!state.ready) return;
  const p = phrase();
  $('phrase-title').textContent = '第 ' + String(current() + 1).padStart(2, '0') + ' 句' + (p.text ? ' · ' + p.text : '');
  $('phrase-range').textContent = clock(p.start) + ' — ' + clock(p.end) + ' / ' + (p.end - p.start).toFixed(1) + ' 秒';
  $('slots').innerHTML = p.units.map((id, i) => {
    const value = sequence()[i];
    const unit = state.project.units[id];
    return '<button class="slot" data-index="' + i + '"' + (value ? ' data-sound="' + value + '"' : '') +
      ' aria-pressed="' + (state.selected === i) + '" title="单元 ' + (i + 1) + ' · ' + (unit.end - unit.start).toFixed(2) +
      ' 秒" aria-label="单元 ' + (i + 1) + '，' + (value ? LABELS[value] : '未选择') + '">' +
      '<small>' + String(i + 1).padStart(2, '0') + '</small><strong>' + (value ? LABELS[value] : '·') + '</strong></button>';
  }).join('');
  $('phrases').innerHTML = state.project.phrases.map((p, i) =>
    '<button data-phrase="' + i + '" aria-current="' + (i === current()) + '"><span class="phrase-number">' +
    String(i + 1).padStart(2, '0') + '</span><span>第 ' + (i + 1) + ' 句<small>' + clock(p.start) + ' · ' + p.units.length +
    ' 单元</small></span>' + (state.draft.confirmed[i] ? '<i data-lucide="check"></i>' : '<span></span>') + '</button>').join('');
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
  ctx.fillStyle = '#dbece2';
  ctx.fillRect(toX(p.start), 0, toX(p.end - p.start), height);
  const wave = state.project.waveform;
  const bars = Math.max(1, Math.floor(rect.width / 3));
  for (let i = 0; i < bars; i++) {
    const peak = wave[Math.min(wave.length - 1, Math.floor(i / bars * wave.length))];
    const size = Math.max(2, peak * height * .85);
    const time = i / bars * state.project.duration;
    ctx.fillStyle = time >= p.start && time <= p.end ? '#287656' : '#a8b5ae';
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
    document.querySelectorAll('.slot').forEach((el, i) => {
      const unit = state.project.units[phrase().units[i]];
      el.classList.toggle('playing', time >= unit.start && time < unit.end);
    });
  }
  requestAnimationFrame(animate);
}

async function loadAudio(file, decoder) {
  const url = file.startsWith('assets/') ? file : 'assets/' + file;
  const response = await fetch(url);
  if (!response.ok) throw new Error('音频缺失：' + file + ' (' + response.status + ')');
  return decoder.decodeAudioData(await response.arrayBuffer());
}
async function init() {
  icons();
  const catalogResponse = await fetch('assets/catalog.json');
  if (!catalogResponse.ok) throw new Error('缺少歌曲目录，请先运行音频预处理。');
  state.catalog = await catalogResponse.json();
  if (!Array.isArray(state.catalog.songs) || !state.catalog.songs.length) throw new Error('歌曲目录为空');
  const requestedId = new URLSearchParams(location.search).get('song');
  const entry = state.catalog.songs.find(song => song.id === requestedId) ||
    state.catalog.songs.find(song => song.id === state.catalog.defaultSong) || state.catalog.songs[0];
  const baseResponse = await fetch('assets/' + entry.project);
  if (!baseResponse.ok) throw new Error('缺少歌曲工程：' + entry.title);
  const baseProject = await baseResponse.json();
  const params = new URLSearchParams(location.search);
  const requestedNote = params.get('note') || defaultNoteMode(baseProject);
  const selectedNote = noteModeEntries(baseProject).find(mode => mode.id === requestedNote) || noteModeEntries(baseProject)[0];
  const requestedTiming = params.get('timing') || defaultTimingMode(baseProject, selectedNote.id);
  const timingEntry = timingModeEntries(baseProject, selectedNote.id).find(mode => mode.id === requestedTiming) || timingModeEntries(baseProject, selectedNote.id)[0];
  let project;
  if (timingEntry.project) {
    const projectResponse = await fetch('assets/' + timingEntry.project);
    if (!projectResponse.ok) throw new Error('缺少歌曲时序工程：' + entry.title);
    project = await projectResponse.json();
  } else {
    project = baseProject;
  }
  project.noteModes = baseProject.noteModes;
  project.noteModeDefault = selectedNote.id;
  project.timingModeDefault = timingEntry.id;
  if (project.sampleRate !== SAMPLE_RATE || !project.phrases?.length) throw new Error('音频工程格式不兼容');
  state.project = project;
  state.noteMode = selectedNote.id;
  const requestedPitch = params.get('pitch');
  state.pitchMode = pitchModeEntries(project).some(mode => mode.id === requestedPitch)
    ? requestedPitch : defaultPitchMode(project);
  state.timingMode = timingEntry.id;
  $('song-select').innerHTML = state.catalog.songs.map(song => '<option value="' + song.id + '">' +
    song.title + (song.subtitle || '') + '</option>').join('');
  $('song-select').value = project.id;
  $('song-select').disabled = false;
  $('song-select').addEventListener('change', event => {
    const next = encodeURIComponent(event.target.value);
    location.search = '?song=' + next;
  });
  $('note-mode').innerHTML = noteModeEntries(baseProject).map(mode =>
    '<option value="' + mode.id + '">' + mode.label + '</option>').join('');
  $('note-mode').value = state.noteMode;
  $('note-mode').disabled = false;
  $('note-mode').addEventListener('change', changeNoteMode);
  $('pitch-mode').innerHTML = pitchModeEntries(project).map(mode =>
    '<option value="' + mode.id + '">' + mode.label + '</option>').join('');
  $('pitch-mode').value = state.pitchMode;
  $('pitch-mode').disabled = false;
  $('pitch-mode').addEventListener('change', changePitchMode);
  $('timing-mode').innerHTML = timingModeEntries(baseProject, selectedNote.id).map(mode =>
    '<option value="' + mode.id + '">' + mode.label + '</option>').join('');
  $('timing-mode').value = state.timingMode;
  $('timing-mode').disabled = false;
  $('timing-mode').addEventListener('change', changeTimingMode);
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(key())); } catch { /* Ignore an invalid or unavailable draft. */ }
  state.draft = restoreDraft(project, saved);
  // The URL selects the analyzed note/timing variant. The pitch selector remains
  // independent and may be carried across a variant change by the query string.
  state.draft.noteMode = selectedNote.id;
  state.draft.timingMode = timingEntry.id;
  if (requestedPitch && state.pitchMode === requestedPitch && state.draft.pitchMode !== requestedPitch) {
    state.draft.pitchMode = requestedPitch;
    state.draft.confirmed = state.draft.confirmed.map(() => false);
  }
  state.pitchMode = state.draft.pitchMode;
  state.noteMode = state.draft.noteMode;
  state.timingMode = state.draft.timingMode;
  state.selected = sequence().findIndex(s => !s);
  state.ready = true;
  document.title = (project.title || 'Hachimi') + ' | Hachimi 编排台';
  $('song-title').firstChild.textContent = project.title || 'Hachimi';
  $('song-subtitle').textContent = project.subtitle || '';
  $('song-artist').textContent = project.artist || '';
  $('segmentation-method').textContent = state.timingMode === 'raw'
    ? '所选音符模式原始时序 + LDDC 只做汉字归组 + OpenUtau 原生渲染'
    : project.lyrics?.mode?.includes('GAME note timing')
      ? '所选音符模式 + 拍子辅助 + LDDC 连音归组 + OpenUtau 原生渲染'
      : '所选音符模式 + 声学边界（无逐字歌词）';
  $('analysis-summary').textContent = project.phrases.length + ' 句 · ' + project.units.length + ' 单元';
  for (const id of ['total-time', 'end-time']) $(id).textContent = clock(project.duration);
  $('middle-time').textContent = clock(project.duration / 2);
  $('reset').disabled = false;
  $('status').textContent = isNativeRenderProject(project)
    ? '正在载入音频素材…'
    : '旧音频包：可试听，最终导出需重建原生 OpenUtau 工程';
  save(); render();

  // The initial pack is large; parallel requests keep a slow connection from looking frozen.
  state.decoder = new OfflineAudioContext(2, 1, SAMPLE_RATE);
  const [original] = await Promise.all([loadAudio(project.assetBase + '/' + project.originalFile, state.decoder)]);
  state.original = original;
  state.audioReady = true;
  $('sounds').innerHTML = SOUND_IDS.map((id, i) => '<button class="sound-pad" data-sound="' + id +
    '" title="输入' + LABELS[id] + '（' + (i + 1) + '）" aria-label="输入' + LABELS[id] + '"><strong>' +
    LABELS[id] + '</strong><span>' + id + '</span></button>').join('');
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
      state.previewed.clear(); save(); renderControls();
    });
  }
  $('status').textContent = isNativeRenderProject(project)
    ? '音频就绪'
    : '旧音频包：可试听，最终导出需重建原生 OpenUtau 工程';
  save(); render();
  new ResizeObserver(() => draw()).observe($('waveform'));
  animate();
  await registerTools();
}

bind('original', original);
bind('preview', preview);
bind('stop', stop);
window.addEventListener('hachimi:stop-playback', stop);
bind('previous', () => selectPhrase(current() - 1));
bind('confirm', confirm);
bind('clear', () => changeSequence(sequence().map(() => null), 0));
bind('remove', () => {
  if (state.selected < 0) return;
  const next = [...sequence()]; next[state.selected] = null;
  changeSequence(next);
});
bind('repeat', () => changeSequence(repeatPattern(sequence()), -1));
bind('undo', () => {
  const previous = state.history[current()]?.pop();
  if (!previous) return;
  stop(); state.draft.sequences[current()] = previous;
  state.draft.confirmed[current()] = false;
  state.previewed.delete(current());
  state.selected = previous.findIndex(s => !s);
  invalidateRemoteResult();
  save(); render();
});
bind('reset', () => $('reset-dialog').showModal());
$('reset-dialog').addEventListener('close', () => {
  if ($('reset-dialog').returnValue !== 'reset' || renderBusy()) return;
  stop(); state.draft = emptyDraft(state.project); state.history = []; state.previewed.clear(); state.selected = 0;
  state.draft.noteMode = state.noteMode;
  state.draft.pitchMode = state.pitchMode;
  state.draft.timingMode = state.timingMode;
  invalidateRemoteResult();
  for (const prefix of ['backing', 'sound']) { $(prefix + '-gain').value = 1; $(prefix + '-value').textContent = '100%'; }
  save(); render();
});
bind('full-play', async () => {
  if (renderBusy() || !complete(state.project, state.draft)) return;
  await requestNativeAudio('/api/full-preview', nativeRenderPayload(state.project, state.draft, state.noteMode, state.timingMode, state.pitchMode), 'full');
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
  link.download = safeTitle + '-' + state.pitchMode + '-我的音效编排.wav';
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

async function requestNativeAudio(endpoint, payload, kind, onEnd = null) {
  if (renderBusy()) return;
  if (!isNativeRenderProject(state.project)) {
    const error = new Error('当前音频包不是 OpenUtau 原生工程，请先重新生成音频包。');
    report(error); renderControls(); return;
  }
  stop();
  const token = state.remote.token + 1;
  const snapshot = JSON.stringify(payload);
  const controller = new AbortController();
  state.remote = { status: 'queued', kind, id: null, error: null, wavUrl: null, ustxUrl: null, token, snapshot, controller };
  $('error').hidden = true;
  $('status').textContent = kind === 'preview' ? 'OpenUtau 正在渲染本句试听…' :
    kind === 'full' ? 'OpenUtau 正在渲染整首试听…' : 'OpenUtau 原生渲染已排队…';
  renderControls();
  try {
    const response = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: controller.signal,
    });
    const job = validateRenderJob(await responseData(response, '提交渲染任务失败'));
    if (!renderCurrent(token, snapshot)) return;
    state.remote.id = job.id;
    const completed = await pollRenderJob(token, snapshot, job.id, controller, job);
    if (!renderCurrent(token, snapshot)) return;
    state.remote.status = 'completed';
    state.remote.wavUrl = completed.wavUrl;
    state.remote.ustxUrl = completed.ustxUrl || null;
    state.remote.controller = null;
    renderControls();
    if (kind === 'export') {
      downloadServerWav(completed.wavUrl);
      $('status').textContent = 'WAV 已生成并开始下载';
      return;
    }
    const buffer = await decodeNativeAudio(completed.wavUrl);
    if (!renderCurrent(token, snapshot)) return;
    await play(buffer, 0, buffer.duration, kind, onEnd);
    $('status').textContent = kind === 'preview' ? '本句 OpenUtau 试听完成' : '整首 OpenUtau 试听完成';
  } catch (error) {
    if (error?.name === 'AbortError' || !renderCurrent(token, snapshot)) return;
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
  await requestNativeAudio('/api/render', nativeRenderPayload(state.project, state.draft, state.noteMode, state.timingMode, state.pitchMode), 'export');
}

async function uploadProject(event) {
  event.preventDefault();
  const song = $('upload-song').files?.[0];
  const lyrics = $('upload-lyrics').files?.[0];
  if (!song || !lyrics) throw new Error('请同时选择歌曲文件和歌词文件');
  const form = new FormData();
  form.append('song', song, song.name);
  form.append('lyrics', lyrics, lyrics.name);
  $('upload-submit').disabled = true;
  $('upload-cancel').disabled = true;
  $('upload-status').textContent = '正在上传并排队生成工程…';
  try {
    const response = await fetch('/api/projects', { method: 'POST', body: form });
    const job = await responseData(response, '创建歌曲工程失败');
    let currentJob = job;
    while (currentJob.status === 'queued' || currentJob.status === 'running') {
      $('upload-status').textContent = currentJob.message || '正在生成工程…';
      await new Promise(resolve => setTimeout(resolve, 1200));
      const status = await fetch('/api/projects/' + encodeURIComponent(job.id));
      currentJob = await responseData(status, '查询工程生成状态失败');
    }
    if (currentJob.status !== 'completed') throw new Error(currentJob.error || '歌曲工程生成失败');
    $('upload-status').textContent = '工程生成完成，正在打开…';
    $('project-dialog').close();
    location.search = '?song=' + encodeURIComponent(currentJob.projectId);
  } finally {
    $('upload-submit').disabled = false;
    $('upload-cancel').disabled = false;
  }
}

bind('export', requestNativeRender);
bind('manbo', generateManbo);
$('upload-open').addEventListener('click', () => $('project-dialog').showModal());
$('upload-cancel').addEventListener('click', () => $('project-dialog').close());
$('project-form').addEventListener('submit', attempt(uploadProject));
window.addEventListener('keydown', attempt(event => {
  if (!state.ready || event.repeat || event.altKey || event.ctrlKey || event.metaKey ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) || event.target.isContentEditable || $('reset-dialog').open) return;
  if (/^[1-5]$/.test(event.key)) { event.preventDefault(); return choose(SOUND_IDS[Number(event.key) - 1]); }
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
        if (!Number.isInteger(phraseIndex) || !p || !Array.isArray(sounds) || sounds.length !== p.units.length || !sounds.every(id => SOUND_IDS.includes(id))) throw new Error('Invalid phrase sequence');
        await selectPhrase(phraseIndex, false);
        changeSequence([...sounds], -1);
        return result({ updated: phraseIndex, confirmed: false });
      } }, { signal: lifecycle.signal });
  } catch (error) { console.warn('Optional WebMCP registration unavailable', error); }
}
init().catch(error => { $('status').textContent = '载入失败'; report(error); });
