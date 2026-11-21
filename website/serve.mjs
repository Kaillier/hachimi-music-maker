import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAudioTools } from './audio-tools.mjs';
import { createProjectService } from './project-service.mjs';
import { createInstrumentalProjectService } from './instrumental-project-service.mjs';
import { sendFile } from './file-response.mjs';
import { DEFAULT_SOUND_PACK, SOUND_IDS } from './audio-core.js';

const websiteRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(websiteRoot, '..');
let audioTools, instrumentalProjects;
const projects = createProjectService({
  projectRoot,
  externalBusy: () => audioTools?.busy() || instrumentalProjects?.busy() || false,
  removeInstrumentalProject: id => instrumentalProjects.remove(id),
});
audioTools = createAudioTools({ projectRoot, websiteRoot, analysisBusy: () => projects.busy() || instrumentalProjects?.busy() || false });
instrumentalProjects = createInstrumentalProjectService({ projectRoot, externalBusy: () => projects.busy() || audioTools.busy() });
const staticFiles = new Set(['index.html', 'generate.html', 'task-log.html', 'instrumental.html', 'styles.css', 'instrumental-project.css', 'app.js', 'project-generation.js', 'instrumental-project.js', 'task-log.js', 'audio-core.js', 'audio-tools.js',
  'sound-packs.json', 'vendor/lucide.js', 'images/dingdongji.png', 'images/manbo.png', 'images/hachimi.png']);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    if (await projects.handle(req, res, pathname) || await audioTools.handle(req, res, pathname) ||
        await instrumentalProjects.handle(req, res, pathname)) return;
    const sound = /^\/api\/sounds\/([a-z0-9_]+)$/.exec(pathname);
    if (sound && SOUND_IDS.includes(sound[1]) && ['GET', 'HEAD'].includes(req.method)) {
      const directory = DEFAULT_SOUND_PACK.pattern.includes(sound[1]) ? 'audio' : 'voicebanks/selected';
      await sendFile(req, res, resolve(projectRoot, directory, sound[1] + '.wav')); return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(404).end('Not found'); return; }
    if (pathname === '/' && url.searchParams.has('song')) {
      res.writeHead(302, { Location: '/arrange' + url.search }).end(); return;
    }
    const file = pathname === '/' || pathname === '/generate' ? 'generate.html'
      : pathname === '/arrange' ? 'index.html' : pathname === '/task-log' ? 'task-log.html'
      : pathname === '/instrumental' ? 'instrumental.html' : pathname.slice(1);
    if (!staticFiles.has(file)) { res.writeHead(404).end('Not found'); return; }
    const path = resolve(websiteRoot, file);
    if (!path.startsWith(websiteRoot + sep)) { res.writeHead(404).end(); return; }
    const content = await readFile(path);
    res.writeHead(200, { 'Content-Type': types[extname(file)], 'Content-Length': (await stat(path)).size, 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch (error) {
    if (res.headersSent) res.destroy();
    else { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: error.message })); }
  }
});
const port = Number(process.argv[2] || 4175);
server.listen(port, '127.0.0.1', () => console.log(`Local Vocal2Midi studio: http://127.0.0.1:${port}`));
