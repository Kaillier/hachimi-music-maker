import { appendFile, mkdir, open, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, extname, resolve, delimiter } from 'node:path';
import { readMultipart, AUDIO_EXTENSIONS, safeFileName } from './uploads.mjs';
import { PIPELINE, readProject, removeProject, listProjects, browserProject, workspaceFile } from './project-store.mjs';
import { DEFAULT_SOUND_PACK, KEEP_ORIGINAL, SOUND_IDS } from './audio-core.js';
import { runProcess } from './local-process.mjs';
import { sendFile } from './file-response.mjs';
import { separateAudio } from './separate-audio.mjs';
import { createInstrumentalProject } from './instrumental-project-service.mjs';

const active = job => ['queued', 'running'].includes(job.status);
const generation = job => job?.kind === 'project' || job?.kind === 'instrumental';
const generationMessages = { project: '歌曲工程已生成', instrumental: '主旋律工程已生成，请分段选择音轨' };
const markDeleted = task => Object.assign(task, { status: 'deleted', message: '工程已删除' });
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
const lyricSources = { uploaded: '上传歌词', 'lddc-local': 'LDDC 本地歌词', 'lddc-online': 'LDDC 在线歌词', asr: '自动识别歌词' };
const lddcProcessOptions = () => ({ timeoutMs: 45000, env: process.env.HACHIMI_LDDC_USE_PROXY === '1' ? undefined : {
  HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*',
  http_proxy: '', https_proxy: '', all_proxy: '', no_proxy: '*',
} });

function renderKey({ kind, songId, fingerprint, selection }) {
  const { sequence, backingGain, soundGain, previewStart, previewDuration, keep } = selection;
  return createHash('sha256').update(JSON.stringify([
    kind, songId, fingerprint, sequence, backingGain, soundGain, previewStart, previewDuration, ...(keep ? [keep] : []),
  ])).digest('hex');
}

