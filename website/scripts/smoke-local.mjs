import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const base = process.env.HACHIMI_URL || 'http://127.0.0.1:4175';
const root = resolve(import.meta.dirname, '../..');
const source = process.argv[2] || (await readdir(resolve(root, 'music'))).find(name => name.includes('琵琶曲') && name.endsWith('.mp3'));
const form = new FormData();
form.append('song', new Blob([await readFile(resolve(root, 'music', source))]), source);
form.append('language', 'zh');
async function request(path, options) {
  const response = await fetch(base + path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data;
}
let job = await request('/api/projects', { method: 'POST', body: form });
console.log(JSON.stringify(job));
let previous;
while (['queued', 'running'].includes(job.status)) {
  await new Promise(resolve => setTimeout(resolve, 5000));
  job = await request('/api/project-jobs/' + job.id);
  if (job.message !== previous) { console.log(job.status, job.message); previous = job.message; }
}
console.log(JSON.stringify(job));
if (job.status !== 'completed') throw new Error(job.error);
const project = await request('/api/projects/' + job.projectId);
console.log(JSON.stringify({ projectId: project.id, notes: project.sourceNoteCount, units: project.units.length, groups: project.phrases.length,
  editorGrouping: project.editorGrouping, firstGroups: project.phrases.slice(0, 3).map(phrase => phrase.text),
  score: project.scoreFile, provenance: project.provenance }));
