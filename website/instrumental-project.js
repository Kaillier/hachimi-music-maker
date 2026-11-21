const $ = id => document.getElementById('melody-' + id);
const songId = new URLSearchParams(location.search).get('song');
const endpoint = '/api/instrumental-projects/' + encodeURIComponent(songId || '');
const audio = $('audio');
const countFormat = new Intl.NumberFormat('zh-CN');
let project, segments = [], current = 0, position = 0, savedSegments = '';
let pending = false, notice = '', playback = null, playbackFrame = 0;

async function request(path = '', method = 'GET', body) {
  const options = { method };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  const response = await fetch(endpoint + path, options);
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(data?.error || '工程请求失败（HTTP ' + response.status + '）');
  return data;
}

function errorMessage(message = '') {
  $('error').textContent = message;
  $('error').hidden = !message;
}

function displayTime(value, milliseconds = false) {
  const total = Math.round(value * 1000);
  const seconds = String(Math.floor(total / 1000) % 60).padStart(2, '0');
  const minutes = String(Math.floor(total / 60000)).padStart(2, '0');
  return minutes + ':' + seconds + (milliseconds ? '.' + String(total % 1000).padStart(3, '0') : '');
}

const roundedPosition = value => Math.round(value * 1000) / 1000;
const isAssigned = segment => segment.trackId !== undefined;
const dirty = () => JSON.stringify(segments) !== savedSegments;
const titleFor = id => id === null ? '无主旋律' : project.tracks.find(track => track.id === id)?.label || '待选择';

function setPosition(value) {
  position = Math.max(0, Math.min(value, project.duration));
  const valueText = displayTime(position, true);
  $('position').textContent = valueText + ' / ' + displayTime(project.duration, true);
  $('playhead').value = position;
  $('playhead').setAttribute('aria-valuetext', valueText);
  if (document.activeElement !== $('split-time')) $('split-time').value = roundedPosition(position);
}

function syncPlaybackButtons() {
  const buttons = [$('play-original'), $('play-segment'), $('play-result'), ...$('track-list').querySelectorAll('button')];
  for (const button of buttons) {
    const playing = playback?.button === button;
    button.textContent = playing ? '停止' : button.dataset.playLabel;
    if (button.dataset.trackLabel) button.setAttribute('aria-label', (playing ? '停止 ' : '试听 ') + button.dataset.trackLabel);
  }
}

function stopPlayback() {
  cancelAnimationFrame(playbackFrame);
  playback = null;
  audio.pause();
  syncPlaybackButtons();
}

function followPlayback() {
  if (!playback) return;
  if (audio.currentTime >= playback.end) {
    setPosition(playback.end);
    stopPlayback();
  } else if (!audio.paused) {
    if (!audio.seeking) setPosition(audio.currentTime);
    playbackFrame = requestAnimationFrame(followPlayback);
  }
}

function play(button, url, start, end) {
  if (playback?.button === button) { stopPlayback(); return; }
  stopPlayback();
  if (!url) return;
  if (audio.getAttribute('src') !== url) audio.src = url;
  audio.currentTime = start;
  setPosition(start);
  const attempt = playback = { button, end };
  syncPlaybackButtons();
  audio.play().then(() => {
    if (attempt === playback) followPlayback();
  }).catch(error => {
    if (attempt !== playback) return;
    stopPlayback();
    if (error.name !== 'AbortError') errorMessage('音频播放失败，请重新试听。');
  });
}

function renderSegments() {
  const strip = document.createDocumentFragment();
  const list = document.createDocumentFragment();
  for (const [index, segment] of segments.entries()) {
    const span = document.createElement('span');
    span.style.setProperty('--span', (segment.end - segment.start) / project.duration);
    span.dataset.assigned = String(isAssigned(segment));
    span.dataset.silence = String(segment.trackId === null);
    span.dataset.current = String(current === index);
    strip.append(span);

    const row = document.createElement('li');
    const button = document.createElement('button');
    const time = document.createElement('span');
    const selection = document.createElement('span');
    time.textContent = displayTime(segment.start, true) + '–' + displayTime(segment.end, true);
    selection.textContent = titleFor(segment.trackId);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(current === index));
    button.append(time, selection);
    button.addEventListener('click', () => {
      stopPlayback();
      current = index;
      setPosition(segment.start);
      renderEditor();
      $('segment-list').children[index].firstElementChild.focus();
    });
    row.append(button);
    list.append(row);
  }
  const scroll = $('segment-list').scrollTop;
  $('strip').replaceChildren(strip);
  $('segment-list').replaceChildren(list);
  $('segment-list').scrollTop = scroll;
  $('count').textContent = segments.filter(isAssigned).length + ' / ' + segments.length + ' 段已指定';
}

