import { DEFAULT_SOUND_PACK, SOUND_PACKS } from './audio-core.js';

const $ = id => document.getElementById(id);
const completed = task => ['completed', 'failed'].includes(task.status);
const tabs = ['separate', 'ustx'];
const state = { tasks: new Map(), busy: false, timer: null, sources: [] };

export async function readToolResponse(response) {
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `本地请求失败（${response.status}）`);
  if (!data) throw new Error('本地服务返回了无效结果');
  return data;
}

function showError(error) {
  $('audio-tool-error').textContent = error.message || String(error);
  $('audio-tool-error').hidden = false;
}

function selectTab(kind) {
  for (const name of tabs) {
    const selected = kind === name;
    $(name + '-tab').setAttribute('aria-selected', String(selected));
    $(name + '-tab').tabIndex = selected ? 0 : -1;
    $(name + '-panel').hidden = !selected;
  }
}

function controls() {
  const processing = state.busy || [...state.tasks.values()].some(task => !completed(task));
  for (const id of ['separate-submit', 'ustx-submit', 'separate-song',
    'ustx-file', 'ustx-backing-source', 'ustx-backing-file', 'ustx-sound-pack']) $(id).disabled = processing;
  const task = [...state.tasks.values()].find(task => !completed(task));
  $('audio-tool-status').textContent = state.busy ? '正在传入本机处理…' : task?.message || '';
}

function renderSources() {
  const select = $('ustx-backing-source');
  const previous = select.value;
  select.replaceChildren(new Option('请选择对应伴奏', ''));
  for (const source of state.sources) select.add(new Option(source.label, source.id));
  select.add(new Option('上传伴奏文件', 'file'));
  if ([...select.options].some(option => option.value === previous)) select.value = previous;
  backingSelection();
}

function backingSelection() {
  const upload = $('ustx-backing-source').value === 'file';
  $('ustx-backing-picker').hidden = !upload;
  $('ustx-backing-file').required = upload;
}

function exclusivePlayer(audio) {
  audio.addEventListener('play', () => {
    for (const other of document.querySelectorAll('#audio-task-list audio')) if (other !== audio) other.pause();
  });
}

function audioRow(container, task, file) {
  if (task.kind === 'separation') {
    const label = document.createElement('div');
    label.className = 'audio-result-label'; label.textContent = file.label;
    container.append(label);
  }
  const audio = document.createElement('audio');
  audio.controls = true; audio.preload = 'metadata'; audio.src = file.url;
  audio.setAttribute('aria-label', task.title + ' · ' + file.label);
  exclusivePlayer(audio);
  container.append(audio);
}

function renderTasks() {
  const list = $('audio-task-list');
  const tasks = [...state.tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 12);
  const visible = new Set(tasks.map(task => 'audio-task-' + task.id));
  for (const item of [...list.children]) {
    if (visible.has(item.id)) continue;
    for (const audio of item.querySelectorAll('audio')) audio.pause();
    item.remove();
  }
  // Keep existing audio elements alive while polling so playback and downloads
  // are not reset by an unrelated job's progress update.
  for (const task of tasks) {
    let item = document.getElementById('audio-task-' + task.id);
    if (item?.dataset.status === task.status && completed(task)) continue;
    if (!item) {
      item = document.createElement('li'); item.id = 'audio-task-' + task.id; item.dataset.createdAt = task.createdAt;
      const older = [...list.children].find(child => child.dataset.createdAt < task.createdAt);
      list.insertBefore(item, older || null);
    }
    item.dataset.status = task.status; item.replaceChildren();
    const heading = document.createElement('div'); heading.className = 'audio-task-heading';
    const title = document.createElement('strong'); title.textContent = task.title;
    const status = document.createElement('span'); status.textContent = { queued: '排队中', running: '处理中', completed: '已完成', failed: '失败' }[task.status];
    heading.append(title, status); item.append(heading);
    const info = document.createElement('p');
    if (task.status === 'failed') info.textContent = task.error;
    else if (task.status !== 'completed') info.textContent = task.message;
    else if (task.kind === 'ustx') {
      info.textContent = `${task.soundPack || DEFAULT_SOUND_PACK.label} · ${task.syllables} 个发音单位 · ${task.sustainNotes} 个延音`;
    } else info.textContent = '人声与伴奏';
    if (task.status === 'failed') info.className = 'audio-task-error';
    item.append(info);
    if (task.status !== 'completed') continue;
    for (const file of task.files) if (task.kind === 'separation' ? ['vocals', 'backing'].includes(file.kind) : file.kind === 'mix') audioRow(item, task, file);
    const links = document.createElement('div'); links.className = 'audio-task-links';
    for (const file of task.files.filter(file => ['vocals', 'backing', 'mix', 'score'].includes(file.kind))) {
      const link = document.createElement('a'); link.href = file.url + '?download=1'; link.download = file.downloadName;
      link.textContent = '下载' + file.label; links.append(link);
    }
    item.append(links);
    if (task.kind === 'separation') {
      const use = document.createElement('button'); use.type = 'button'; use.className = 'audio-task-use';
      use.textContent = '用此伴奏生成 USTX 样板';
      use.addEventListener('click', () => { selectTab('ustx'); $('ustx-backing-source').value = `task:${task.id}`; backingSelection(); $('ustx-file').focus(); });
      item.append(use);
    }
  }
}

