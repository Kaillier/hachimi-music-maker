import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, mkdir, readFile, writeFile, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { createProjectService, renderSelection } from '../project-service.mjs';
import { PIPELINE, readProject } from '../project-store.mjs';
import { KEEP_ORIGINAL } from '../audio-core.js';

const fixture = { id: 'v2m-test', ready: true, title: '测试曲', pipeline: PIPELINE, fingerprint: 'score-hash', duration: 10,
  phrases: [{ units: [0, 1], start: 1, end: 3 }, { units: [2], start: 4, end: 5 }] };
const payload = { songId: fixture.id, fingerprint: fixture.fingerprint, sequences: [['bo', 'ji'], ['mi']], confirmed: [true, true], backingGain: .5, soundGain: .7 };

test('selection preserves exact order and gains with no mode choices or retiming', () => {
  const result = renderSelection(fixture, payload, false);
  assert.deepEqual(result.sequence, ['bo', 'ji', 'mi']);
  assert.equal(result.previewDuration, 10);
  assert.equal(result.soundGain, .7);
  const preview = renderSelection(fixture, { ...payload, phraseIndex: 0, sequences: [['bo', 'ji'], [null]], confirmed: [false, false] }, true);
  assert.deepEqual(preview.sequence, ['bo', 'ji', 'mi']);
  assert.equal(preview.previewStart, .85);
  assert.equal(preview.previewDuration, 2.4);
});
test('legacy selectors, stale scores, missing sounds and unconfirmed exports fail explicitly', () => {
  for (const key of ['noteMode', 'timingMode', 'pitchMode']) assert.throws(() => renderSelection(fixture, { ...payload, [key]: 'legacy' }, false));
  assert.throws(() => renderSelection(fixture, { ...payload, fingerprint: 'stale' }, false));
  assert.throws(() => renderSelection(fixture, { ...payload, sequences: [['ha', null], ['mi']] }, false));
  assert.throws(() => renderSelection(fixture, { ...payload, confirmed: [true, false] }, false));
  assert.throws(() => renderSelection(fixture, { ...payload, soundGain: 2 }, false));
});

test('keeping units preserves exact replacement order and joins pauses inside adjacent kept units', () => {
  const project = { ...fixture, units: [{ start: 1, end: 1.5 }, { start: 2, end: 3 }, { start: 4, end: 5 }] };
  const selection = renderSelection(project, { ...payload, sequences: [['bo', KEEP_ORIGINAL], [KEEP_ORIGINAL]] }, false);
  assert.deepEqual(selection.sequence, ['bo', 'ha', 'ha']);
  assert.deepEqual(selection.keep, { units: [1, 2], ranges: [[2, 5]] });
  const all = renderSelection(project, { ...payload, sequences: [[KEEP_ORIGINAL, KEEP_ORIGINAL], [KEEP_ORIGINAL]] }, false);
  assert.deepEqual(all.keep.ranges, [[0, project.duration]]);
  assert.equal(renderSelection(project, payload, false).keep, undefined);
  assert.throws(() => renderSelection(fixture, { ...payload, sequences: [['bo', KEEP_ORIGINAL], ['mi']] }, false), /无法定位/);
});

