import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, extname, resolve, sep } from 'node:path';
import { AUDIO_EXTENSIONS, readMultipart, safeFileName } from './uploads.mjs';
import { runProcess } from './local-process.mjs';
import { listProjects } from './project-store.mjs';
import { DEFAULT_SOUND_PACK, SOUND_PACKS } from './audio-core.js';
import { sendFile as sendResponseFile } from './file-response.mjs';
import { separateAudio } from './separate-audio.mjs';
import { transcribeInstrumental } from './instrumental-audio.mjs';
export { runProcess, processErrorMessage } from './local-process.mjs';

const labels = { vocals: '纯人声', backing: '伴奏', mix: '完整样板', score: '替换后 USTX', preview: '30 秒试听', report: '生成记录' };
const uploadKinds = new Map([
  ['/api/audio-tools/separate', 'separation'],
  ['/api/audio-tools/ustx', 'ustx'],
  ['/api/audio-tools/instrumental', 'instrumental'],
]);
const startMessages = { separation: '正在准备本地人声分离…', ustx: '正在准备 USTX 样板…', instrumental: '正在准备纯音乐转录…' };
const active = task => ['queued', 'running'].includes(task.status);
const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
async function nativeRunner(task, onMessage, root) {
  const logPath = resolve(task.taskDir, 'task.log');
  if (task.kind === 'separation') {
    return separateAudio({ root, input: task.input, projectDir: task.projectDir,
      resultPath: task.resultPath, logPath, onMessage });
  }
  if (task.kind === 'instrumental') {
    return transcribeInstrumental({ root, input: task.input, outputDir: task.outputDir, logPath, onMessage });
  }
  const python = process.env.HACHIMI_AUDIO_PYTHON || resolve(root, 'Vocal2Midi/python/python.exe');
  try { await stat(python); } catch { throw new Error('找不到本机 USTX 处理环境，请保留 Vocal2Midi/python 或设置 HACHIMI_AUDIO_PYTHON'); }
  let backing = task.backing;
  if (task.uploadedBacking) {
    onMessage('正在准备上传的伴奏…');
    const ffmpeg = resolve(root, 'Vocal2Midi/ffmpeg.exe');
    backing = resolve(task.taskDir, 'backing.wav');
    await runProcess(ffmpeg, ['-nostdin', '-v', 'error', '-i', task.uploadedBacking,
      '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', backing], root, logPath, onMessage);
  }
  const pack = task.soundPack || DEFAULT_SOUND_PACK;
  onMessage('OpenUtau 正在按上传的 USTX 生成' + pack.label + '…');
  await runProcess(python, ['-X', 'utf8', resolve(root, 'backend/pipeline/render_vocal2midi.py'), task.input,
    '--backing', backing, '--output-dir', task.outputDir, '--mix-gain', '0.5', '--sound-pack', pack.id], root, logPath, onMessage);
  const reportPath = resolve(task.outputDir, 'report.json');
  const result = JSON.parse(await readFile(reportPath, 'utf8'));
  return { ...result, report: reportPath };
}

