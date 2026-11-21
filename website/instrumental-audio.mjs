import { appendFile, readFile, stat } from 'node:fs/promises';
import { delimiter, resolve } from 'node:path';
import { runProcess } from './local-process.mjs';

export async function nativeInstrumentalRunner({ root, logPath, onMessage }) {
  const interpreter = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python';
  const python = resolve(root, process.env.HACHIMI_MUSCRIPTOR_PYTHON || `backend/runtime/demucs/venv/${interpreter}`);
  const info = await stat(python).catch(error => {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
  });
  if (!info?.isFile()) {
    const error = '找不到 MuScriptor 的本机 Python。请先运行 setup_demucs.bat，再运行 setup_muscriptor.bat。';
    await appendFile(logPath, error + '\n', 'utf8');
    throw new Error(error);
  }

  const dependencies = resolve(root, 'backend/runtime/muscriptor-windows/deps');
  const options = { env: {
    PYTHONPATH: [dependencies, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
    PYTHONDONTWRITEBYTECODE: '1',
    HF_HUB_OFFLINE: '1',
  } };
  return (script, ...args) => runProcess(python, ['-X', 'utf8', resolve(root, 'backend/pipeline', script), ...args],
    root, logPath, onMessage, options);
}

export async function transcribeInstrumental({ root, input, outputDir, logPath, onMessage, keepOriginal = false }) {
  const run = await nativeInstrumentalRunner({ root, logPath, onMessage });
  await run('transcribe_instrumental.py', input, outputDir, ...(keepOriginal ? ['--keep-decoded-audio'] : []));
  onMessage('正在准备各音轨的试听和 MIDI…');
  const trackDir = resolve(outputDir, 'tracks');
  await run('instrumental_tracks.py', resolve(outputDir, 'multitrack.mid'), trackDir,
    ...(keepOriginal ? ['--original-audio', resolve(outputDir, 'original.wav')] : []));
  return JSON.parse(await readFile(resolve(trackDir, 'tracks.json'), 'utf8'));
}
