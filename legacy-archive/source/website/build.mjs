import { mkdir, cp, readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('.', import.meta.url));
const assets = join(root, 'assets');
const catalog = JSON.parse(await readFile(join(assets, 'catalog.json'), 'utf8'));
for (const id of ['ha', 'ji', 'mi', 'man', 'bo']) await access(join(assets, id + '.wav'));
for (const song of catalog.songs) {
  const projectPath = join(assets, song.project);
  const project = JSON.parse(await readFile(projectPath, 'utf8'));
  await access(join(root, 'assets', project.assetBase, project.originalFile));
}
await mkdir(join(root, 'vendor'), { recursive: true });
await cp(join(root, 'node_modules/lucide/dist/umd/lucide.js'), join(root, 'vendor/lucide.js'));
await mkdir(join(root, 'dist'), { recursive: true });
for (const file of ['index.html', 'styles.css', 'app.js', 'audio-core.js', 'audio-tools.js', 'vendor', 'assets']) {
  await cp(join(root, file), join(root, 'dist', file), { recursive: true });
}
const totals = await Promise.all(catalog.songs.map(async song => {
  const project = JSON.parse(await readFile(join(assets, song.project), 'utf8'));
  return [project.phrases.length, project.units.length];
}));
console.log('Built ' + catalog.songs.length + ' songs / ' + totals.reduce((sum, item) => sum + item[0], 0) + ' phrases / ' + totals.reduce((sum, item) => sum + item[1], 0) + ' units.');
