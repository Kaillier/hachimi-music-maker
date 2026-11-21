import { appendFile, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runProcess } from './local-process.mjs';

export async function separateAudio({ root, input, projectDir, resultPath, logPath, onMessage }) {
  const interpreter = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python';
  const python = resolve(root, process.env.HACHIMI_DEMUCS_PYTHON || `backend/runtime/demucs/venv/${interpreter}`);
  let executable;
  try { executable = await stat(python); }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
  }
  if (!executable?.isFile()) {
    const message = `找不到 Demucs 的本机 Python（${python}）。请运行 setup_demucs.ps1，或将 HACHIMI_DEMUCS_PYTHON 设置为已安装 Demucs 的 Python 路径。`;
    await appendFile(logPath, message + '\n', 'utf8');
    throw new Error(message);
  }

  await runProcess(python, ['-X', 'utf8', resolve(root, 'backend/pipeline/separate_audio.py'),
    '--input', input, '--work', projectDir, '--result', resultPath], root, logPath, onMessage);
  return JSON.parse(await readFile(resultPath, 'utf8'));
}