async function readLogChunk(path, requestedOffset) {
  let file;
  try { file = await open(path, 'r'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { chunk: '', nextOffset: 0, hasMore: false, reset: requestedOffset > 0 };
  }
  try {
    const { size } = await file.stat();
    const reset = requestedOffset > size;
    const offset = reset ? 0 : requestedOffset;
    const buffer = Buffer.alloc(Math.min(size - offset, 64 * 1024));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    const nextOffset = offset + bytesRead;
    return { chunk: buffer.subarray(0, bytesRead).toString('base64'), nextOffset,
      hasMore: bytesRead > 0 && nextOffset < size, reset };
  } finally { await file.close(); }
}

export function renderSelection(project, body, preview) {
  const allowed = ['songId', 'fingerprint', 'sequences', 'confirmed', 'backingGain', 'soundGain', 'phraseIndex'];
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new Error('请求包含已停用或未知的模式参数，请刷新网页');
  if (body.fingerprint !== project.fingerprint) throw new Error('工程已更新，请刷新后重新编排');
  if (!Array.isArray(body.sequences) || body.sequences.length !== project.phrases.length) throw new Error('编排段数量与 USTX 不一致');
  if (preview && (!Number.isInteger(body.phraseIndex) || !project.phrases[body.phraseIndex])) throw new Error('编排段不存在');
  const pattern = DEFAULT_SOUND_PACK.pattern;
  let cursor = 0;
  let unitIndex = 0, run = null;
  const keep = { units: [], ranges: [] };
  const sequence = body.sequences.flatMap((values, index) => {
    if (!Array.isArray(values) || values.length !== project.phrases[index].units.length) throw new Error('音效数量与 USTX 不一致');
    return values.map((value, slot) => {
      const ordinal = unitIndex++;
      if (value === KEEP_ORIGINAL) {
        const unit = project.units?.[project.phrases[index].units[slot]];
        if (!unit || !Number.isFinite(unit.start) || !Number.isFinite(unit.end) ||
            unit.start < 0 || Math.min(unit.end, project.duration) <= unit.start)
          throw new Error('无法定位需要保留原声的音符');
        keep.units.push(ordinal);
        const end = Math.min(unit.end, project.duration);
        if (!run) {
          const previous = keep.ranges.at(-1);
          run = previous && unit.start <= previous[1] ? previous : [unit.start, end];
          if (run !== previous) keep.ranges.push(run);
        }
        run[1] = Math.max(run[1], end);
        return pattern[0];
      }
      run = null;
      const fallback = pattern[cursor++ % pattern.length];
      if (preview && index !== body.phraseIndex && value === null) return fallback;
      if (!SOUND_IDS.includes(value)) throw new Error('请填满所有需要试听的发音单位');
      return value;
    });
  });
  if (sequence.length && keep.units.length === sequence.length) keep.ranges = [[0, project.duration]];
  if (!preview && (!Array.isArray(body.confirmed) || body.confirmed.length !== project.phrases.length || !body.confirmed.every(value => value === true)))
    throw new Error('请先确认全部编排段');
  const gains = {};
  for (const name of ['backingGain', 'soundGain']) {
    if (!Number.isFinite(body[name]) || body[name] < 0 || body[name] > 1.5) throw new Error('音量应介于 0 和 150%');
    gains[name] = body[name];
  }
  const page = preview ? project.phrases[body.phraseIndex] : null;
  return { sequence, ...(keep.units.length ? { keep } : {}), ...gains, previewStart: page ? Math.max(0, page.start - .15) : 0,
    previewDuration: page ? Math.min(project.duration, page.end + .25) - Math.max(0, page.start - .15) : project.duration };
}

export async function nativeProjectRunner(task, update, root) {
  if (task.kind === 'instrumental') return createInstrumentalProject(task, update, root);
  const log = resolve(task.taskDir, 'task.log');
  const python = process.env.HACHIMI_AUDIO_PYTHON || resolve(root, 'Vocal2Midi/python/python.exe');
  const run = (exe, args, cwd = root, options) => runProcess(exe, args, cwd, log, update, options);
  if (task.kind === 'project') {
    update('1/4 · Demucs 正在分离人声和伴奏…');
    const separated = await separateAudio({ root, input: task.input, projectDir: task.projectDir,
      resultPath: resolve(task.projectDir, 'separation.json'), logPath: log, onMessage: update });
    update('2/4 · LDDC 正在查找参考歌词…');
    const lyricResult = resolve(task.projectDir, 'lyric-reference.json');
    let lyrics = { lines: [], source: 'asr', detail: null };
    try {
      await run(python, ['-X', 'utf8', resolve(root, 'backend/pipeline/lyric_reference.py'), '--song', task.input,
        '--name', task.title, '--duration', String(separated.duration), '--language', task.language, '--output', lyricResult,
        ...(task.lyrics ? ['--lyrics', task.lyrics] : []), ...(task.onlineLyrics ? ['--online'] : [])], root, lddcProcessOptions());
      lyrics = JSON.parse(await readFile(lyricResult, 'utf8'));
    } catch (error) {
      if (task.lyrics) throw new Error('参考歌词读取失败：' + error.message);
      await appendFile(log, `LDDC lookup failed; using Vocal2Midi ASR: ${error.message}\n`, 'utf8');
      lyrics.detail = 'lookup-failed';
    }
    const textFile = resolve(task.projectDir, 'reference-lyrics.txt');
    const reference = lyrics.lines.length ? ['--lyrics-file', textFile] : [];
    if (reference.length) await writeFile(textFile, lyrics.vocal2midiLines.join('\n') + '\n', 'utf8');
    update(`3/4 · Vocal2Midi 正在生成 USTX（${lyricSources[lyrics.source]}）…`);
    const v2m = resolve(root, 'Vocal2Midi');
    const output = resolve(task.projectDir, 'vocal2midi');
    await run(python, ['-X', 'utf8', resolve(v2m, 'scripts/auto_lyric_cli.py'), workspaceFile(root, separated.vocals),
      '-o', output, '--language', task.language, '--formats', 'ustx', 'asr_match_log', '--pitch-curve', '--device', 'dml', ...reference], v2m,
    { env: { V2M_PORTABLE_ROOT: v2m, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', PATH: v2m + delimiter + process.env.PATH } });
    const scores = (await readdir(output)).filter(file => file.endsWith('.ustx'));
    if (scores.length !== 1) throw new Error('Vocal2Midi 没有生成唯一的 USTX，请查看任务日志');
    const score = resolve(output, scores[0]);
    update('4/4 · 正在按歌词行整理 USTX 发音单位…');
    const manifest = resolve(task.projectDir, 'project.json');
    await run(python, ['-X', 'utf8', resolve(root, 'backend/pipeline/project_index.py'), '--id', task.projectId, '--title', task.title,
      '--song', task.input, '--original', workspaceFile(root, separated.original), '--vocals', workspaceFile(root, separated.vocals),
      '--backing', workspaceFile(root, separated.backing), '--score', score, '--output', manifest, ...reference,
      '--asr-log', resolve(output, basename(score, '.ustx') + '_asr_match_log.txt')]);
    const project = JSON.parse(await readFile(manifest, 'utf8'));
    project.ready = true;
    project.createdAt = task.createdAt;
    project.provenance = { kind: 'automatic', tool: 'Vocal2Midi/scripts/auto_lyric_cli.py', language: task.language,
      input: 'Demucs vocals', pitchCurve: true, lyrics: { source: lyrics.source, detail: lyrics.detail },
      log: resolve(task.taskDir, 'task.log').replace(root, '').replaceAll('\\', '/').replace(/^\//, '') };
    await writeFile(manifest, JSON.stringify(project, null, 2), 'utf8');
    return { projectId: project.id };
  }
  update('OpenUtau 正在按原始 USTX 和当前音效顺序渲染…');
  const project = await readProject(root, task.songId, true);
  if (project.fingerprint !== task.fingerprint) throw new Error('渲染工程已更新');
  const sequenceFile = resolve(task.taskDir, 'sequence.json');
  await writeFile(sequenceFile, JSON.stringify(task.selection.sequence));
  const keepFile = resolve(task.taskDir, 'keep-original.json');
  if (task.selection.keep) await writeFile(keepFile, JSON.stringify(task.selection.keep));
  await run(python, ['-X', 'utf8', resolve(root, 'backend/pipeline/render_vocal2midi.py'), workspaceFile(root, project.files.score),
    '--backing', workspaceFile(root, project.files.backing), '--output-dir', resolve(task.taskDir, 'output'), '--sequence-file', sequenceFile,
    '--preview-start', String(task.selection.previewStart), '--preview-duration', String(task.selection.previewDuration),
    '--backing-gain', String(task.selection.backingGain), '--sound-gain', String(task.selection.soundGain),
    ...(task.selection.keep ? ['--keep-original', keepFile, '--original', workspaceFile(root, project.files.original)] : [])]);
  const report = JSON.parse(await readFile(resolve(task.taskDir, 'output/report.json'), 'utf8'));
  return { files: { wav: task.kind === 'preview' ? report.preview : report.mix, ustx: report.project, report: resolve(task.taskDir, 'output/report.json') } };
}

export function createProjectService({ projectRoot: root, externalBusy = () => false, runner = nativeProjectRunner, removeInstrumentalProject }) {
  const storage = resolve(root, 'backend/runtime/web-server/v2m-jobs');
  const tasks = new Map();
  const completedRenders = new Map();
  let accepting = false;
  async function persist(task) {
    const pending = resolve(task.taskDir, 'task.json.tmp');
    await writeFile(pending, JSON.stringify(task, null, 2), 'utf8');
    await rename(pending, resolve(task.taskDir, 'task.json'));
  }
  function rememberRender(task) {
    if (task.status !== 'completed' || !['preview', 'render'].includes(task.kind) ||
        !task.files?.wav || !Array.isArray(task.selection?.sequence)) return;
    const key = renderKey(task);
    const matches = completedRenders.get(key) || [];
    matches.unshift(task);
    completedRenders.set(key, matches);
  }
  async function cachedRender(request, project, backingPath, backingInfo) {
    for (const task of completedRenders.get(renderKey(request)) || []) {
      try {
        if (task.backingVersion !== request.backingVersion) {
          // Earlier jobs recorded the backing path and score hash in the native report.
          const finishedAt = Date.parse(task.finishedAt);
          if (task.backingVersion || !Number.isFinite(finishedAt) ||
              Math.max(backingInfo.mtimeMs, backingInfo.ctimeMs) > finishedAt) continue;
          const report = JSON.parse(await readFile(workspaceFile(root, task.files.report), 'utf8'));
          if (resolve(report.backing) !== backingPath || report.sourceSha256 !== project.scoreSha256 ||
              JSON.stringify(report.sequence) !== JSON.stringify(request.selection.sequence)) continue;
        }
        const files = await Promise.all(Object.values(task.files).map(file => stat(workspaceFile(root, file))));
        if (files.every(file => file.isFile() && file.size > 0)) return task;
      } catch { /* A missing or unreadable output can be regenerated. */ }
    }
  }
  const ready = (async () => {
    await mkdir(storage, { recursive: true });
    await mkdir(resolve(root, 'projects'), { recursive: true });
    for (const dir of await readdir(storage, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      try {
        const task = JSON.parse(await readFile(resolve(storage, dir.name, 'task.json'), 'utf8'));
        if (active(task)) { task.status = 'failed'; task.error = '服务已重启，请重新提交'; await persist(task); }
        if (generation(task) && task.status === 'completed' && task.projectId) {
          try {
            if (task.kind === 'project') await readProject(root, task.projectId);
            else await stat(workspaceFile(root, resolve(root, 'projects', task.projectId, 'project.json')));
          }
          catch (error) { if (error.code === 'ENOENT') markDeleted(task); }
        }
        tasks.set(task.id, task);
        rememberRender(task);
      } catch { /* Incomplete uploads are not runnable jobs. */ }
    }
  })();
  const busy = () => accepting || [...tasks.values()].some(active);
  const publicTask = task => ({ id: task.id, projectId: task.projectId, kind: task.kind, title: task.title, status: task.status,
    message: task.message, error: task.error, createdAt: task.createdAt,
    wavUrl: task.files?.wav ? `/api/render/${task.id}/files/wav` : undefined,
    ustxUrl: task.files?.ustx ? `/api/render/${task.id}/files/ustx` : undefined });
  async function processTask(task) {
    task.status = 'running';
    let result;
    try {
      await persist(task);
      result = await runner(task, message => { task.message = message; }, root);
      result = { ...result, status: 'completed', message: generationMessages[task.kind] || 'OpenUtau 渲染完成' };
    } catch (error) { result = { status: 'failed', error: error.message }; }
    const finished = { ...task, ...result, finishedAt: new Date().toISOString() };
    try { await persist(finished); }
    catch (error) {
      Object.assign(task, { status: 'failed', error: '无法保存本地任务结果：' + error.message });
      throw error;
    }
    Object.assign(task, finished);
    rememberRender(task);
  }
  async function accept(task) {
    await mkdir(task.taskDir, { recursive: true });
    await persist(task);
    tasks.set(task.id, task);
    processTask(task).catch(error => console.error(error));
    return publicTask(task);
  }
  async function create(req) {
    if (busy() || externalBusy()) throw new Error('已有本地任务正在处理，请等待完成');
    accepting = true;
    try {
      const parts = await readMultipart(req);
      const song = parts.get('song');
      const filename = safeFileName(song?.filename || '', 'song.wav');
      if (!song?.data.length || !AUDIO_EXTENSIONS.has(extname(filename).toLowerCase())) throw new Error('请选择支持的歌曲音频文件');
      const instrumentalFlag = parts.get('instrumental')?.data.toString('utf8') ?? 'false';
      if (!['true', 'false'].includes(instrumentalFlag)) throw new Error('纯音乐选项无效');
      const instrumental = instrumentalFlag === 'true';
      const language = instrumental ? undefined : parts.get('language')?.data.toString('utf8') || 'zh';
      if (!instrumental && !['zh', 'en', 'ja', 'yue'].includes(language)) throw new Error('不支持的歌曲语言');
      const lyricPart = instrumental ? undefined : parts.get('lyrics');
      const lyricExtension = extname(lyricPart?.filename || '').toLowerCase();
      if (lyricPart && (!['.lrc', '.txt'].includes(lyricExtension) || !lyricPart.data.length || lyricPart.data.length > 1024 * 1024))
        throw new Error('参考歌词须为不超过 1 MB 的 LRC 或 UTF-8 TXT 文件');
      const onlineLyrics = !instrumental && parts.get('onlineLyrics')?.data.toString('utf8') !== 'false';
      const id = randomUUID();
      const projectId = (instrumental ? 'instrumental-' : 'v2m-') + id;
      const projectDir = resolve(root, 'projects', projectId);
      await mkdir(resolve(projectDir, 'input'), { recursive: true });
      const input = resolve(projectDir, 'input/song' + extname(filename).toLowerCase());
      await writeFile(input, song.data);
      const lyrics = lyricPart ? resolve(projectDir, 'input/lyrics' + lyricExtension) : undefined;
      if (lyrics) await writeFile(lyrics, lyricPart.data);
      return await accept({ id, kind: instrumental ? 'instrumental' : 'project', projectId, projectDir, input, lyrics, onlineLyrics, language, title: basename(filename, extname(filename)),
        taskDir: resolve(storage, id), status: 'queued', createdAt: new Date().toISOString() });
    } finally { accepting = false; }
  }
  async function render(req, kind) {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new Error('请求过大'); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const project = await readProject(root, body.songId, true);
    const selection = renderSelection(project, body, kind === 'preview');
    const backingPath = workspaceFile(root, project.files.backing);
    const backingInfo = await stat(backingPath);
    const backingVersionData = [project.files.backing, backingInfo.size, backingInfo.mtimeMs, backingInfo.ctimeMs];
    if (selection.keep) {
      const original = await stat(workspaceFile(root, project.files.original));
      backingVersionData.push(project.files.original, original.size, original.mtimeMs, original.ctimeMs);
    }
    const backingVersion = JSON.stringify(backingVersionData);
    const request = { kind, songId: project.id, fingerprint: project.fingerprint, title: project.title, selection, backingVersion };
    const cached = await cachedRender(request, project, backingPath, backingInfo);
    if (cached) return { ...publicTask(cached), cached: true };
    if (busy() || externalBusy()) throw new Error('已有本地任务正在处理，请等待完成');
    accepting = true;
    try {
      const id = randomUUID();
      return await accept({ ...request, id,
        taskDir: resolve(storage, id), status: 'queued', createdAt: new Date().toISOString() });
    } finally { accepting = false; }
  }
  async function remove(id) {
    if (busy() || externalBusy()) throw new Error('已有本地任务正在处理，请等待完成后再删除工程');
    accepting = true;
    try {
      if (id.startsWith('instrumental-') && removeInstrumentalProject) await removeInstrumentalProject(id);
      else await removeProject(root, id);
      for (const task of tasks.values()) {
        if (generation(task) && task.projectId === id) markDeleted(task);
      }
      return { deleted: id };
    } finally { accepting = false; }
  }
  return { busy, async handle(req, res, pathname) {
    if (!/^\/api\/(projects|project-jobs|render|preview|full-preview)(\/|$)/.test(pathname)) return false;
    await ready;
    try {
      if (pathname === '/api/projects' && req.method === 'GET') {
        const projects = await listProjects(root);
        json(res, 200, { pipeline: PIPELINE, songs: projects.map(p => ({
          id: p.id, title: p.title, createdAt: p.createdAt, project: `/api/projects/${p.id}`,
        })) });
      } else if (pathname === '/api/projects' && req.method === 'POST') json(res, 202, await create(req));
      else if (['/api/render', '/api/preview', '/api/full-preview'].includes(pathname) && req.method === 'POST')
        json(res, 202, await render(req, pathname === '/api/preview' ? 'preview' : 'render'));
      else if (pathname === '/api/project-jobs' && req.method === 'GET') {
        const history = [...tasks.values()].filter(t => generation(t) && t.status !== 'deleted')
          .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        json(res, 200, { jobs: history.map(publicTask) });
      } else {
        const match = /^\/api\/projects\/(v2m-[a-z0-9-]+)(?:\/files\/(\w+))?$/.exec(pathname);
        const instrumentalMatch = /^\/api\/projects\/(instrumental-[a-f0-9-]+)$/.exec(pathname);
        const logMatch = /^\/api\/project-jobs\/([a-f0-9-]+)\/log$/.exec(pathname);
        const jobMatch = /^\/api\/(?:project-jobs|render)\/([a-f0-9-]+)(?:\/files\/(wav|ustx|report|log))?$/.exec(pathname);
        if (logMatch && req.method === 'GET') {
          const task = tasks.get(logMatch[1]);
          if (!generation(task)) json(res, 404, { error: '任务不存在' });
          else {
            const offset = new URL(req.url, 'http://local').searchParams.get('offset') ?? '0';
            if (!/^\d+$/.test(offset) || !Number.isSafeInteger(Number(offset))) throw new Error('日志位置无效');
            const job = publicTask(task);
            const log = await readLogChunk(workspaceFile(root, resolve(task.taskDir, 'task.log')), Number(offset));
            json(res, 200, { job, ...log });
          }
        } else if (match && !match[2] && req.method === 'DELETE') {
          json(res, 200, await remove(match[1]));
        } else if (instrumentalMatch && req.method === 'DELETE') {
          json(res, 200, await remove(instrumentalMatch[1]));
        } else if (match && ['GET', 'HEAD'].includes(req.method)) {
          const project = await readProject(root, match[1]);
          const kind = match[2];
          if (!kind) json(res, 200, browserProject(project));
          else if (!['original', 'vocals', 'backing', 'score'].includes(kind) || !project.files[kind]) json(res, 404, { error: '文件不存在' });
          else await sendFile(req, res, workspaceFile(root, project.files[kind]), new URL(req.url, 'http://local').searchParams.has('download') ? project.title + '-' + kind + extname(project.files[kind]) : undefined);
        } else if (jobMatch && ['GET', 'HEAD'].includes(req.method)) {
          const task = tasks.get(jobMatch[1]);
          if (!task) json(res, 404, { error: '任务不存在' });
          else if (!jobMatch[2]) json(res, 200, publicTask(task));
          else {
            const file = jobMatch[2] === 'log' ? resolve(task.taskDir, 'task.log') : task.status === 'completed' && task.files?.[jobMatch[2]];
            if (!file) json(res, 404, { error: '文件未生成' });
            else await sendFile(req, res, workspaceFile(root, file), new URL(req.url, 'http://local').searchParams.has('download') ? task.title + extname(file) : undefined);
          }
        } else json(res, 404, { error: '接口不存在' });
      }
    } catch (error) {
      if (req.method === 'DELETE' && error.code === 'ENOENT') json(res, 404, { error: '工程不存在或已删除' });
      else json(res, 400, { error: error.message });
    }
    return true;
  } };
}