function renderTracks(segment) {
  const list = document.createDocumentFragment();
  for (const track of [...project.tracks, { id: null, label: '无主旋律（不加入新音符）' }]) {
    const row = document.createElement('li');
    const label = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'segment-track';
    radio.checked = segment.trackId === track.id;
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      segment.trackId = track.id;
      changeSelection();
    });
    const name = document.createElement('span');
    name.textContent = track.label;
    label.append(radio, name);
    if (track.id !== null) {
      const count = document.createElement('small');
      count.textContent = '全轨 ' + countFormat.format(track.noteCount) + ' 个音符';
      label.append(count);
    }
    row.append(label);
    if (track.previewUrl) {
      const playTrack = document.createElement('button');
      playTrack.type = 'button';
      playTrack.dataset.playLabel = '试听';
      playTrack.dataset.trackLabel = track.label;
      playTrack.addEventListener('click', () => play(playTrack, track.previewUrl, segment.start, segment.end));
      row.append(playTrack);
    }
    list.append(row);
  }
  $('track-list').replaceChildren(list);
  syncPlaybackButtons();
}

function fillBoundaries(segment) {
  $('boundary-start').value = segment.start;
  $('boundary-end').value = segment.end;
}

function renderControls() {
  const assigned = segments.every(isAssigned);
  $('save').disabled = pending || !dirty();
  $('export').disabled = pending || !assigned;
  $('split-time').disabled = $('split').disabled = pending;
  $('boundary-start').disabled = pending || current === 0;
  $('boundary-end').disabled = pending || current === segments.length - 1;
  $('boundary-update').disabled = pending || segments.length < 2;
  $('merge').disabled = pending || current === 0;
  $('track-picker').disabled = pending;
  const published = !dirty() && project.export?.revision === project.revision && project.export.midiUrl;
  $('export-links').hidden = !published;
  if (published) {
    $('midi-link').href = project.export.midiUrl;
    $('wav-link').hidden = $('play-result').hidden = !project.export.wavUrl;
    if (project.export.wavUrl) $('wav-link').href = project.export.wavUrl;
  }
  $('save-status').textContent = notice || (dirty() ? '有未保存的修改' :
    !assigned ? '为每段选择一条音轨或设为无主旋律后，即可导出。' : '工程已保存');
}

function renderEditor() {
  const segment = segments[current];
  renderSegments();
  fillBoundaries(segment);
  renderTracks(segment);
  renderControls();
}

function changeSelection(boundariesChanged = false) {
  errorMessage();
  notice = '';
  if (boundariesChanged) renderEditor();
  else {
    renderSegments();
    renderControls();
  }
}

async function load() {
  if (!songId) {
    $('summary').textContent = '请从生成记录打开纯音乐工程。';
    return;
  }
  $('retry').hidden = true;
  errorMessage();
  try {
    project = await request();
    segments = project.segments.map(segment => ({ ...segment }));
    savedSegments = JSON.stringify(segments);
    $('title').textContent = project.title;
    $('summary').textContent = '主旋律工程 · ' + project.tracks.length + ' 条候选音轨';
    document.title = project.title + ' | 主旋律工程';
    $('playhead').max = project.duration;
    $('split-time').max = project.duration;
    const ruler = [0, .25, .5, .75, 1].map(fraction => {
      const item = document.createElement('span');
      item.textContent = displayTime(project.duration * fraction);
      return item;
    });
    $('ruler').replaceChildren(...ruler);
    setPosition(0);
    renderEditor();
    $('actions').hidden = $('workbench').hidden = false;
  } catch (error) {
    $('summary').textContent = '工程载入失败';
    errorMessage(error.message);
    $('retry').hidden = false;
  }
}