async function refresh() {
  const data = await readToolResponse(await fetch('/api/audio-tools'));
  for (const task of data.tasks) state.tasks.set(task.id, task);
  state.sources = data.sources;
  renderSources(); renderTasks(); controls();
  if ([...state.tasks.values()].some(task => !completed(task))) schedulePoll();
}

function schedulePoll() {
  if (state.timer) return;
  state.timer = setTimeout(async () => {
    state.timer = null;
    try { await refresh(); } catch (error) { showError(error); controls(); }
  }, 1500);
}

async function submit(kind) {
  if (state.busy) return;
  const form = new FormData();
  if (kind === 'ustx') {
    const score = $('ustx-file').files?.[0];
    if (!score) throw new Error('请选择 USTX 工程');
    form.append('score', score, score.name);
    form.append('soundPack', $('ustx-sound-pack').value);
    const source = $('ustx-backing-source').value;
    if (!source) throw new Error('请选择与 USTX 对应的伴奏');
    form.append('backingSource', source);
    if (source === 'file') {
      const backing = $('ustx-backing-file').files?.[0];
      if (!backing) throw new Error('请选择伴奏文件');
      form.append('backing', backing, backing.name);
    }
  } else {
    const song = $(kind + '-song').files?.[0];
    if (!song) throw new Error('请选择歌曲文件');
    form.append('song', song, song.name);
  }
  state.busy = true; $('audio-tool-error').hidden = true; controls();
  try {
    const task = await readToolResponse(await fetch('/api/audio-tools/' + kind, { method: 'POST', body: form }));
    state.tasks.set(task.id, task); renderTasks(); schedulePoll();
  } finally { state.busy = false; controls(); }
}

function initialize() {
  const packPicker = $('ustx-sound-pack');
  for (const pack of SOUND_PACKS) packPicker.add(new Option(pack.label, pack.id));
  packPicker.value = DEFAULT_SOUND_PACK.id;
  const attempt = action => (...args) => Promise.resolve().then(() => action(...args)).catch(showError);
  $('audio-tools-open').addEventListener('click', attempt(async () => {
    $('audio-tools-dialog').showModal(); $('audio-tool-error').hidden = true;
    await refresh();
  }));
  $('audio-tools-close').addEventListener('click', () => $('audio-tools-dialog').close());
  $('audio-tools-dialog').addEventListener('close', () => {
    for (const audio of document.querySelectorAll('#audio-task-list audio')) audio.pause();
  });
  for (const [index, name] of tabs.entries()) {
    $(name + '-tab').addEventListener('click', () => selectTab(name));
    $(name + '-tab').addEventListener('keydown', event => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const step = event.key === 'ArrowLeft' ? -1 : 1;
        const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + step + tabs.length) % tabs.length;
        const next = tabs[nextIndex];
        selectTab(next); $(next + '-tab').focus();
      }
    });
    $(name + '-form').addEventListener('submit', event => {
      event.preventDefault();
      submit(name).catch(showError);
    });
  }
  $('ustx-backing-source').addEventListener('change', backingSelection);
  $('audio-tools-dialog').addEventListener('keydown', event => event.stopPropagation());
}

if (typeof document !== 'undefined') initialize();