async function setup(runner) {
  const root = await mkdtemp(resolve(tmpdir(), 'hachimi-v2m-'));
  let service = createProjectService({ projectRoot: root, runner });
  const server = createServer((req, res) => service.handle(req, res, new URL(req.url, 'http://localhost').pathname));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const host = `http://127.0.0.1:${server.address().port}`;
  return { root, host, restart() { service = createProjectService({ projectRoot: root, runner }); },
    async close() { server.closeAllConnections(); await new Promise(done => server.close(done));
      if (!root.startsWith(resolve(tmpdir()) + sep)) throw Error('Unexpected test directory');
      await rm(root, { recursive: true, force: true }); } };
}
async function finish(host, id) {
  for (let index = 0; index < 100; index++) {
    const job = await (await fetch(host + '/api/project-jobs/' + id)).json();
    if (['completed', 'failed'].includes(job.status)) return job;
    await new Promise(done => setTimeout(done, 20));
  }
  throw Error('Timeout');
}
async function fakeRunner(task, update) {
  assert.equal(await readFile(task.input, 'utf8'), 'song-bytes');
  assert.equal(task.language, 'zh');
  const score = resolve(task.projectDir, 'source.ustx');
  await writeFile(score, 'USTX-original');
  const backing = resolve(task.projectDir, 'backing.wav');
  await writeFile(backing, 'RIFF-backing');
  const project = { ...fixture, id: task.projectId, createdAt: task.createdAt,
    scoreSha256: createHash('sha256').update('USTX-original').digest('hex'), files: { score, backing } };
  await writeFile(resolve(task.projectDir, 'project.json'), JSON.stringify(project));
  update('Done');
  return { projectId: task.projectId };
}
test('song-only upload creates persistent USTX project, downloads and catalog without static packs', async () => {
  const h = await setup(fakeRunner);
  try {
    const form = new FormData(); form.append('song', new Blob(['song-bytes']), '中文歌.mp3');
    const started = await fetch(h.host + '/api/projects', { method: 'POST', body: form });
    assert.equal(started.status, 202);
    const job = await finish(h.host, (await started.json()).id);
    assert.equal(job.status, 'completed');
    const project = await readProject(h.root, job.projectId, true);
    assert.equal(project.pipeline, PIPELINE);
    await mkdir(resolve(h.root, 'projects', 'old-analysis'), { recursive: true });
    await writeFile(resolve(h.root, 'projects/old-analysis/project.json'), JSON.stringify(fixture));
    const catalog = await (await fetch(h.host + '/api/projects')).json();
    assert.deepEqual(catalog.songs.map(p => p.id), [job.projectId]);
    assert.equal(catalog.songs[0].createdAt, job.createdAt);
    const file = await fetch(h.host + `/api/projects/${job.projectId}/files/score?download`);
    assert.match(file.headers.get('content-disposition'), /attachment/);
    assert.equal(await file.text(), 'USTX-original');
    const publicProject = await (await fetch(h.host + '/api/projects/' + job.projectId)).json();
    assert.equal('files' in publicProject, false);
    assert.equal('presetUrl' in publicProject, false);
    await writeFile(resolve(h.root, 'projects', job.projectId, 'project.json'), JSON.stringify({
      ...project, files: { ...project.files, preset: project.files.backing, presetScore: project.files.score, presetReport: project.files.score },
    }));
    for (const kind of ['preset', 'presetScore', 'presetReport']) {
      assert.equal((await fetch(h.host + `/api/projects/${job.projectId}/files/${kind}`)).status, 404);
    }
    h.restart();
    assert.equal((await finish(h.host, job.id)).status, 'completed');
    await writeFile(project.files.score, 'changed');
    const invalid = await fetch(h.host + '/api/render', { method: 'POST', body: JSON.stringify({ ...payload, songId: job.projectId }) });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /USTX/);
  } finally { await h.close(); }
});

test('project history orders by creation time rather than directory name after restart', async () => {
  const h = await setup(fakeRunner);
  try {
    await fetch(h.host + '/api/project-jobs');
    for (const [id, createdAt] of [['a', '2026-10-18T00:00:00Z'], ['b', '2026-09-18T00:00:00Z']]) {
      const taskDir = resolve(h.root, 'backend/runtime/web-server/v2m-jobs', id);
      await mkdir(taskDir);
      await writeFile(resolve(taskDir, 'task.json'), JSON.stringify({ id, kind: 'project', status: 'completed', createdAt }));
    }
    h.restart();
    const { jobs } = await (await fetch(h.host + '/api/project-jobs')).json();
    assert.deepEqual(jobs.map(job => job.id), ['a', 'b']);
  } finally { await h.close(); }
});

test('pure music submission creates a distinct project and participates in generation history and live logs', async () => {
  const h = await setup(async task => {
    assert.equal(task.kind, 'instrumental');
    assert.equal(task.language, undefined);
    assert.equal(task.lyrics, undefined);
    assert.equal(task.onlineLyrics, false);
    assert.equal(await readFile(task.input, 'utf8'), 'instrumental audio');
    await writeFile(resolve(task.taskDir, 'task.log'), '专用转录日志\n');
    await writeFile(resolve(task.projectDir, 'project.json'), JSON.stringify({ id: task.projectId }));
    return { projectId: task.projectId };
  });
  try {
    const form = new FormData();
    form.append('song', new Blob(['instrumental audio']), '纯音乐.wav');
    form.set('instrumental', 'true');
    const started = await fetch(h.host + '/api/projects', { method: 'POST', body: form });
    assert.equal(started.status, 202);
    const job = await finish(h.host, (await started.json()).id);
    assert.equal(job.status, 'completed');
    assert.equal(job.kind, 'instrumental');
    assert.match(job.projectId, /^instrumental-[a-f0-9-]+$/);
    assert.deepEqual((await (await fetch(h.host + '/api/projects')).json()).songs, []);
    assert.equal((await (await fetch(h.host + '/api/project-jobs')).json()).jobs[0].projectId, job.projectId);
    const log = await (await fetch(h.host + '/api/project-jobs/' + job.id + '/log?offset=0')).json();
    assert.equal(Buffer.from(log.chunk, 'base64').toString('utf8'), '专用转录日志\n');
    h.restart();
    assert.equal((await finish(h.host, job.id)).status, 'completed');
  } finally { await h.close(); }
});