async function save() {
  if (!dirty()) return;
  project = await request('/selection', 'PATCH', { revision: project.revision, segments });
  savedSegments = JSON.stringify(segments);
}

async function perform(message, action) {
  if (pending) return;
  errorMessage();
  pending = true;
  notice = message;
  renderControls();
  try {
    notice = await action();
  } catch (error) {
    notice = '';
    errorMessage(error.message);
  } finally {
    pending = false;
    renderControls();
  }
}

$('retry').addEventListener('click', load);
$('playhead').addEventListener('input', event => {
  stopPlayback();
  setPosition(event.target.valueAsNumber);
});
$('playhead').addEventListener('keydown', event => {
  const offsets = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -10, PageUp: 10 };
  if (!(event.key in offsets)) return;
  event.preventDefault();
  stopPlayback();
  setPosition(position + offsets[event.key]);
});
$('split-time').addEventListener('change', event => {
  const time = event.target.valueAsNumber;
  if (!Number.isFinite(time)) return;
  stopPlayback();
  setPosition(time);
});
$('split-form').addEventListener('submit', event => {
  event.preventDefault();
  if (pending) return;
  const time = $('split-time').valueAsNumber;
  const index = segments.findIndex(segment => time > segment.start && time < segment.end);
  if (index < 0) { errorMessage('请在一个时间段的起点和终点之间分段。'); return; }
  const parent = segments[index];
  stopPlayback();
  segments.splice(index, 1, { ...parent, end: time }, { ...parent, start: time });
  current = index + 1;
  setPosition(time);
  changeSelection(true);
});
$('boundary-form').addEventListener('submit', event => {
  event.preventDefault();
  if (pending) return;
  const segment = segments[current];
  const previous = segments[current - 1];
  const next = segments[current + 1];
  const start = previous ? $('boundary-start').valueAsNumber : segment.start;
  const end = next ? $('boundary-end').valueAsNumber : segment.end;
  if (!(start < end) || (previous && !(start > previous.start)) || (next && !(end < next.end))) {
    errorMessage('请保留当前段和相邻段的有效时长。');
    return;
  }
  stopPlayback();
  if (previous) previous.end = start;
  if (next) next.start = end;
  segment.start = start;
  segment.end = end;
  setPosition(start);
  changeSelection(true);
});
$('merge').addEventListener('click', () => {
  if (!current || pending) return;
  const first = segments[current - 1];
  const second = segments[current];
  const combined = { start: first.start, end: second.end };
  if (first.trackId === second.trackId && isAssigned(first)) combined.trackId = first.trackId;
  stopPlayback();
  segments.splice(current - 1, 2, combined);
  current--;
  setPosition(combined.start);
  changeSelection(true);
});

$('play-original').dataset.playLabel = '播放原曲';
$('play-segment').dataset.playLabel = '试听本段原曲';
$('play-result').dataset.playLabel = '试听整首主旋律';
$('play-original').addEventListener('click', event => play(event.currentTarget, project.originalUrl,
  position < project.duration ? position : 0, project.duration));
$('play-segment').addEventListener('click', event => {
  const segment = segments[current];
  play(event.currentTarget, project.originalUrl, segment.start, segment.end);
});
$('play-result').addEventListener('click', event => play(event.currentTarget, project.export?.wavUrl, 0, project.duration));
audio.addEventListener('ended', () => {
  if (playback) setPosition(audio.currentTime);
  stopPlayback();
});
audio.addEventListener('timeupdate', () => {
  if (playback && audio.currentTime >= playback.end) {
    setPosition(playback.end);
    stopPlayback();
  }
});

$('save').addEventListener('click', () => perform('正在保存工程…', async () => { await save(); return '工程已保存'; }));
$('export').addEventListener('click', () => perform('正在导出主旋律…', async () => {
  await save();
  project.export = await request('/export', 'POST', { revision: project.revision });
  return '主旋律已导出';
}));
window.addEventListener('beforeunload', event => {
  if (!project || !dirty()) return;
  event.preventDefault();
  event.returnValue = '';
});

window.lucide?.createIcons();
load();
