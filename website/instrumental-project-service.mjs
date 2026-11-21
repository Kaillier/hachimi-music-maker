import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { sendFile } from './file-response.mjs';
import { nativeInstrumentalRunner, transcribeInstrumental } from './instrumental-audio.mjs';
import { safeFileName } from './uploads.mjs';

const uuidPattern = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const projectId = new RegExp('^instrumental-' + uuidPattern + '$');
const exportId = new RegExp('^' + uuidPattern + '$');
const trackId = /^track-[1-9]\d*$/;
const route = new RegExp(
  '^/api/instrumental-projects/(instrumental-' + uuidPattern + ')' +
  '(?:/(selection|export|original)|/tracks/(track-[1-9]\\d*)/preview|/export/(midi|wav))?$',
);
const pipeline = 'muscriptor-manual-melody-v1';
const epsilon = 1e-6;

class RequestError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function projectDirectory(root, id) {
  if (!projectId.test(id)) throw new RequestError('纯音乐工程不存在', 404);
  return resolve(root, 'projects', id);
}

async function existingProjectDirectory(root, id) {
  const expected = projectDirectory(await realpath(root), id);
  if (await realpath(expected) !== expected) throw new RequestError('纯音乐工程目录无效', 404);
  return expected;
}

async function writeManifest(directory, project) {
  const pending = resolve(directory, `project-${randomUUID()}.tmp`);
  await writeFile(pending, JSON.stringify(project, null, 2), { encoding: 'utf8', flag: 'wx' });
  await rename(pending, resolve(directory, 'project.json'));
}

async function readProject(root, id) {
  const directory = await existingProjectDirectory(root, id);
  const project = JSON.parse(await readFile(await fileIn(directory, 'project.json'), 'utf8'));
  if (project.id !== id || project.pipeline !== pipeline) throw new RequestError('纯音乐工程不存在', 404);
  return { directory, project };
}

async function fileIn(directory, filename) {
  const file = await realpath(resolve(directory, filename));
  if (!file.startsWith(directory + sep)) throw new RequestError('工程文件路径越界', 404);
  const info = await stat(file);
  if (!info.isFile() || !info.size) throw new RequestError('工程文件不存在或为空', 404);
  return file;
}

const sha256 = data => createHash('sha256').update(data).digest('hex');
const baseFor = id => `/api/instrumental-projects/${id}`;

function publicExport(project) {
  const base = baseFor(project.id);
  const revision = 'revision=' + project.revision;
  return { revision: project.revision, midiUrl: base + '/export/midi?download=1&' + revision,
    wavUrl: base + '/export/wav?' + revision };
}

function publicProject(project) {
  const { id, title, duration, revision, segments } = project;
  const base = baseFor(id);
  return { id, title, duration, revision, segments, originalUrl: base + '/original',
    tracks: project.tracks.map(track => ({ ...track, previewUrl: `${base}/tracks/${track.id}/preview` })),
    ...(project.export && { export: publicExport(project) }),
  };
}

export async function createInstrumentalProject(task, update, root, transcribe = transcribeInstrumental) {
  const directory = await existingProjectDirectory(root, task.projectId);
  const outputDir = resolve(directory, 'output');
  const input = await realpath(task.input);
  if (!input.startsWith(resolve(directory, 'input') + sep)) throw new Error('纯音乐输入文件路径越界');
  const result = await transcribe({ root, input, outputDir, logPath: resolve(task.taskDir, 'task.log'),
    onMessage: update, keepOriginal: true });
  if (!Number.isFinite(result.duration) || result.duration <= 0) throw new Error('无法读取纯音乐的时长');
  if (!Array.isArray(result.tracks) || !result.tracks.length) throw new Error('没有转录出可选的乐器音轨');
  const ids = new Set();
  const tracks = await Promise.all(result.tracks.map(async ({ id, label, noteCount, midi, preview }) => {
    if (!trackId.test(id) || ids.has(id) || typeof label !== 'string' || !label.trim()
        || !Number.isSafeInteger(noteCount) || noteCount < 1 || midi !== id + '.mid' || preview !== id + '.wav')
      throw new Error('音轨清单格式无效');
    ids.add(id);
    await Promise.all([fileIn(directory, `output/tracks/${midi}`), fileIn(directory, `output/tracks/${preview}`)]);
    return { id, label: label.trim(), noteCount };
  }));
  const midi = await fileIn(directory, 'output/multitrack.mid');
  await fileIn(directory, 'output/original.wav');
  await writeManifest(directory, {
    id: task.projectId, pipeline, title: task.title, createdAt: task.createdAt,
    duration: result.duration, tracks, sourceSha256: sha256(await readFile(midi)),
    revision: 0, segments: [{ start: 0, end: result.duration }],
  });
  return { projectId: task.projectId };
}

async function requestJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new RequestError('请求过大', 413);
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求格式无效');
  return value;
}

function checkRevision(project, revision) {
  if (revision !== project.revision) throw new RequestError('工程已更新，请刷新后重试', 409);
}

function validateSegments(project, segments) {
  if (!Array.isArray(segments) || !segments.length) throw new Error('请至少保留一个时间段');
  const ids = new Set(project.tracks.map(track => track.id));
  let nextStart = 0;
  return segments.map((segment, index) => {
    const last = index === segments.length - 1;
    if (!segment || typeof segment !== 'object' ||
        !Number.isFinite(segment.start) || !Number.isFinite(segment.end) ||
        Math.abs(segment.start - nextStart) > epsilon || segment.end <= nextStart ||
        segment.end > project.duration + epsilon ||
        (last && Math.abs(segment.end - project.duration) > epsilon))
      throw new Error('时间段必须从开头开始，并连续覆盖整首曲子');
    const end = last ? project.duration : segment.end;
    if (end <= nextStart || (!last && end >= project.duration)) throw new Error('时间段边界无效');
    const validated = { start: nextStart, end };
    if (Object.hasOwn(segment, 'trackId')) {
      if (segment.trackId !== null && !ids.has(segment.trackId)) throw new Error('请选择工程内的乐器音轨');
      validated.trackId = segment.trackId;
    }
    nextStart = end;
    return validated;
  });
}

