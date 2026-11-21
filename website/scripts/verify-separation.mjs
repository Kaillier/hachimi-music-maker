import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const base = process.env.HACHIMI_URL || 'http://127.0.0.1:4175';
const path = resolve(import.meta.dirname, '../../backend/runtime/web-server/v2m-separation-check.wav');
const form = new FormData(); form.append('song', new Blob([await readFile(path)]), '本地分轨检查.wav');
const response = await fetch(base + '/api/audio-tools/separate', { method: 'POST', body: form });
let job = await response.json();
assert.equal(response.status, 202, JSON.stringify(job));
while (['queued', 'running'].includes(job.status)) {
  await new Promise(done => setTimeout(done, 1000));
  job = await (await fetch(base + '/api/audio-tools/' + job.id)).json();
}
assert.equal(job.status, 'completed', job.error);
assert.deepEqual(job.files.map(file => file.kind), ['vocals', 'backing']);
for (const file of job.files) {
  const audio = await fetch(base + file.url, { headers: { Range: 'bytes=0-3' } });
  assert.equal(await audio.text(), 'RIFF');
}
console.log(JSON.stringify(job));