export function createAudioTools({ projectRoot, websiteRoot, analysisBusy = () => false, runner = nativeRunner }) {
  const storage = resolve(projectRoot, 'backend/runtime/web-server/audio-tools');
  const tasks = new Map();
  let accepting = false;
  const within = path => {
    const full = resolve(projectRoot, path);
    if (!full.startsWith(projectRoot + sep)) throw new Error('任务文件路径越界');
    return full;
  };
  const persist = task => writeFile(resolve(task.taskDir, 'task.json'), JSON.stringify(task, null, 2), 'utf8');
  const ready = (async () => {
    await mkdir(storage, { recursive: true });
    for (const dir of await readdir(storage, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      try {
        const task = JSON.parse(await readFile(resolve(storage, dir.name, 'task.json'), 'utf8'));
        if (active(task)) { task.status = 'failed'; task.error = '本地服务已重启，请重新提交任务'; await persist(task); }
        tasks.set(task.id, task);
      } catch { /* An unfinished upload has no recoverable task manifest. */ }
    }
  })();
  const busy = () => accepting || [...tasks.values()].some(active);
  const publicTask = task => ({
    id: task.id, kind: task.kind, title: task.title, status: task.status, message: task.message,
    error: task.error, createdAt: task.createdAt, finishedAt: task.finishedAt,
    duration: task.duration, syllables: task.syllables, sustainNotes: task.sustainNotes, soundPack: task.soundPack?.label,
    files: Object.keys(task.files || {}).map(kind => ({ kind, label: labels[kind],
      url: `/api/audio-tools/${task.id}/files/${kind}`, downloadName: `${task.title}-${labels[kind]}${extname(task.files[kind])}` })),
    ...(task.kind === 'instrumental' && task.status === 'completed' && {
      tracks: task.tracks.map(({ id, label, noteCount }) => {
        const url = `/api/audio-tools/${task.id}/tracks/${id}`;
        return { id, label, noteCount, previewUrl: url + '/preview', midiUrl: url + '/midi?download=1' };
      }),
    }),
  });
  async function trackResults(task, result) {
    if (!Array.isArray(result.tracks) || !result.tracks.length) throw new Error('没有转录出可选的乐器音轨');
    const ids = new Set();
    const directory = resolve(task.outputDir, 'tracks');
    return Promise.all(result.tracks.map(async ({ id, label, noteCount, midi, preview }) => {
      if (typeof id !== 'string' || !/^track-[1-9]\d*$/.test(id) || ids.has(id)
          || typeof label !== 'string' || !label.trim() || !Number.isSafeInteger(noteCount) || noteCount < 1
          || midi !== id + '.mid' || preview !== id + '.wav') {
        throw new Error('音轨清单格式无效');
      }
      ids.add(id);
      const midiPath = within(resolve(directory, midi));
      const previewPath = within(resolve(directory, preview));
      const info = await Promise.all([stat(midiPath), stat(previewPath)]);
      if (info.some(file => !file.isFile() || !file.size)) throw new Error('音轨结果缺失');
      return { id, label: label.trim(), noteCount, midi: midiPath, preview: previewPath };
    }));
  }
  async function processTask(task) {
    try {
      task.status = 'running';
      task.message = startMessages[task.kind];
      await persist(task);
      const result = await runner(task, message => { task.message = message; }, projectRoot);
      if (task.kind === 'instrumental') {
        task.tracks = await trackResults(task, result);
        task.message = '音轨已生成，请试听并选择主旋律';
      } else {
        const mapping = task.kind === 'separation'
          ? { vocals: result.vocals, backing: result.backing }
          : { mix: result.mix, vocals: result.vocal, score: result.project, preview: result.preview, report: result.report };
        task.files = {};
        for (const [kind, file] of Object.entries(mapping)) {
          const path = within(file);
          if (!(await stat(path)).isFile()) throw new Error('处理结果缺失：' + kind);
          task.files[kind] = path;
        }
        task.syllables = result.syllables;
        task.sustainNotes = result.sustainNotes;
        task.message = task.kind === 'separation' ? '人声和伴奏已分离完成' : (task.soundPack || DEFAULT_SOUND_PACK).label + '样板已生成';
      }
      task.duration = result.duration;
      task.status = 'completed';
    } catch (error) {
      task.status = 'failed'; task.error = error.message;
      task.message = '处理失败';
    }
    task.finishedAt = new Date().toISOString();
    await persist(task);
  }
  async function catalogSources() {
    return (await listProjects(projectRoot)).map(project => ({ id: `song:${project.id}`,
      label: project.title + ' · 工程伴奏', path: within(project.files.backing) }));
  }
  async function sources() {
    const completed = [...tasks.values()].filter(task => task.kind === 'separation' && task.status === 'completed');
    return [
      ...completed.reverse().map(task => ({ id: `task:${task.id}`, label: task.title + ' · 已分离伴奏', path: task.files.backing })),
      ...await catalogSources(),
    ];
  }
  async function create(req, kind) {
    await ready;
    if (busy() || analysisBusy()) throw new Error('已有本地音频任务正在处理，请等待完成后再提交');
    accepting = true;
    try {
      const parts = await readMultipart(req);
      const scoreUpload = kind === 'ustx';
      const inputName = scoreUpload ? 'score' : 'song';
      const part = parts.get(inputName);
      if (!part?.filename || !part.data.length) throw new Error(scoreUpload ? '请选择 USTX 工程' : '请选择歌曲文件');
      const filename = safeFileName(part.filename, scoreUpload ? 'score.ustx' : 'song.wav');
      const extension = extname(filename).toLowerCase();
      if (scoreUpload && extension !== '.ustx') throw new Error('工程必须是 .ustx 文件');
      if (!scoreUpload && !AUDIO_EXTENSIONS.has(extension)) throw new Error('请选择支持的音频文件');
      if (scoreUpload && part.data.length > 16 * 1024 * 1024) throw new Error('USTX 工程不能超过 16 MB');
      let backing;
      let backingPart;
      let soundPack;
      if (scoreUpload) {
        const packId = parts.get('soundPack')?.data.toString('utf8') || DEFAULT_SOUND_PACK.id;
        soundPack = SOUND_PACKS.find(pack => pack.id === packId);
        if (!soundPack) throw new Error('请选择有效的音效组');
        const selection = parts.get('backingSource')?.data.toString('utf8');
        if (selection === 'file') {
          backingPart = parts.get('backing');
          if (!backingPart?.filename || !backingPart.data.length || !AUDIO_EXTENSIONS.has(extname(backingPart.filename).toLowerCase()))
            throw new Error('请选择有效的伴奏音频文件');
        } else {
          backing = (await sources()).find(item => item.id === selection)?.path;
          if (!backing) throw new Error('请选择与 USTX 对应的伴奏');
          await stat(backing);
        }
      }
      const id = randomUUID();
      const taskDir = resolve(storage, id);
      const projectDir = kind === 'separation' ? resolve(projectRoot, 'projects', 'upload-' + id) : taskDir;
      const inputDir = resolve(projectDir, 'input');
      await mkdir(inputDir, { recursive: true });
      await mkdir(taskDir, { recursive: true });
      const input = resolve(inputDir, inputName + extension);
      await writeFile(input, part.data);
      const task = { id, kind, title: basename(filename, extension), status: 'queued', createdAt: new Date().toISOString(),
        taskDir, projectDir, input, backing, soundPack, outputDir: resolve(taskDir, 'output'), resultPath: resolve(taskDir, 'result.json'), files: {} };
      if (backingPart) {
        task.uploadedBacking = resolve(inputDir, 'backing' + extname(backingPart.filename).toLowerCase());
        await writeFile(task.uploadedBacking, backingPart.data);
      }
      tasks.set(id, task);
      await persist(task);
      processTask(task).catch(error => console.error('Unable to persist local audio task:', error.message));
      return publicTask(task);
    } finally { accepting = false; }
  }
  async function sendFile(req, res, task, kind, download) {
    if (task.status !== 'completed') return json(res, 409, { error: task.error || '任务尚未完成' });
    if (!Object.hasOwn(task.files, kind)) return json(res, 404, { error: '文件不存在' });
    const path = within(task.files[kind]);
    await sendResponseFile(req, res, path, download ? `${task.title}-${labels[kind]}${extname(path)}` : undefined);
  }
  async function sendInstrumentalTrack(req, res, task, id, type) {
    if (task.kind !== 'instrumental') return json(res, 404, { error: '音轨不存在' });
    if (task.status !== 'completed') return json(res, 409, { error: task.error || '任务尚未完成' });
    const track = task.tracks.find(item => item.id === id);
    if (!track) return json(res, 404, { error: '音轨不存在' });
    const path = within(track[type]);
    const name = type === 'midi' ? safeFileName(`${task.title}-${track.label}`, id).toWellFormed() + '.mid' : undefined;
    await sendResponseFile(req, res, path, name);
  }
  return {
    busy,
    async handle(req, res, pathname) {
      if (!pathname.startsWith('/api/audio-tools')) return false;
      await ready;
      try {
        if (pathname === '/api/audio-tools' && req.method === 'GET') {
          json(res, 200, { tasks: [...tasks.values()].map(publicTask).reverse(), sources: (await sources()).map(({ path, ...source }) => source) });
          return true;
        }
        if (req.method === 'POST' && uploadKinds.has(pathname)) {
          json(res, 202, await create(req, uploadKinds.get(pathname)));
          return true;
        }
        const match = /^\/api\/audio-tools\/([a-f0-9-]+)(?:\/files\/(\w+)|\/tracks\/(track-[1-9]\d*)\/(preview|midi))?$/.exec(pathname);
        const task = match && tasks.get(match[1]);
        if (!task) { json(res, 404, { error: '音频任务不存在' }); return true; }
        if (['GET', 'HEAD'].includes(req.method) && match[2]) {
          await sendFile(req, res, task, match[2], new URL(req.url, 'http://localhost').searchParams.has('download'));
        } else if (['GET', 'HEAD'].includes(req.method) && match[3]) {
          await sendInstrumentalTrack(req, res, task, match[3], match[4]);
        } else if (req.method === 'GET' && !match[2] && !match[3]) json(res, 200, publicTask(task));
        else json(res, 405, { error: '不支持的请求方式' });
      } catch (error) { json(res, 400, { status: 'failed', error: error.message }); }
      return true;
    },
  };
}