async function uploadFixture(host) {
  const form = new FormData();
  form.append('song', new Blob(['song-bytes']), '同名歌曲.mp3');
  const started = await fetch(host + '/api/projects', { method: 'POST', body: form });
  assert.equal(started.status, 202);
  return finish(host, (await started.json()).id);
}

test('native project upload reports a missing local Demucs installation and keeps the message in the task log', async t => {
  const h = await setup();
  t.after(h.close);
  const previous = process.env.HACHIMI_DEMUCS_PYTHON;
  delete process.env.HACHIMI_DEMUCS_PYTHON;
  t.after(() => {
    if (previous !== undefined) process.env.HACHIMI_DEMUCS_PYTHON = previous;
  });

  const job = await uploadFixture(h.host);
  const interpreter = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python';
  const defaultPython = resolve(h.root, 'backend/runtime/demucs/venv', interpreter);
  assert.equal(job.status, 'failed');
  assert.ok(job.error.includes(defaultPython));
  assert.match(job.error, /setup_demucs\.ps1/);
  const log = resolve(h.root, 'backend/runtime/web-server/v2m-jobs', job.id, 'task.log');
  assert.equal(await readFile(log, 'utf8'), job.error + '\n');
});

test('project logs can be read before output exists and followed to completion by byte offset', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = await setup(async (task, update) => {
    update('正在识别歌词');
    await gate;
    await appendFile(resolve(task.taskDir, 'task.log'), '最后一行\n');
    return fakeRunner(task, update);
  });
  let job;
  try {
    const form = new FormData(); form.append('song', new Blob(['song-bytes']), '中文歌.mp3');
    const started = await fetch(h.host + '/api/projects', { method: 'POST', body: form });
    assert.equal(started.status, 202);
    job = await started.json();
    const endpoint = h.host + '/api/project-jobs/' + job.id;
    const read = async (offset = 0) => {
      const response = await fetch(`${endpoint}/log?offset=${offset}`);
      assert.equal(response.status, 200);
      return response.json();
    };
    const waiting = await read();
    assert.equal(waiting.job.status, 'running');
    assert.deepEqual([waiting.chunk, waiting.nextOffset, waiting.hasMore], ['', 0, false]);
    assert.equal((await fetch(endpoint + '/log?offset=-1')).status, 400);
    assert.equal((await fetch(h.host + '/api/project-jobs/a/log')).status, 404);

    const log = resolve(h.root, 'backend/runtime/web-server/v2m-jobs', job.id, 'task.log');
    await writeFile(log, ' '.repeat(65535) + '鼓楼\n');
    const first = await read();
    assert.equal(first.nextOffset, 65536);
    assert.equal(first.hasMore, true);
    const second = await read(first.nextOffset);
    const decoder = new TextDecoder();
    assert.equal(decoder.decode(Buffer.from(first.chunk, 'base64'), { stream: true }).trim(), '');
    assert.equal(decoder.decode(Buffer.from(second.chunk, 'base64'), { stream: true }), '鼓楼\n');
    assert.equal(second.hasMore, false);
    assert.equal((await read(second.nextOffset)).chunk, '');

    release();
    assert.equal((await finish(h.host, job.id)).status, 'completed');
    const final = await read(second.nextOffset);
    assert.equal(final.job.status, 'completed');
    assert.equal(Buffer.from(final.chunk, 'base64').toString('utf8'), '最后一行\n');
    const raw = await fetch(endpoint + '/files/log');
    assert.equal(raw.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.match(await raw.text(), /鼓楼\n最后一行/);
    const download = await fetch(endpoint + '/files/log?download');
    assert.match(download.headers.get('content-disposition'), /attachment/);
    await download.arrayBuffer();
    assert.equal((await read(final.nextOffset + 10)).reset, true);
  } finally {
    release();
    if (job) await finish(h.host, job.id);
    await h.close();
  }
});

