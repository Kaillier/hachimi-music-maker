import { createServer } from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectPitchSource } from './pitch-routing.mjs';
import { createAudioTools } from './audio-tools.mjs';
import { readMultipart, safeFileName } from './uploads.mjs';
const root = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(root, '..');
const jobsRoot = resolve(projectRoot, 'backend/runtime/web-server/native-jobs');
const projectsRoot = resolve(projectRoot, 'projects');
const analysisPythonRelative = 'backend/runtime/game-rmvpe-world/.venv/bin/python';
const analysisScriptRelative = 'backend/experiments/prepare_web.py';
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };
let port = Number(process.argv[2] || 4174);

const json = (res, status, value) => {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('请求过大');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function projectSlug(value) {
  const stem = safeFileName(value, 'song').replace(/\.[^.]+$/, '');
  return stem.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'song';
}

function wslPath(path) {
  const normalized = resolve(path).replaceAll('\\', '/');
  const drive = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  return drive ? `/mnt/${drive[1].toLowerCase()}/${drive[2]}` : normalized;
}

function shellQuote(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'";
}

const generationJobs = new Map();

function generationBusy() {
  return [...generationJobs.values()].some(job => job.status === 'queued' || job.status === 'running');
}

function startProjectGeneration(job) {
  const logPath = resolve(job.projectDir, 'generation.log');
  const command = [
    `cd ${shellQuote(wslPath(projectRoot))}`,
    `export HACHIMI_SONG_PATH=${shellQuote(wslPath(job.songPath))}`,
    `export HACHIMI_LYRICS_PATH=${shellQuote(wslPath(job.lyricsPath))}`,
    `export HACHIMI_WORK=${shellQuote(wslPath(job.projectDir))}`,
    `export HACHIMI_PROJECT_ID=${shellQuote(job.projectId)}`,
    `${shellQuote(analysisPythonRelative)} ${shellQuote(analysisScriptRelative)}`,
    `${shellQuote(analysisPythonRelative)} ${shellQuote(analysisScriptRelative)} --pack-all`,
  ].join(' && ');
  const executable = process.platform === 'win32' ? 'wsl.exe' : '/bin/sh';
  const args = process.platform === 'win32'
    ? ['-e', 'bash', '-lc', command]
    : ['-lc', command];
  const child = spawn(executable, args, { cwd: projectRoot, windowsHide: true });
  job.status = 'running';
  job.message = '正在执行 Demucs、GAME、ROSVOT、RMVPE、FCPE 和 OpenUtau 工程打包…';
  job.startedAt = new Date().toISOString();
  const log = createWriteStream(logPath);
  const capture = chunk => {
    const text = chunk.toString();
    log.write(chunk);
    job.output = (job.output + text).slice(-4000);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  child.on('error', error => {
    job.status = 'failed';
    job.error = error.message;
    log.end();
  });
  child.on('close', code => {
    log.end();
    if (job.status === 'failed') return;
    if (code === 0) {
      job.status = 'completed';
      job.message = '工程已生成，可以开始编辑。';
      job.finishedAt = new Date().toISOString();
    } else {
      job.status = 'failed';
      job.error = (job.output || '').trim().slice(-4000) || `工程生成进程退出：${code}`;
    }
  });
}

async function createProjectFromUpload(req) {
  if (generationBusy() || audioTools.busy()) throw new Error('已有音频正在处理，请等待完成后再上传');
  const parts = await readMultipart(req);
  const songPart = parts.get('song');
  const lyricsPart = parts.get('lyrics');
  if (!songPart?.data?.length || !lyricsPart?.data?.length) throw new Error('请同时选择歌曲文件和歌词文件');
  const songName = safeFileName(songPart.filename, 'song.mp3');
  const lyricsName = safeFileName(lyricsPart.filename, 'lyrics.lrc');
  const songExtension = extname(songName).toLowerCase();
  const lyricsExtension = extname(lyricsName).toLowerCase();
  if (!['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.wav', '.wma'].includes(songExtension)) {
    throw new Error('歌曲格式不支持，请使用 MP3、WAV、FLAC、M4A、AAC、OGG 或 WMA');
  }
  if (!['.lrc', '.txt', '.jsonl'].includes(lyricsExtension)) throw new Error('歌词格式不支持，请使用 LRC、TXT 或 JSONL');
  const idBase = projectSlug(songName);
  let id = idBase;
  while (await exists(resolve(projectsRoot, id))) id = `${idBase}-${randomUUID().slice(0, 8)}`;
  const projectDir = resolve(projectsRoot, id);
  const inputDir = resolve(projectDir, 'input');
  await mkdir(inputDir, { recursive: true });
  const songPath = resolve(inputDir, songName);
  const lyricsPath = resolve(inputDir, lyricsName);
  await writeFile(songPath, songPart.data);
  await writeFile(lyricsPath, lyricsPart.data);
  const job = { id: randomUUID(), projectId: id, projectDir, songPath, lyricsPath, status: 'queued', output: '', error: null };
  generationJobs.set(job.id, job);
  startProjectGeneration(job);
  return { id: job.id, projectId: id, status: job.status };
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function projectMeta(songId, noteMode, timingMode) {
  const catalog = JSON.parse(await readFile(resolve(root, 'assets/catalog.json'), 'utf8'));
  const entry = catalog.songs?.find(song => song.id === songId) ||
    (songId == null && catalog.songs?.find(song => song.id === catalog.defaultSong));
  if (!entry?.project) throw new Error('歌曲工程不存在，请先重新打包网站资源');
  const baseProjectFile = resolve(root, 'assets', entry.project);
  const baseProject = JSON.parse(await readFile(baseProjectFile, 'utf8'));
  const selectedNote = noteMode || baseProject.noteModeDefault || 'game-vocal';
  const noteEntry = baseProject.noteModes?.[selectedNote];
  if (!noteEntry) throw new Error('未知的音符模式：' + selectedNote);
  const selectedTiming = timingMode || baseProject.timingModeDefault || 'beat';
  const timingEntry = noteEntry.timingModes?.[selectedTiming];
  if (!timingEntry?.project) throw new Error('未知的时序模式：' + selectedTiming);
  const projectFile = resolve(root, 'assets', timingEntry.project);
  if (!projectFile.startsWith(resolve(root, 'assets') + sep)) throw new Error('歌曲工程路径越界');
  const project = JSON.parse(await readFile(projectFile, 'utf8'));
  if (baseProject.noteModes) project.noteModes = baseProject.noteModes;
  project.noteModeDefault = selectedNote;
  project.timingModeDefault = selectedTiming;
  if (!projectFile || !project) throw new Error('时序工程不存在');
  return project;
}

function projectPath(relativePath) {
  const path = resolve(projectRoot, relativePath);
  if (!path.startsWith(projectRoot + sep)) throw new Error('渲染路径越界');
  return path;
}

const jobs = new Map();

function validateProjectRequest(project, body) {
  if (project.renderMode !== 'openutau-native' || !project.nativeRender) {
    throw new Error('当前音频包没有 OpenUtau 原生渲染配置，请先重新生成音频包');
  }
  if (body.songId !== project.id) throw new Error('歌曲工程不匹配，请刷新后重试');
  if (body.fingerprint !== project.fingerprint) throw new Error('网页工程已更新，请刷新后重试');
}

function validateSequence(project, sequence, expectedLength) {
  if (!Array.isArray(sequence) || sequence.length !== expectedLength ||
      !sequence.every(id => project.sounds.some(sound => sound.id === id))) {
    throw new Error('音效序列不完整');
  }
}

function validateRange(project, start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > project.duration + .001) {
    throw new Error('试听区间无效');
  }
}

function selectPitchPath(project, requestedMode) {
  const selected = selectPitchSource(project, requestedMode);
  return { mode: selected.mode, path: selected.path ? projectPath(selected.path) : null };
}

async function startNativeJob(project, body, sequence, unitIds, rangeStart, rangeEnd) {
  if (!Array.isArray(sequence) || !Array.isArray(unitIds) || sequence.length !== unitIds.length || sequence.length === 0) {
    throw new Error('原生渲染请求无效');
  }
  validateRange(project, rangeStart, rangeEnd);
  const selectedPitch = selectPitchPath(project, body.pitchMode);
  if (selectedPitch.path) {
    try { await stat(selectedPitch.path); }
    catch { throw new Error('所选音高轨缺失，请重新分析工程：' + selectedPitch.mode); }
  }

  const id = randomUUID();
  const jobDir = resolve(jobsRoot, id);
  await mkdir(jobDir, { recursive: true });
  const output = resolve(jobDir, 'arrangement.wav');
  const ustx = resolve(jobDir, 'arrangement.ustx');
  const requestPath = resolve(jobDir, 'request.json');
  const native = project.nativeRender;
  const request = {
    voicebank: projectPath(native.voicebank),
    analysis: projectPath(native.analysis),
    pitch: selectedPitch.path || '',
    noteMode: body.noteMode || project.noteModeDefault,
    timingMode: body.timingMode || project.timingModeDefault,
    pitchMode: selectedPitch.mode,
    backing: projectPath(native.backing),
    output,
    ustx,
    sequence,
    unitIds,
    rangeStart,
    rangeEnd,
    tempoBpm: Number(project.tempo?.bpm || project.tempoBpm || 120),
    backingGain: Number.isFinite(body.backingGain) ? body.backingGain : 1,
    soundGain: Number.isFinite(body.soundGain) ? body.soundGain : 1,
  };
  await writeFile(requestPath, JSON.stringify(request, null, 2), 'utf8');

  const executable = resolve(projectRoot, 'backend/runtime/openutau-native/bin/Release/net8.0/Hachimi.OpenUtau.Native.exe');
  try { await stat(executable); } catch { throw new Error('OpenUtau 原生渲染 worker 尚未构建'); }
  const logPath = resolve(jobDir, 'worker.log');
  const log = createWriteStream(logPath);
  const job = { id, status: 'queued', createdAt: new Date().toISOString(), output, ustx };
  jobs.set(id, job);
  const child = spawn(executable, ['--request', requestPath], { cwd: dirname(executable), windowsHide: true });
  job.status = 'running';
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  child.on('error', error => {
    job.status = 'failed'; job.error = error.message; log.end();
  });
  child.on('close', async code => {
    log.end();
    if (job.status === 'failed') return;
    if (code === 0) {
      try {
        await stat(output); await stat(ustx);
        job.status = 'completed';
        job.audioUrl = `/api/render/${id}/audio`;
        job.wavUrl = job.audioUrl;
        job.ustxUrl = `/api/render/${id}/ustx`;
      } catch (error) { job.status = 'failed'; job.error = `渲染输出缺失：${error.message}`; }
    } else {
      job.status = 'failed';
      try { job.error = (await readFile(logPath, 'utf8')).slice(-4000) || `worker exited with ${code}`; }
      catch { job.error = `worker exited with ${code}`; }
    }
  });
  return { id, status: job.status };
}

async function startNativeRender(body) {
  const project = await projectMeta(body.songId, body.noteMode, body.timingMode);
  validateProjectRequest(project, body);
  if (!Array.isArray(body.sequences) || body.sequences.length !== project.phrases.length ||
      !body.sequences.every((sequence, i) => Array.isArray(sequence) && sequence.length === project.phrases[i].units.length)) {
    throw new Error('音效序列不完整');
  }
  body.sequences.forEach((sequence, i) => validateSequence(project, sequence, project.phrases[i].units.length));
  if (!Array.isArray(body.confirmed) || !body.confirmed.every(Boolean)) throw new Error('所有乐句都需要先试听并确认');
  return startNativeJob(project, body, body.sequences.flat(), project.units.map(unit => unit.id), 0, project.duration);
}

async function startNativePhrasePreview(body) {
  const project = await projectMeta(body.songId, body.noteMode, body.timingMode);
  validateProjectRequest(project, body);
  if (!Number.isInteger(body.phraseIndex) || !project.phrases[body.phraseIndex]) throw new Error('乐句编号无效');
  const phrase = project.phrases[body.phraseIndex];
  validateSequence(project, body.sequence, phrase.units.length);
  if (!phrase.units.every((id, index) => id === phrase.units[0] + index)) throw new Error('乐句单元必须连续');
  return startNativeJob(project, body, body.sequence, phrase.units, phrase.start, phrase.end);
}

async function startNativeFullPreview(body) {
  const project = await projectMeta(body.songId, body.noteMode, body.timingMode);
  validateProjectRequest(project, body);
  if (!Array.isArray(body.sequences) || body.sequences.length !== project.phrases.length ||
      !body.sequences.every((sequence, i) => Array.isArray(sequence) && sequence.length === project.phrases[i].units.length)) {
    throw new Error('音效序列不完整');
  }
  body.sequences.forEach((sequence, i) => validateSequence(project, sequence, project.phrases[i].units.length));
  return startNativeJob(project, body, body.sequences.flat(), project.units.map(unit => unit.id), 0, project.duration);
}

const audioTools = createAudioTools({ projectRoot, websiteRoot: root, analysisBusy: generationBusy });
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (await audioTools.handle(req, res, pathname)) return;
    if (req.method === 'POST' && pathname === '/api/projects') {
      try { return json(res, 202, await createProjectFromUpload(req)); }
      catch (error) { return json(res, 400, { status: 'failed', error: error.message }); }
    }
    const projectJobMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (req.method === 'GET' && projectJobMatch) {
      const job = generationJobs.get(projectJobMatch[1]);
      if (!job) return json(res, 404, { status: 'failed', error: '工程生成任务不存在或已过期' });
      return json(res, 200, {
        id: job.id,
        projectId: job.projectId,
        status: job.status,
        message: job.message,
        error: job.error,
      });
    }
    if (req.method === 'POST' && pathname === '/api/render') {
      try { return json(res, 202, await startNativeRender(await readBody(req))); }
      catch (error) { return json(res, 400, { status: 'failed', error: error.message }); }
    }
    if (req.method === 'POST' && pathname === '/api/preview') {
      try { return json(res, 202, await startNativePhrasePreview(await readBody(req))); }
      catch (error) { return json(res, 400, { status: 'failed', error: error.message }); }
    }
    if (req.method === 'POST' && pathname === '/api/full-preview') {
      try { return json(res, 202, await startNativeFullPreview(await readBody(req))); }
      catch (error) { return json(res, 400, { status: 'failed', error: error.message }); }
    }
    const match = pathname.match(/^\/api\/render\/([^/]+)\/(audio|ustx)$/);
    if (req.method === 'GET' && match) {
      const job = jobs.get(match[1]);
      if (!job) return json(res, 404, { error: '任务不存在或已过期' });
      if (job.status !== 'completed') return json(res, 409, { status: job.status, error: job.error });
      const path = match[2] === 'audio' ? job.output : job.ustx;
      const info = await stat(path);
      res.writeHead(200, { 'Content-Type': match[2] === 'audio' ? 'audio/wav' : 'text/yaml; charset=utf-8',
        'Content-Length': info.size, 'Cache-Control': 'no-store' });
      return createReadStream(path).pipe(res);
    }
    const statusMatch = pathname.match(/^\/api\/render\/([^/]+)$/);
    if (req.method === 'GET' && statusMatch) {
      const job = jobs.get(statusMatch[1]);
      return job ? json(res, 200, { id: job.id, status: job.status, error: job.error,
        audioUrl: job.audioUrl, wavUrl: job.wavUrl || job.audioUrl, ustxUrl: job.ustxUrl }) : json(res, 404, { error: '任务不存在或已过期' });
    }
    const path = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!path.startsWith(root + sep) || !types[extname(path)] || /[\\/]\./.test(path.slice(root.length))) {
      res.writeHead(404).end(); return;
    }
    const info = await stat(path);
    if (!info.isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': types[extname(path)], 'Content-Length': info.size,
      'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') res.end();
    else createReadStream(path).on('error', () => res.destroy()).pipe(res);
  } catch { res.writeHead(404).end(); }
});
server.on('error', error => {
  if (error.code === 'EADDRINUSE' && port < 4190) server.listen(++port, '127.0.0.1');
  else { console.error(error); process.exitCode = 1; }
});
server.on('listening', () => console.log('Hachimi: http://127.0.0.1:' + port));
server.listen(port, '127.0.0.1');
