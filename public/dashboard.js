const state = { timer: null, data: null };
const dateInput = document.querySelector('#date');
const timezoneInput = document.querySelector('#timezone');
const statusText = document.querySelector('#status');
const summary = document.querySelector('#summary');
const users = document.querySelector('#users');
const loginPanel = document.querySelector('#login');

const today = new Date();
dateInput.value = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0')].join('-');

dateInput.addEventListener('change', loadDashboard);
timezoneInput.addEventListener('change', loadDashboard);
document.querySelector('#logout').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  showLogin();
});
document.querySelector('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = document.querySelector('#login-error');
  error.textContent = '';
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: document.querySelector('#email').value,
      password: document.querySelector('#password').value,
    }),
  });
  if (!response.ok) {
    error.textContent = (await response.json()).error || 'Sign in failed.';
    return;
  }
  await loadDashboard();
});

async function loadDashboard() {
  const params = new URLSearchParams({ date: dateInput.value, timezone: timezoneInput.value });
  const response = await fetch(`/api/dashboard?${params}`);
  if (response.status === 401) return showLogin();
  if (!response.ok) {
    statusText.textContent = 'Dashboard data could not be loaded.';
    return;
  }
  state.data = await response.json();
  render(state.data);
  startPolling();
}

function render(data) {
  loginPanel.hidden = true;
  users.hidden = false;
  const active = data.users.filter((user) => user.has_activity).length;
  summary.textContent = `${data.users.length} users · ${active} active · refreshed ${new Date().toLocaleTimeString()}`;
  statusText.textContent = `${data.date} · ${data.timezone}`;
  users.innerHTML = data.users.map(renderUser).join('');
  startTimers();
}

function renderUser(user) {
  const label = escapeHtml(user.full_name || user.company_email || `Telegram ${user.telegram_chat_id}`);
  const email = escapeHtml(user.company_email || `Telegram ${user.telegram_chat_id}`);
  const session = user.session;
  const logs = user.audit_logs.map((row) => ({ time: row.created_at, type: row.event, details: row.details }));
  user.prompt_events.forEach((row) => logs.push({ time: row.sent_at, type: `prompt: ${row.decision || 'waiting'}`, details: { url: row.url, expires_at: row.expires_at, clicked_at: row.clicked_at } }));
  user.applications.forEach((row) => logs.push({ time: row.applied_at, type: `application: ${row.status}`, details: { job_name: row.job_name, url: row.url } }));
  user.queue.forEach((row) => logs.push({ time: row.created_at, type: `queue: ${row.status}`, details: { url: row.url, available_at: row.available_at, started_at: row.started_at, finished_at: row.finished_at } }));
  logs.sort((left, right) => new Date(left.time) - new Date(right.time));
  const logHtml = logs.length ? logs.map((log) => `<div class="log"><time>${formatTime(log.time)}</time><div><strong>${escapeHtml(log.type)}</strong><pre>${escapeHtml(JSON.stringify(log.details || {}, null, 2))}</pre></div></div>`).join('') : '<p class="muted">No activity for this date.</p>';
  const timer = session ? `<div class="timer"><div class="metric"><strong>${formatTime(session.session_started_at)}</strong><span>9-hour window start</span></div><div class="metric"><strong>${formatTime(session.session_deadline)}</strong><span>window deadline</span></div><div class="metric"><strong data-countdown="${escapeHtml(session.session_deadline || '')}">${remaining(session.session_deadline)}</strong><span>window remaining</span></div><div class="metric"><strong>${formatTime(session.next_scan_at)}</strong><span>next link</span></div></div>` : '<p class="muted">No workflow session recorded for this date.</p>';
  return `<details class="user"><summary><span class="user-name">${label}</span><span class="user-email">${email}</span><span class="badge ${user.has_activity ? '' : 'idle'}">${user.has_activity ? `${logs.length} events` : 'No activity'}</span></summary><div class="user-body">${timer}<div class="columns"><section class="panel"><h3>Timeline</h3>${logHtml}</section><section class="panel"><h3>Current status</h3>${renderCurrent(user)}</section></div></div></details>`;
}

function renderCurrent(user) {
  const latest = user.applications[user.applications.length - 1];
  if (!latest) return '<p class="muted">No application status recorded.</p>';
  return `<div class="metric"><strong>${escapeHtml(latest.status)}</strong><span>${escapeHtml(latest.job_name || latest.url || 'Current job')}</span></div>`;
}

function showLogin() {
  if (state.timer) clearInterval(state.timer);
  loginPanel.hidden = false;
  users.hidden = true;
  statusText.textContent = 'Sign in to view workflow activity.';
}

function startPolling() {
  if (state.timer) return;
  state.timer = setInterval(loadDashboard, 30 * 60 * 1000);
}

function startTimers() {
  if (state.countdownTimer) clearInterval(state.countdownTimer);
  state.countdownTimer = setInterval(() => {
    document.querySelectorAll('[data-countdown]').forEach((element) => {
      element.textContent = remaining(element.dataset.countdown);
    });
  }, 1000);
}

function remaining(deadline) {
  const seconds = Math.max(0, Math.floor((new Date(deadline).getTime() - Date.now()) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(remainder).padStart(2, '0')}s`;
}

function formatTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

loadDashboard();
