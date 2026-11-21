import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { createAudioTools, processErrorMessage, runProcess } from '../audio-tools.mjs';
import { readToolResponse } from '../audio-tools.js';

async function setup(runner) {
  const root = await mkdtemp(resolve(tmpdir(), 'hachimi-audio-tools-'));
  let service = createAudioTools({ projectRoot: root, websiteRoot: resolve(root, 'website'), runner });
  const server = createServer((req, res) => {
    service.handle(req, res, new URL(req.url, 'http://localhost').pathname)
      .then(found => { if (!found) res.writeHead(404).end(); })
      .catch(error => { res.writeHead(500).end(error.message); });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const host = `http://127.0.0.1:${server.address().port}`;
  return { root, host,
    restart() { service = createAudioTools({ projectRoot: root, websiteRoot: resolve(root, 'website'), runner }); },
    async close() {
      server.closeAllConnections();
      await new Promise(done => server.close(done));
      if (!root.startsWith(resolve(tmpdir()) + sep)) throw new Error('Unexpected test directory');
      await rm(root, { recursive: true, force: true });
    },
  };
}

const upload = (name, filename = 'song.mp3', bytes = 'sample') => {
  const form = new FormData(); form.append(name, new Blob([bytes]), filename); return form;
};
const post = async (host, path, body) => {
  const response = await fetch(host + path, { method: 'POST', body });
  return { status: response.status, data: await response.json() };
};
async function finished(host, id) {
  for (let tries = 0; tries < 150; tries++) {
    const task = await (await fetch(host + '/api/audio-tools/' + id)).json();
    if (['completed', 'failed'].includes(task.status)) return task;
    await new Promise(done => setTimeout(done, 20));
  }
  throw new Error('Task did not finish');
}

async function fakeRunner(task) {
  await mkdir(task.outputDir, { recursive: true });
  const files = {};
  for (const kind of task.kind === 'separation' ? ['vocals', 'backing'] : ['mix', 'vocal', 'project', 'preview', 'report']) {
    files[kind] = resolve(task.outputDir, kind + (kind === 'project' ? '.ustx' : kind === 'report' ? '.json' : '.wav'));
    await writeFile(files[kind], kind === 'report' ? '{}' : 'RIFF-test-audio');
  }
  return { ...files, duration: 2, syllables: 7, sustainNotes: 2 };
}

test('standalone separation honors the configured native Demucs interpreter and reports a missing executable', async t => {
  const h = await setup();
  t.after(h.close);
  const previous = process.env.HACHIMI_DEMUCS_PYTHON;
  const configured = resolve(h.root, '自定义 分轨', 'python.exe');
  process.env.HACHIMI_DEMUCS_PYTHON = configured;
  t.after(() => {
    if (previous === undefined) delete process.env.HACHIMI_DEMUCS_PYTHON;
    else process.env.HACHIMI_DEMUCS_PYTHON = previous;
  });

  const start = await post(h.host, '/api/audio-tools/separate', upload('song'));
  assert.equal(start.status, 202);
  const job = await finished(h.host, start.data.id);
  assert.equal(job.status, 'failed');
  assert.ok(job.error.includes(configured));
  const log = resolve(h.root, 'backend/runtime/web-server/audio-tools', job.id, 'task.log');
  assert.equal(await readFile(log, 'utf8'), job.error + '\n');
});

test('separation upload persists inputs and exposes ranged audio and downloads after restart', async () => {
  const h = await setup(fakeRunner);
  try {
    const start = await post(h.host, '/api/audio-tools/separate', upload('song', '琵琶曲.mp3', 'original-song'));
    assert.equal(start.status, 202);
    const task = await finished(h.host, start.data.id);
    assert.equal(task.title, '琵琶曲');
    assert.equal(task.status, 'completed');
    assert.deepEqual(task.files.map(file => file.kind), ['vocals', 'backing']);
    const source = resolve(h.root, 'projects', 'upload-' + task.id, 'input/song.mp3');
    assert.equal(await readFile(source, 'utf8'), 'original-song');
    const audio = await fetch(h.host + task.files[0].url, { headers: { Range: 'bytes=0-3' } });
    assert.equal(audio.status, 206); assert.equal(await audio.text(), 'RIFF');
    assert.equal((await fetch(h.host + task.files[0].url, { headers: { Range: 'bytes=999-1000' } })).status, 416);
    const download = await fetch(h.host + task.files[1].url + '?download=1', { method: 'HEAD' });
    assert.match(download.headers.get('content-disposition'), /attachment/);
    h.restart();
    const list = await (await fetch(h.host + '/api/audio-tools')).json();
    assert.equal(list.tasks[0].status, 'completed');
    assert.equal(list.sources[0].id, 'task:' + task.id);
    assert.equal((await fetch(h.host + task.files[0].url)).status, 200);
  } finally { await h.close(); }
});

test('USTX rendering selects a completed separation without regenerating analysis', async () => {
  const calls = [];
  const h = await setup(async task => { calls.push({ kind: task.kind, backing: task.backing }); return fakeRunner(task); });
  try {
    const separated = await post(h.host, '/api/audio-tools/separate', upload('song'));
    await finished(h.host, separated.data.id);
    const form = upload('score', '琵琶曲.ustx', 'original-ustx');
    form.append('backingSource', 'task:' + separated.data.id);
    const start = await post(h.host, '/api/audio-tools/ustx', form);
    assert.equal(start.status, 202);
    const result = await finished(h.host, start.data.id);
    assert.equal(result.status, 'completed');
    assert.equal(result.syllables, 7); assert.equal(result.sustainNotes, 2);
    assert.deepEqual(calls.map(call => call.kind), ['separation', 'ustx']);
    assert.match(calls[1].backing, /backing\.wav$/);
    assert.equal(await readFile(resolve(h.root, 'backend/runtime/web-server/audio-tools', result.id, 'input/score.ustx'), 'utf8'), 'original-ustx');
    assert.ok(result.files.some(file => file.kind === 'score'));
  } finally { await h.close(); }
});

test('invalid uploads, unknown backing sources and duplicate fields are rejected', async () => {
  const h = await setup(fakeRunner);
  try {
    assert.equal((await post(h.host, '/api/audio-tools/separate', upload('song', 'song.exe'))).status, 400);
    assert.equal((await post(h.host, '/api/audio-tools/ustx', upload('score', 'song.mid'))).status, 400);
    const score = upload('score', 'score.ustx'); score.append('backingSource', '../../outside.wav');
    assert.match((await post(h.host, '/api/audio-tools/ustx', score)).data.error, /对应/);
    const duplicate = upload('song'); duplicate.append('song', new Blob(['other']), 'other.mp3');
    assert.match((await post(h.host, '/api/audio-tools/separate', duplicate)).data.error, /重复/);
    assert.equal((await (await fetch(h.host + '/api/audio-tools')).json()).tasks.length, 0);
  } finally { await h.close(); }
});

test('failed local processing is observable and never exposes partial audio', async () => {
  const h = await setup(async () => { throw new Error('missing model'); });
  try {
    const start = await post(h.host, '/api/audio-tools/separate', upload('song'));
    const task = await finished(h.host, start.data.id);
    assert.equal(task.status, 'failed'); assert.equal(task.error, 'missing model');
    assert.deepEqual(task.files, []);
    assert.equal((await fetch(h.host + '/api/audio-tools/' + task.id + '/files/vocals')).status, 409);
  } finally { await h.close(); }
});

test('a running tool task blocks a second heavy request', async () => {
  let release;
  const gate = new Promise(done => { release = done; });
  const h = await setup(async task => { await gate; return fakeRunner(task); });
  try {
    const first = await post(h.host, '/api/audio-tools/separate', upload('song'));
    const second = await post(h.host, '/api/audio-tools/separate', upload('song'));
    assert.equal(second.status, 400); assert.match(second.data.error, /正在处理/);
    release(); assert.equal((await finished(h.host, first.data.id)).status, 'completed');
  } finally { release(); await h.close(); }
});

test('frontend reports server validation errors rather than accepting failed submissions', async () => {
  await assert.rejects(readToolResponse(new Response(JSON.stringify({ error: '请选择对应伴奏' }), { status: 400 })), /对应伴奏/);
  assert.deepEqual(await readToolResponse(new Response('{"id":"task"}')), { id: 'task' });
});

test('UTF-8 subprocess errors survive split Chinese characters and retain the full diagnostic log', async () => {
  const h = await setup(fakeRunner);
  try {
    const log = resolve(h.root, 'utf8.log');
    const script = `if(process.env.PYTHONIOENCODING!=='utf-8'||process.env.PYTHONUTF8!=='1')throw Error('wrong encoding');
      const text=Buffer.from('Traceback: diagnostic details\\nRuntimeError: 中文错误\\n');
      const cut=text.indexOf(Buffer.from('中'))+1;
      process.stderr.write(text.subarray(0,cut));
      setTimeout(()=>{process.stderr.write(text.subarray(cut));process.exitCode=1;},20);`;
    await assert.rejects(runProcess(process.execPath, ['-e', script], h.root, log, () => {}), error => error.message === '中文错误');
    const saved = await readFile(log, 'utf8');
    assert.match(saved, /Traceback: diagnostic details/);
    assert.match(saved, /中文错误/);
    assert.ok(!saved.includes('\uFFFD'));
    assert.equal(processErrorMessage('Traceback details\nValueError: 工程无效\n'), '工程无效');
  } finally { await h.close(); }
});
