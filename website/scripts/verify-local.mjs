import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const base = process.env.HACHIMI_URL || 'http://127.0.0.1:4175';
async function request(path, options) {
  const response = await fetch(base + path, options);
  const data = await response.json();
  if (!response.ok) throw Error(JSON.stringify(data));
  return data;
}
const catalog = await request('/api/projects');
const project = await request('/api/projects/' + (process.argv[2] || catalog.songs[0].id));
const before = await (await fetch(base + project.scoreFile)).text();
let cursor = 0;
const pattern = ['bo', 'man', 'mi', 'ji', 'ha'];
const body = { songId: project.id, fingerprint: project.fingerprint,
  sequences: project.phrases.map(page => page.units.map(() => pattern[cursor++ % 5])),
  confirmed: project.phrases.map(() => true), backingGain: .5, soundGain: .5 };
const results = [];
for (const endpoint of ['/api/preview', '/api/full-preview', '/api/render']) {
  const payload = endpoint === '/api/preview' ? { ...body, phraseIndex: 0 } : body;
  let job = await request(endpoint, { method: 'POST', body: JSON.stringify(payload) });
  while (['running', 'queued'].includes(job.status)) {
    await new Promise(done => setTimeout(done, 700));
    job = await request('/api/render/' + job.id);
  }
  assert.equal(job.status, 'completed', job.error);
  const report = await request(`/api/render/${job.id}/files/report`);
  assert.equal(report.sourceFilesUnchanged, true);
  assert.equal(report.notesTimingTempoAndPitchCurvesPreserved, true);
  assert.equal(report.sequenceMode, 'units');
  assert.deepEqual(report.sequence, body.sequences.flat());
  const response = await fetch(base + job.wavUrl);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  const audioHash = createHash('sha256').update(bytes).digest('hex');
  results.push({ endpoint, id: job.id, audioBytes: bytes.length, audioHash, syllables: report.syllables,
    sourceSha256: report.sourceSha256, sourcePreserved: true });
  console.log(JSON.stringify(results.at(-1)));
}
assert.equal(await (await fetch(base + project.scoreFile)).text(), before);
const legacy = await fetch(base + '/api/render', { method: 'POST', body: JSON.stringify({ ...body, pitchMode: 'old' }) });
assert.equal(legacy.status, 400);
await writeFile(resolve(import.meta.dirname, '../../projects', project.id, 'verification.json'), JSON.stringify({ results, legacyRejected: true, sourceUnchanged: true }, null, 2));
console.log('Verified USTX-only preview, full preview and export.');