test('section and full render caches survive restart and ignore changes that do not affect the audio', async () => {
  let renders = 0;
  const h = await setup(async (task, update, root) => {
    if (task.kind === 'project') return fakeRunner(task, update);
    renders++;
    const project = await readProject(root, task.songId);
    const wav = resolve(task.taskDir, 'result.wav');
    const report = resolve(task.taskDir, 'report.json');
    await writeFile(wav, 'RIFF-' + renders);
    await writeFile(report, JSON.stringify({ backing: project.files.backing, sourceSha256: project.scoreSha256,
      sequence: task.selection.sequence }));
    return { files: { wav, report } };
  });
  try {
    const { projectId } = await uploadFixture(h.host);
    const body = { ...payload, songId: projectId };
    const section = { ...body, phraseIndex: 0 };
    const post = (endpoint, data) => fetch(h.host + endpoint, { method: 'POST', body: JSON.stringify(data) });
    async function submit(endpoint, data) {
      const response = await post(endpoint, data);
      assert.equal(response.status, 202);
      return response.json();
    }
    async function finished(endpoint, data) {
      const job = await submit(endpoint, data);
      assert.equal((await finish(h.host, job.id)).status, 'completed');
      return job.id;
    }
    const previewId = await finished('/api/preview', section);
    const fullId = await finished('/api/full-preview', body);
    assert.equal((await submit('/api/full-preview', body)).id, fullId);

    const jobFile = id => resolve(h.root, 'backend/runtime/web-server/v2m-jobs', id, 'task.json');
    const preview = JSON.parse(await readFile(jobFile(previewId), 'utf8'));
    const full = JSON.parse(await readFile(jobFile(fullId), 'utf8'));
    delete preview.backingVersion; // Completed jobs from before the cache recorded this field.
    full.finishedAt = '2000-01-01T00:00:00.000Z';
    await writeFile(jobFile(previewId), JSON.stringify(preview));
    await writeFile(jobFile(fullId), JSON.stringify(full));
    h.restart();

    for (const [endpoint, request, expected] of [
      ['/api/preview', { ...section, confirmed: [false, false] }, previewId],
      ['/api/full-preview', body, fullId],
      ['/api/render', body, fullId],
    ]) {
      const cached = await submit(endpoint, request);
      assert.equal(cached.status, 'completed');
      assert.equal(cached.cached, true);
      assert.equal(cached.id, expected);
      assert.match(await (await fetch(h.host + cached.wavUrl)).text(), /^RIFF-/);
    }
    assert.equal(renders, 2);
    assert.equal((await post('/api/full-preview', { ...body, confirmed: [true, false] })).status, 400);
    assert.notEqual(await finished('/api/preview', { ...section, phraseIndex: 1 }), previewId);
    assert.notEqual(await finished('/api/full-preview', { ...body, soundGain: .9 }), fullId);
    assert.notEqual(await finished('/api/full-preview', { ...body, sequences: [['ji', 'bo'], ['mi']] }), fullId);

    await unlink(full.files.wav);
    const replacement = await finished('/api/full-preview', body);
    assert.notEqual(replacement, fullId);
    const project = await readProject(h.root, projectId);
    await writeFile(project.files.backing, 'RIFF-new-backing');
    assert.notEqual(await finished('/api/full-preview', body), replacement);
  } finally { await h.close(); }
});

