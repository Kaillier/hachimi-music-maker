import { mkdir, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('.', import.meta.url));
await mkdir(join(root, 'vendor'), { recursive: true });
await cp(join(root, 'node_modules/lucide/dist/umd/lucide.js'), join(root, 'vendor/lucide.js'));
await mkdir(join(root, 'dist'), { recursive: true });
for (const file of ['index.html', 'generate.html', 'task-log.html', 'styles.css', 'app.js', 'project-generation.js',
  'task-log.js', 'audio-core.js', 'audio-tools.js', 'sound-packs.json', 'vendor', 'images'])
  await cp(join(root, file), join(root, 'dist', file), { recursive: true });
console.log('Built local Vocal2Midi studio. Songs are served from projects/ through the local API.');
