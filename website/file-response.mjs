import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';

export async function sendFile(req, res, path, downloadName) {
  const info = await stat(path);
  const type = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.mid': 'audio/midi', '.ustx': 'text/yaml; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.log': 'text/plain; charset=utf-8' }[extname(path)] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (new URL(req.url, 'http://localhost').searchParams.has('download') && downloadName)
    headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
  let start = 0;
  let end = info.size - 1;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (match && (match[1] || match[2])) {
      if (match[1]) { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), end) : end; }
      else start = Math.max(0, info.size - Number(match[2]));
    } else start = info.size;
    if (start > end || start >= info.size) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end(); return; }
    headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(req.headers.range ? 206 : 200, headers);
  if (req.method === 'HEAD' || info.size === 0) res.end();
  else createReadStream(path, { start, end }).on('error', () => res.destroy()).pipe(res);
}
