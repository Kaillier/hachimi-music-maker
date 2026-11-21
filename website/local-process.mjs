import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';

export function processErrorMessage(output) {
  const lines = output.trim().split(/\r?\n/);
  const errorLine = lines.findLast(line => /^[\w.]+(?:Error|Exception):/.test(line));
  return errorLine
    ? errorLine.replace(/^[\w.]+(?:Error|Exception):\s*/, '').slice(0, 1800)
    : output.trim().slice(-1800) || '本地处理失败，请检查任务日志';
}

export function runProcess(executable, args, cwd, logPath, onMessage, options = {}) {
  return new Promise((resolveProcess, reject) => {
    const log = createWriteStream(logPath, { flags: 'a' });
    const child = spawn(executable, args, { cwd, windowsHide: true,
      env: { ...process.env, ...options.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' } });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let output = '';
    let pending = '';
    let settled = false;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = child.kill(); }, options.timeoutMs ?? 30 * 60 * 1000);
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      log.end(() => error ? reject(error) : resolveProcess());
    };
    const capture = chunk => {
      log.write(chunk);
      const text = chunk.toString();
      output = (output + text).slice(-4000);
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('HACHIMI_EVENT ')) continue;
        try { onMessage(JSON.parse(line.slice(14)).message); } catch { /* Other process logs are diagnostic text. */ }
      }
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', finish);
    child.on('close', code => {
      finish(timedOut ? new Error('本地处理超时') : code === 0 ? null : new Error(processErrorMessage(output)));
    });
  });
}