test('deletion removes only the selected project and hides its history across restart', async () => {
  const h = await setup(async (task, update) => {
    await writeFile(resolve(task.taskDir, 'task.log'), 'Keep diagnostics');
    return fakeRunner(task, update);
  });
  try {
    const selected = await uploadFixture(h.host);
    const sibling = await uploadFixture(h.host);
    assert.equal(selected.title, sibling.title);
    const original = resolve(h.root, 'music/original.mp3');
    await mkdir(resolve(h.root, 'music'));
    await writeFile(original, 'untouched original');
    const endpoint = h.host + '/api/projects/' + selected.projectId;
    const response = await fetch(endpoint, { method: 'DELETE' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { deleted: selected.projectId });
    assert.equal((await fetch(endpoint, { method: 'DELETE' })).status, 404);
    await assert.rejects(readFile(resolve(h.root, 'projects', selected.projectId, 'backing.wav')), { code: 'ENOENT' });
    assert.equal(await readFile(original, 'utf8'), 'untouched original');
    assert.equal(await readFile(resolve(h.root, 'projects', sibling.projectId, 'backing.wav'), 'utf8'), 'RIFF-backing');
    h.restart();
    assert.deepEqual((await (await fetch(h.host + '/api/projects')).json()).songs.map(song => song.id), [sibling.projectId]);
    assert.deepEqual((await (await fetch(h.host + '/api/project-jobs')).json()).jobs.map(job => job.id), [sibling.id]);
    assert.equal(await (await fetch(h.host + '/api/project-jobs/' + selected.id + '/files/log')).text(), 'Keep diagnostics');
  } finally { await h.close(); }
});

test('deletion rejects directory links and unfinished manifests', async () => {
  const h = await setup(fakeRunner);
  try {
    await fetch(h.host + '/api/projects');
    const directory = resolve(h.root, 'preserved');
    await mkdir(directory);
    const manifest = JSON.stringify({ ...fixture, id: 'v2m-linked' });
    await writeFile(resolve(directory, 'project.json'), manifest);
    await symlink(directory, resolve(h.root, 'projects/v2m-linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const linked = await fetch(h.host + '/api/projects/v2m-linked', { method: 'DELETE' });
    assert.equal(linked.status, 400);
    assert.equal(await readFile(resolve(directory, 'project.json'), 'utf8'), manifest);
    const unfinished = resolve(h.root, 'projects/v2m-unfinished');
    await mkdir(unfinished);
    await writeFile(resolve(unfinished, 'project.json'), JSON.stringify({ ...fixture, id: 'v2m-unfinished', ready: false }));
    assert.equal((await fetch(h.host + '/api/projects/v2m-unfinished', { method: 'DELETE' })).status, 400);
    assert.equal(JSON.parse(await readFile(resolve(unfinished, 'project.json'), 'utf8')).ready, false);
  } finally { await h.close(); }
});

test('deletion is refused while a render is using the project', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = await setup((task, update) => task.kind === 'project' ? fakeRunner(task, update) : gate);
  let job;
  try {
    const project = await uploadFixture(h.host);
    const started = await fetch(h.host + '/api/render', { method: 'POST', body: JSON.stringify({ ...payload, songId: project.projectId }) });
    assert.equal(started.status, 202);
    job = await started.json();
    const response = await fetch(h.host + '/api/projects/' + project.projectId, { method: 'DELETE' });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /任务正在处理/);
    assert.equal((await readProject(h.root, project.projectId)).id, project.projectId);
  } finally {
    release({});
    if (job) await finish(h.host, job.id);
    await h.close();
  }
});

test('failed generation never publishes a project or offers a partial score', async () => {
  const h = await setup(async () => { throw Error('Vocal2Midi 测试错误'); });
  try {
    const form = new FormData(); form.append('song', new Blob(['song-bytes']), 'song.mp3');
    const job = await finish(h.host, (await (await fetch(h.host + '/api/projects', { method: 'POST', body: form })).json()).id);
    assert.equal(job.status, 'failed'); assert.match(job.error, /Vocal2Midi/);
    assert.deepEqual((await (await fetch(h.host + '/api/projects')).json()).songs, []);
    const invalid = new FormData(); invalid.append('song', new Blob(['x']), 'song.exe');
    assert.equal((await fetch(h.host + '/api/projects', { method: 'POST', body: invalid })).status, 400);
  } finally { await h.close(); }
});

test('optional local reference lyrics are saved separately and provider lookup can be disabled', async () => {
  const h = await setup(async (task, update) => {
    assert.equal(task.onlineLyrics, false);
    assert.equal(task.lyrics, resolve(task.projectDir, 'input/lyrics.lrc'));
    assert.equal(await readFile(task.lyrics, 'utf8'), '[00:01]第一行');
    return fakeRunner(task, update);
  });
  try {
    const form = new FormData();
    form.append('song', new Blob(['song-bytes']), '歌.mp3');
    form.append('lyrics', new Blob(['[00:01]第一行']), '歌.lrc');
    form.append('onlineLyrics', 'false');
    const started = await fetch(h.host + '/api/projects', { method: 'POST', body: form });
    assert.equal(started.status, 202);
    assert.equal((await finish(h.host, (await started.json()).id)).status, 'completed');
    form.set('lyrics', new Blob(['ignored']), '歌.wav');
    assert.equal((await fetch(h.host + '/api/projects', { method: 'POST', body: form })).status, 400);
  } finally { await h.close(); }
});
