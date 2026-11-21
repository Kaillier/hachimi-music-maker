export const AUDIO_EXTENSIONS = new Set(['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.wav', '.wma']);

export function safeFileName(value, fallback) {
  const name = String(value || fallback).replace(/[\\/]/g, '_')
    .replace(/[<>:"|?*\x00-\x1f]/g, '_').trim().replace(/[. ]+$/, '').slice(0, 180);
  return name || fallback;
}

export async function readMultipart(req, limit = 512 * 1024 * 1024) {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data;')) throw new Error('请选择文件后提交');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('上传文件总大小不能超过 512 MB');
    chunks.push(chunk);
  }
  let data;
  try {
    data = await new Response(Buffer.concat(chunks), { headers: { 'content-type': contentType } }).formData();
  } catch { throw new Error('无法读取上传文件，请重新选择文件后重试'); }
  const parts = new Map();
  for (const [name, value] of data) {
    if (parts.has(name)) throw new Error('上传字段重复：' + name);
    parts.set(name, typeof value === 'string'
      ? { filename: '', data: Buffer.from(value) }
      : { filename: value.name, data: Buffer.from(await value.arrayBuffer()), contentType: value.type });
  }
  return parts;
}