async function runExport({ root, directory, output, selection }) {
  const run = await nativeInstrumentalRunner({ root, logPath: resolve(output, 'task.log'), onMessage: () => {} });
  await run('assemble_instrumental.py', await fileIn(directory, 'output/multitrack.mid'), selection, output);
}

async function verifyExport(directory) {
  await Promise.all(['main-melody.mid', 'main-melody.wav'].map(file => fileIn(directory, file)));
}

export function createInstrumentalProjectService({ projectRoot: root, externalBusy = () => false, exportRunner = runExport }) {
  const locks = new Set();
  let exporting = false;
  const busy = () => locks.size > 0;
  async function exclusive(id, task) {
    if (locks.has(id)) throw new RequestError('工程正在保存或导出，请等待完成', 409);
    locks.add(id);
    try { return await task(); }
    finally { locks.delete(id); }
  }

  async function save(id, { revision, segments }) {
    return exclusive(id, async () => {
      const { directory, project } = await readProject(root, id);
      checkRevision(project, revision);
      const validated = validateSegments(project, segments);
      if (JSON.stringify(project.segments) === JSON.stringify(validated)) return publicProject(project);
      delete project.export;
      project.segments = validated;
      project.revision++;
      await writeManifest(directory, project);
      return publicProject(project);
    });
  }

  async function exportMelody(id, { revision }) {
    if (exporting || externalBusy()) throw new RequestError('已有本地音频任务正在处理，请等待完成', 409);
    return exclusive(id, async () => {
      exporting = true;
      try {
        const { directory, project } = await readProject(root, id);
        checkRevision(project, revision);
        if (project.segments.some(segment => !Object.hasOwn(segment, 'trackId')))
          throw new Error('请为每个时间段选择主旋律音轨或留空');
        const midi = await fileIn(directory, 'output/multitrack.mid');
        if (sha256(await readFile(midi)) !== project.sourceSha256) throw new Error('源多轨 MIDI 已被修改，请重新生成工程');
        if (exportId.test(project.export?.key)) {
          try {
            await verifyExport(resolve(directory, 'exports', project.export.key));
            return publicExport(project);
          } catch (error) {
            if (error.code !== 'ENOENT' && error.status !== 404) throw error;
          }
        }
        const key = randomUUID();
        const output = resolve(directory, 'exports', key);
        await mkdir(output, { recursive: true });
        const selection = resolve(output, 'selection.json');
        await writeFile(selection, JSON.stringify({ duration: project.duration, segments: project.segments }), 'utf8');
        await exportRunner({ root, directory, output, selection });
        await verifyExport(output);
        if (sha256(await readFile(midi)) !== project.sourceSha256) throw new Error('导出期间源多轨 MIDI 已变化，请重新生成工程');
        project.export = { key };
        await writeManifest(directory, project);
        return publicExport(project);
      } finally { exporting = false; }
    });
  }

  async function remove(id) {
    return exclusive(id, async () => {
      const { directory } = await readProject(root, id);
      await rm(directory, { recursive: true, maxRetries: 2 });
      return { deleted: id };
    });
  }

  return { busy, remove, async handle(req, res, pathname) {
    if (!/^\/api\/instrumental-projects(?:\/|$)/.test(pathname)) return false;
    try {
      const matched = route.exec(pathname);
      if (!matched) throw new RequestError('纯音乐工程接口不存在', 404);
      const [, id, action, track, exportType] = matched;
      if (action === 'selection' && req.method === 'PATCH') {
        json(res, 200, await save(id, await requestJson(req)));
      } else if (action === 'export' && req.method === 'POST') {
        json(res, 200, await exportMelody(id, await requestJson(req)));
      } else if (['GET', 'HEAD'].includes(req.method)) {
        const { directory, project } = await readProject(root, id);
        if (action === 'original') {
          await sendFile(req, res, await fileIn(directory, 'output/original.wav'));
        } else if (track && project.tracks.some(item => item.id === track)) {
          await sendFile(req, res, await fileIn(directory, `output/tracks/${track}.wav`));
        } else if (exportType && exportId.test(project.export?.key)) {
          if (new URL(req.url, 'http://localhost').searchParams.get('revision') !== String(project.revision))
            throw new RequestError('主旋律工程已更新，请重新导出', 404);
          const suffix = exportType === 'midi' ? '.mid' : '.wav';
          const filename = `exports/${project.export.key}/main-melody${suffix}`;
          const download = safeFileName(project.title + '-主旋律', 'main-melody').toWellFormed() + suffix;
          await sendFile(req, res, await fileIn(directory, filename), download);
        } else if (!action && !track && !exportType) {
          json(res, 200, publicProject(project));
        } else throw new RequestError('工程文件尚未生成或不存在', 404);
      } else throw new RequestError('不支持的请求方式', 405);
    } catch (error) {
      json(res, error.status || (error.code === 'ENOENT' ? 404 : 400),
        { error: error.code === 'ENOENT' ? '纯音乐工程或文件不存在' : error.message });
    }
    return true;
  } };
}
