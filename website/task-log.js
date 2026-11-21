const id = new URLSearchParams(location.search).get('id') || '';
const title = document.getElementById('log-title');
const status = document.getElementById('log-status');
const output = document.getElementById('log-output');
const download = document.getElementById('log-download');
const labels = { queued: '排队中', running: '运行中，自动更新', completed: '已完成', failed: '失败', deleted: '工程已删除' };
let offset = 0;
let decoder = new TextDecoder();
let hasOutput = false;

function showStatus(text, state) {
  if (status.textContent !== text) status.textContent = text;
  status.dataset.state = state;
}

async function refresh() {
  try {
    const response = await fetch(`/api/project-jobs/${id}/log?offset=${offset}`);
    if (response.status === 404) {
      showStatus('任务不存在。', 'failed');
      if (!hasOutput) output.textContent = '暂无日志。';
      return;
    }
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const { job, chunk, nextOffset, hasMore, reset } = await response.json();
    const running = job.status === 'queued' || job.status === 'running';
    const detail = job.error || (running ? job.message : '');
    showStatus(labels[job.status] + (detail ? ' · ' + detail : ''), job.status);
    if (job.title && !title.dataset.loaded) {
      title.textContent = job.title + ' · 任务日志';
      document.title = title.textContent + ' | Hachimi';
      title.dataset.loaded = 'true';
    }

    const follow = output.scrollHeight - output.scrollTop - output.clientHeight <= 16;
    if (reset) {
      decoder = new TextDecoder();
      output.textContent = '';
      hasOutput = false;
    }
    const bytes = Uint8Array.from(atob(chunk), character => character.charCodeAt(0));
    const text = decoder.decode(bytes, { stream: running || hasMore });
    if (text) {
      if (!hasOutput) output.textContent = '';
      output.append(text);
      hasOutput = true;
      if (follow || reset) output.scrollTop = output.scrollHeight;
    } else if (!hasOutput) {
      output.textContent = running ? '等待任务输出…' : '此任务暂无日志。';
    }
    offset = nextOffset;
    download.hidden = offset === 0;
    if (hasMore || running) setTimeout(refresh, hasMore ? 0 : 1000);
  } catch {
    showStatus('暂时无法读取日志，正在重试…', 'failed');
    setTimeout(refresh, 1500);
  }
}

window.lucide?.createIcons();
if (/^[a-f0-9-]+$/.test(id)) {
  download.href = `/api/project-jobs/${id}/files/log?download`;
  refresh();
} else {
  showStatus('任务编号无效。', 'failed');
  output.textContent = '暂无日志。';
}
