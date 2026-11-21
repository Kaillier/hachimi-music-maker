import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { basename, dirname, extname, resolve, sep } from 'node:path';
import { AUDIO_EXTENSIONS, readMultipart, safeFileName } from './uploads.mjs';

const labels = { vocals: '纯人声', backing: '伴奏', mix: '完整样板', score: '替换后 USTX', preview: '30 秒试听', report: '生成记录' };
const active = task => ['queued', 'running'].includes(task.status);
const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const wslPath = value => resolve(value).replaceAll('\\', '/').replace(/^([A-Za-z]):\//, (_, drive) => `/mnt/${drive.toLowerCase()}/`);

export function processErrorMessage(output) {
  const lines = output.trim().split(/\r?\n/);
  const errorLine = lines.findLast(line => /^[\w.]+(?:Error|Exception):/.test(line));
  return errorLine
    ? errorLine.replace(/^[\w.]+(?:Error|Exception):\s*/, '').slice(0, 1800)
    : output.trim().slice(-1800) || '本地处理失败，请检查任务日志';
}

export function runProcess(executable, args, cwd, logPath, onMessage) {
  return new Promise((resolveProcess, reject) => {
    const log = createWriteStream(logPath, { flags: 'a' });
    const child = spawn(executable, args, { cwd, windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let output = '';
    let pending = '';
    let settled = false;
    const timeout = setTimeout(() => { child.kill(); }, 30 * 60 * 1000);
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      log.end(() => error ? reject(error) : resolveProcess());
    };
    const capture = chunk => {
      log.write(chunk);
      const text = chunk.toString();
      output = (output + text).slice(-4000);
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('HACHIMI_EVENT ')) continue;
        try { onMessage(JSON.parse(line.slice(14)).message); } catch { /* Other process logs are diagnostic text. */ }
      }
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', finish);
    child.on('close', code => {
      finish(code === 0 ? null : new Error(processErrorMessage(output)));
    });
  });
}

async function nativeRunner(task, onMessage, root) {
  const logPath = resolve(task.taskDir, 'task.log');
  if (task.kind === 'separation') {
    const python = '/home/kaillier/.local/share/hachimi/ai-venv/bin/python';
    const command = `cd ${quote(wslPath(root))} && ${quote(python)} backend/experiments/separate_audio.py` +
      ` --input ${quote(wslPath(task.input))} --work ${quote(wslPath(task.projectDir))} --result ${quote(wslPath(task.resultPath))}`;
    await runProcess(process.platform === 'win32' ? 'wsl.exe' : '/bin/sh',
      process.platform === 'win32' ? ['-e', 'bash', '-lc', command] : ['-lc', command], root, logPath, onMessage);
    return JSON.parse(await readFile(task.resultPath, 'utf8'));
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
  onMessage('OpenUtau 正在按上传的 USTX 生成哈基米曼波…');
  await runProcess(python, ['-X', 'utf8', resolve(root, 'backend/experiments/render_vocal2midi.py'), task.input,
    '--backing', backing, '--output-dir', task.outputDir, '--mix-gain', '0.5'], root, logPath, onMessage);
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
    duration: task.duration, syllables: task.syllables, sustainNotes: task.sustainNotes,
    files: Object.keys(task.files || {}).map(kind => ({ kind, label: labels[kind],
      url: `/api/audio-tools/${task.id}/files/${kind}`, downloadName: `${task.title}-${labels[kind]}${extname(task.files[kind])}` })),
  });
  async function processTask(task) {
    try {
      task.status = 'running';
      task.message = task.kind === 'separation' ? '正在准备本地人声分离…' : '正在准备 USTX 样板…';
      await persist(task);
      const result = await runner(task, message => { task.message = message; }, projectRoot);
      const mapping = task.kind === 'separation'
        ? { vocals: result.vocals, backing: result.backing }
        : { mix: result.mix, vocals: result.vocal, score: result.project, preview: result.preview, report: result.report };
      task.files = {};
      for (const [kind, file] of Object.entries(mapping)) {
        const path = within(file);
        if (!(await stat(path)).isFile()) throw new Error('处理结果缺失：' + kind);
        task.files[kind] = path;
      }
      task.duration = result.duration;
      task.syllables = result.syllables;
      task.sustainNotes = result.sustainNotes;
      task.status = 'completed';
      task.message = task.kind === 'separation' ? '人声和伴奏已分离完成' : '哈基米曼波样板已生成';
    } catch (error) {
      task.status = 'failed'; task.error = error.message;
      task.message = '处理失败';
    }
    task.finishedAt = new Date().toISOString();
    await persist(task);
  }
  async function catalogSources() {
    const sources = [];
    try {
      const catalog = JSON.parse(await readFile(resolve(websiteRoot, 'assets/catalog.json'), 'utf8'));
      for (const song of catalog.songs || []) {
        const project = JSON.parse(await readFile(resolve(websiteRoot, 'assets', song.project), 'utf8'));
        if (project.nativeRender?.backing) sources.push({ id: `song:${song.id}`, label: song.title + ' · 现有伴奏', path: within(project.nativeRender.backing) });
      }
    } catch { /* Upload tools also work when the song catalog is unavailable. */ }
    return sources;
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
      const part = parts.get(kind === 'separation' ? 'song' : 'score');
      if (!part?.filename || !part.data.length) throw new Error(kind === 'separation' ? '请选择歌曲文件' : '请选择 USTX 工程');
      const filename = safeFileName(part.filename, kind === 'separation' ? 'song.wav' : 'score.ustx');
      const extension = extname(filename).toLowerCase();
      if (kind === 'separation' ? !AUDIO_EXTENSIONS.has(extension) : extension !== '.ustx') throw new Error(kind === 'separation' ? '请选择支持的音频文件' : '工程必须是 .ustx 文件');
      if (kind !== 'separation' && part.data.length > 16 * 1024 * 1024) throw new Error('USTX 工程不能超过 16 MB');
      let backing;
      let backingPart;
      if (kind !== 'separation') {
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
      const input = resolve(inputDir, (kind === 'separation' ? 'song' : 'score') + extension);
      await writeFile(input, part.data);
      const task = { id, kind, title: basename(filename, extension), status: 'queued', createdAt: new Date().toISOString(),
        taskDir, projectDir, input, backing, outputDir: resolve(taskDir, 'output'), resultPath: resolve(taskDir, 'result.json'), files: {} };
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
    const info = await stat(path);
    const headers = { 'Content-Type': extname(path) === '.wav' ? 'audio/wav' : kind === 'score' ? 'text/yaml; charset=utf-8' : 'application/json; charset=utf-8',
      'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(`${task.title}-${labels[kind]}${extname(path)}`)}`;
    let start = 0;
    let end = info.size - 1;
    if (req.headers.range) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (range && (range[1] || range[2])) {
        if (range[1]) { start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), end) : end; }
        else start = Math.max(0, info.size - Number(range[2]));
      } else start = info.size;
      if (start > end || start >= info.size) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end(); return; }
      headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(req.headers.range ? 206 : 200, headers);
    if (req.method === 'HEAD') res.end();
    else createReadStream(path, { start, end }).on('error', () => res.destroy()).pipe(res);
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
        if (req.method === 'POST' && ['/api/audio-tools/separate', '/api/audio-tools/ustx'].includes(pathname)) {
          json(res, 202, await create(req, pathname.endsWith('/separate') ? 'separation' : 'ustx'));
          return true;
        }
        const match = /^\/api\/audio-tools\/([a-f0-9-]+)(?:\/files\/(\w+))?$/.exec(pathname);
        const task = match && tasks.get(match[1]);
        if (!task) { json(res, 404, { error: '音频任务不存在' }); return true; }
        if (['GET', 'HEAD'].includes(req.method) && match[2]) {
          await sendFile(req, res, task, match[2], new URL(req.url, 'http://localhost').searchParams.has('download'));
        } else if (req.method === 'GET') json(res, 200, publicTask(task));
        else json(res, 405, { error: '不支持的请求方式' });
      } catch (error) { json(res, 400, { status: 'failed', error: error.message }); }
      return true;
    },
  };
}
