const $ = id => document.getElementById(id);
const isActive = job => ['queued', 'running'].includes(job.status);
const projectLink = job => '/arrange?song=' + encodeURIComponent(job.projectId);
const statusLabels = { queued: '排队中', running: '处理中', completed: '已完成', failed: '失败' };
const timestamp = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const rows = new Map();
let submitting = false, activeJob = null, submittedId = null, timer, refreshVersion = 0;
const deleteDialog = $('delete-project-dialog');
let deleteTarget = null, deleting = false;

async function request(path, options) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(data?.error || '本地请求失败（HTTP ' + response.status + '）');
  return data;
}

function progress(message) {
  if ($('upload-status').textContent !== message) $('upload-status').textContent = message;
}

function errorMessage(message = '') {
  $('upload-error').textContent = message;
  $('upload-error').hidden = !message;
}

function showDeleteError(message = '') {
  const error = $('delete-project-error');
  error.textContent = message;
  error.hidden = !message;
}

function confirmDeletion(job) {
  deleteTarget = job.projectId;
  $('delete-project-name').textContent = job.title;
  const time = $('delete-project-time');
  const date = new Date(job.createdAt);
  time.dateTime = job.createdAt || '';
  time.textContent = Number.isNaN(date.getTime()) ? '' : timestamp.format(date);
  $('history-notice').textContent = '';
  showDeleteError();
  deleteDialog.showModal();
}

function renderHistory(jobs) {
  const list = $('project-task-list');
  const ids = new Set(jobs.map(job => job.id));
  for (const [id, row] of rows) if (!ids.has(id)) { row.remove(); rows.delete(id); }
  let newRows = false;
  jobs.forEach((job, index) => {
    let row = rows.get(job.id);
    if (!row) {
      row = document.createElement('li');
      row.innerHTML = '<div class="project-task-heading"><strong></strong><span></span></div>' +
        '<p class="project-task-detail"></p><div class="project-task-links"><time></time><a class="project-log" target="_blank" rel="noopener">任务日志</a><a class="project-open" hidden>打开编排</a>' +
        '<button type="button" class="icon subtle project-delete" aria-label="删除工程" title="删除工程" hidden><i data-lucide="trash-2"></i></button></div>';
      row.querySelector('strong').textContent = job.title;
      row.querySelector('.project-log').href = '/task-log?id=' + encodeURIComponent(job.id);
      const date = new Date(job.createdAt);
      if (!Number.isNaN(date.getTime())) {
        const time = row.querySelector('time');
        time.dateTime = job.createdAt;
        time.textContent = timestamp.format(date);
      }
      row.querySelector('.project-delete').addEventListener('click', () => confirmDeletion(job));
      rows.set(job.id, row);
      newRows = true;
    }
    row.dataset.status = job.status;
    row.querySelector('.project-task-heading span').textContent = statusLabels[job.status] || job.status;
    row.querySelector('.project-task-detail').textContent = job.error || (isActive(job) ? job.message : '') || '';
    const open = row.querySelector('.project-open');
    const canDelete = job.status === 'completed' && Boolean(job.projectId);
    if (canDelete) {
      open.href = projectLink(job);
    }
    open.hidden = !canDelete;
    const deleteButton = row.querySelector('.project-delete');
    deleteButton.hidden = !canDelete;
    deleteButton.disabled = Boolean(activeJob || submitting);
    if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
  });
  if (newRows) window.lucide?.createIcons();
}

async function refreshHistory() {
  clearTimeout(timer);
  const version = ++refreshVersion;
  try {
    const { jobs } = await request('/api/project-jobs');
    if (version !== refreshVersion) return;
    activeJob = jobs.find(isActive) || null;
    renderHistory(jobs);
    $('history-status').textContent = jobs.length ? '' : '暂无生成记录';
    const submitted = jobs.find(job => job.id === submittedId);
    if (submitted?.status === 'completed') {
      submittedId = null;
      progress('工程已生成，正在打开编排…');
      location.assign(projectLink(submitted));
      return;
    }
    if (submitted?.status === 'failed') {
      submittedId = null;
      errorMessage(submitted.error || '歌曲工程生成失败');
    }
    if (submittedId && !submitted) {
      submittedId = null;
      errorMessage('工程已删除或任务记录已不可用');
    }
    if (!submitting) progress(activeJob ? activeJob.message || statusLabels[activeJob.status] : '');
  } catch (error) {
    if (version !== refreshVersion) return;
    $('history-status').textContent = '读取生成记录失败：' + error.message;
  }
  $('import-fields').disabled = submitting || Boolean(activeJob || submittedId);
  if (activeJob || submittedId) timer = setTimeout(refreshHistory, 1500);
}

$('project-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (submitting || activeJob || submittedId) return;
  const form = new FormData(event.currentTarget);
  if (!form.get('lyrics')?.name) form.delete('lyrics');
  form.set('onlineLyrics', String($('upload-online-lyrics').checked));
  submitting = true;
  $('import-fields').disabled = true;
  errorMessage();
  progress('正在导入歌曲…');
  try {
    const job = await request('/api/projects', { method: 'POST', body: form });
    submittedId = job.id;
  } catch (error) {
    progress('');
    errorMessage(error.message);
  } finally {
    submitting = false;
    await refreshHistory();
  }
});

$('delete-project-cancel').addEventListener('click', () => deleteDialog.close());
deleteDialog.addEventListener('cancel', event => { if (deleting) event.preventDefault(); });
$('delete-project-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!deleteTarget || deleting) return;
  deleting = true;
  $('delete-project-cancel').disabled = true;
  $('delete-project-confirm').disabled = true;
  showDeleteError();
  try {
    await request('/api/projects/' + encodeURIComponent(deleteTarget), { method: 'DELETE' });
    deleteTarget = null;
    deleteDialog.close();
    await refreshHistory();
    $('project-history-title').focus();
    $('history-notice').textContent = '工程已删除';
  } catch (error) {
    showDeleteError(error.message);
  } finally {
    deleting = false;
    $('delete-project-cancel').disabled = false;
    $('delete-project-confirm').disabled = false;
  }
});

window.lucide?.createIcons();
window.addEventListener('pageshow', event => { if (event.persisted) refreshHistory(); });
refreshHistory();
