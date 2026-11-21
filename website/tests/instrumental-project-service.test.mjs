import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import test from 'node:test';
import { createInstrumentalProject, createInstrumentalProjectService } from '../instrumental-project-service.mjs';

async function setup(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'hachimi-instrumental-project-'));
  const projectId = 'instrumental-' + randomUUID();
  const projectDir = resolve(root, 'projects', projectId);
  const input = resolve(projectDir, 'input/song.wav');
  await mkdir(resolve(projectDir, 'input'), { recursive: true });
  await writeFile(input, 'original audio');
  const task = { projectId, input, title: '纯音乐', createdAt: new Date().toISOString(), taskDir: projectDir };
  const create = await createInstrumentalProject(task, () => {}, root, async ({ outputDir, keepOriginal }) => {
    assert.equal(keepOriginal, true);
    const directory = resolve(outputDir, 'tracks');
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(outputDir, 'original.wav'), 'RIFF original');
    await writeFile(resolve(outputDir, 'multitrack.mid'), 'MThd original');
    await writeFile(resolve(directory, 'track-3.mid'), 'MThd track 3');
    await writeFile(resolve(directory, 'track-3.wav'), 'RIFF track 3');
    return { duration: 12.002, tracks: [
      { id: 'track-3', label: '长笛', noteCount: 20, midi: 'track-3.mid', preview: 'track-3.wav' },
    ] };
  });
  assert.deepEqual(create, { projectId });
  const exports = [];
  const exportRunner = async ({ output, selection }) => {
    exports.push(JSON.parse(await readFile(selection, 'utf8')));
    await writeFile(resolve(output, 'main-melody.mid'), 'MThd melody');
    await writeFile(resolve(output, 'main-melody.wav'), 'RIFF melody');
  };
  let service = createInstrumentalProjectService({ projectRoot: root, exportRunner });
  const server = createServer((req, res) => service.handle(req, res, new URL(req.url, 'http://localhost').pathname)
    .then(matched => { if (!matched) res.writeHead(404).end(); })
    .catch(error => res.writeHead(500).end(error.message)));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(done => server.close(done));
    if (!root.startsWith(resolve(tmpdir()) + sep)) throw new Error('Unexpected test directory');
    await rm(root, { recursive: true, force: true });
  });
  const host = 'http://127.0.0.1:' + server.address().port;
  return {
    projectDir, exports, category: '/api/instrumental-projects/' + projectId, host,
    restart() { service = createInstrumentalProjectService({ projectRoot: root, exportRunner }); },
    remove() { return service.remove(projectId); },
  };
}

function send(host, url, method, body) {
  return fetch(host + url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

test('instrumental project persists editable range assignments with silence and an export tied to the saved revision', async t => {
  const { category, host, exports, restart } = await setup(t);
  const initial = await (await fetch(host + category)).json();
  assert.equal(initial.revision, 0);
  assert.deepEqual(initial.segments, [{ start: 0, end: 12.002 }]);
  const original = await fetch(host + initial.originalUrl, { headers: { Range: 'bytes=0-3' } });
  assert.equal(original.status, 206);
  assert.equal(await original.text(), 'RIFF');
  assert.equal(await (await fetch(host + initial.tracks[0].previewUrl)).text(), 'RIFF track 3');

  assert.equal((await send(host, category + '/export', 'POST', { revision: 0 })).status, 400);
  const segments = [{ start: 0, end: 4, trackId: 'track-3' }, { start: 4, end: 12.002, trackId: null }];
  const save = await send(host, category + '/selection', 'PATCH', { revision: 0, segments });
  assert.equal(save.status, 200);
  assert.equal((await save.json()).revision, 1);
  assert.equal((await send(host, category + '/selection', 'PATCH', { revision: 0, segments })).status, 409);
  restart();
  assert.deepEqual((await (await fetch(host + category)).json()).segments, segments);

  const response = await send(host, category + '/export', 'POST', { revision: 1 });
  assert.equal(response.status, 200);
  const output = await response.json();
  assert.deepEqual(exports, [{ duration: 12.002, segments }]);
  const midi = await fetch(host + output.midiUrl);
  assert.match(midi.headers.get('content-disposition'), /attachment/);
  assert.equal(await midi.text(), 'MThd melody');
  assert.equal(await (await fetch(host + output.wavUrl)).text(), 'RIFF melody');
  assert.equal((await send(host, category + '/export', 'POST', { revision: 1 })).status, 200);
  assert.equal(exports.length, 1);
  const silence = [{ start: 0, end: 12.002, trackId: null }];
  assert.equal((await send(host, category + '/selection', 'PATCH', { revision: 1, segments: silence })).status, 200);
  assert.equal((await send(host, category + '/export', 'POST', { revision: 2 })).status, 200);
  assert.equal((await fetch(host + output.midiUrl)).status, 404);
});

test('instrumental range validation rejects gaps and foreign tracks and refuses an externally changed MIDI', async t => {
  const { category, host, projectDir, remove } = await setup(t);
  for (const segments of [
    [{ start: 0, end: 10, trackId: 'track-3' }],
    [{ start: 0, end: 1, trackId: 'track-3' }, { start: 2, end: 12.002, trackId: null }],
    [{ start: 0, end: 12.002, trackId: 'track-9' }],
  ]) assert.equal((await send(host, category + '/selection', 'PATCH', { revision: 0, segments })).status, 400);
  assert.equal((await send(host, category + '/selection', 'PATCH', {
    revision: 0, segments: [{ start: 0, end: 12.002, trackId: 'track-3' }],
  })).status, 200);
  await writeFile(resolve(projectDir, 'output/multitrack.mid'), 'changed');
  const response = await send(host, category + '/export', 'POST', { revision: 1 });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /已被修改/);
  await remove();
  assert.equal((await fetch(host + category)).status, 404);
});
