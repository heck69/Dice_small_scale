const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DASHBOARD_TIMEZONES = {
  browser: null,
  UTC: 'UTC',
  Pacific: 'America/Los_Angeles',
  Mountain: 'America/Denver',
  Central: 'America/Chicago',
  Eastern: 'America/New_York',
};
const SESSION_DAYS = 7;
const dashboardRoot = path.join(__dirname, '..', 'public');

function createDashboardServer({ db }) {
  return http.createServer(async (request, response) => {
    try {
      await routeRequest(request, response, db);
    } catch (error) {
      console.error('[dashboard] request failed:', error.message);
      sendJson(response, 500, { error: 'Dashboard request failed.' });
    }
  });
}

async function routeRequest(request, response, db) {
  const requestUrl = new URL(request.url, 'http://localhost');
  const pathname = requestUrl.pathname;

  if (request.method === 'GET' && pathname === '/dashboard') {
    return sendFile(response, 'dashboard.html', 'text/html; charset=utf-8');
  }
  if (request.method === 'GET' && pathname === '/dashboard.js') {
    return sendFile(response, 'dashboard.js', 'application/javascript; charset=utf-8');
  }
  if (request.method === 'GET' && pathname === '/dashboard.css') {
    return sendFile(response, 'dashboard.css', 'text/css; charset=utf-8');
  }
  if (request.method === 'POST' && pathname === '/api/auth/login') {
    return login(request, response, db);
  }
  if (request.method === 'POST' && pathname === '/api/auth/logout') {
    return logout(request, response, db);
  }
  if (request.method === 'GET' && pathname === '/api/auth/session') {
    return authenticate(request, response, db, () => sendJson(response, 200, { authenticated: true }));
  }
  if (request.method === 'GET' && pathname === '/api/dashboard') {
    return authenticate(request, response, db, () => readDashboard(requestUrl, response, db));
  }

  sendJson(response, 404, { error: 'Not found.' });
}

async function login(request, response, db) {
  const body = await readJson(request);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!email || !password) return sendJson(response, 400, { error: 'Email and password are required.' });

  const result = await db.query(
    `select id, email, password_hash
       from operator_accounts
      where lower(email) = $1 and disabled = false
      limit 1`,
    [email]
  );
  const account = result.rows[0];
  if (!account || !await bcrypt.compare(password, account.password_hash)) {
    return sendJson(response, 401, { error: 'Invalid credentials.' });
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  await db.query(
    `insert into operator_sessions (token_hash, operator_id, expires_at)
     values ($1, $2, now() + ($3 * interval '1 day'))`,
    [tokenHash, account.id, SESSION_DAYS]
  );
  setCookie(response, 'dashboard_session', rawToken, SESSION_DAYS * 24 * 60 * 60);
  sendJson(response, 200, { authenticated: true, email: account.email });
}

async function logout(request, response, db) {
  const token = readCookie(request, 'dashboard_session');
  if (token) {
    await db.query(
      `update operator_sessions set revoked_at = now()
        where token_hash = $1 and revoked_at is null`,
      [hashToken(token)]
    );
  }
  setCookie(response, 'dashboard_session', '', 0);
  sendJson(response, 200, { authenticated: false });
}

async function authenticate(request, response, db, handler) {
  const token = readCookie(request, 'dashboard_session');
  if (!token) return sendJson(response, 401, { error: 'Authentication required.' });
  const result = await db.query(
    `select operator_id
       from operator_sessions
      where token_hash = $1
        and revoked_at is null
        and expires_at > now()
      limit 1`,
    [hashToken(token)]
  );
  if (!result.rows[0]) return sendJson(response, 401, { error: 'Authentication required.' });
  return handler(result.rows[0].operator_id);
}

async function readDashboard(requestUrl, response, db) {
  const date = requestUrl.searchParams.get('date');
  const timezone = requestUrl.searchParams.get('timezone') || 'browser';
  const timezoneName = DASHBOARD_TIMEZONES[timezone];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return sendJson(response, 400, { error: 'date must be YYYY-MM-DD.' });
  if (!(timezone in DASHBOARD_TIMEZONES)) return sendJson(response, 400, { error: 'Unsupported timezone.' });

  const zone = timezoneName || 'UTC';
  const bounds = await db.query(
    `select ($1::date::timestamp at time zone $2) as start_at,
            (($1::date + interval '1 day')::timestamp at time zone $2) as end_at`,
    [date, zone]
  );
  const { start_at: startAt, end_at: endAt } = bounds.rows[0];

  const [users, sessions, audits, prompts, applications, queue] = await Promise.all([
    db.query(`
      select distinct on (ds.telegram_chat_id)
        ds.telegram_chat_id, ds.client_id, c.full_name, c.company_email, c.applywizz_id
      from dice_sessions ds
      left join clients c on c.id = ds.client_id
      order by ds.telegram_chat_id, ds.updated_at desc nulls last`),
    db.query(`
      select telegram_chat_id, session_started_at, session_deadline, next_scan_at,
             last_decision, last_decision_at, current_prompt_url,
             current_prompt_sent_at, current_prompt_expires_at
      from workflow_sessions
      where session_started_at < $2 and coalesce(session_deadline, session_started_at) >= $1`, [startAt, endAt]),
    db.query(`
      select id, telegram_chat_id, event, details, created_at
      from workflow_audit_logs
      where created_at >= $1 and created_at < $2
      order by created_at asc, id asc`, [startAt, endAt]),
    db.query(`
      select id, telegram_chat_id, prompt_token, url, sent_at, expires_at,
             decision, clicked_at
      from workflow_prompt_events
      where sent_at >= $1 and sent_at < $2
      order by sent_at asc, id asc`, [startAt, endAt]),
    db.query(`
      select id, client_id, telegram_chat_id, job_id, url, job_name, status, applied_at
      from applications
      where applied_at >= $1 and applied_at < $2
      order by applied_at asc, id asc`, [startAt, endAt]),
    db.query(`
      select id, client_id, telegram_chat_id, job_id, url, status, available_at,
             created_at, started_at, finished_at, attempts, max_attempts, last_error
      from apply_queue
      where created_at >= $1 and created_at < $2
      order by created_at asc, id asc`, [startAt, endAt]),
  ]);

  const userMap = new Map(users.rows.map((user) => [String(user.telegram_chat_id), {
    ...user,
    has_activity: false,
    session: sessions.rows.find((row) => String(row.telegram_chat_id) === String(user.telegram_chat_id)) || null,
    audit_logs: [],
    prompt_events: [],
    applications: [],
    queue: [],
  }]));
  const ensureUser = (chatId) => {
    const key = String(chatId);
    if (!userMap.has(key)) userMap.set(key, {
      telegram_chat_id: chatId,
      full_name: null,
      company_email: null,
      applywizz_id: null,
      has_activity: false,
      session: null,
      audit_logs: [],
      prompt_events: [],
      applications: [],
      queue: [],
    });
    return userMap.get(key);
  };

  audits.rows.forEach((row) => { const user = ensureUser(row.telegram_chat_id); user.audit_logs.push(row); user.has_activity = true; });
  prompts.rows.forEach((row) => { const user = ensureUser(row.telegram_chat_id); user.prompt_events.push(row); user.has_activity = true; });
  applications.rows.forEach((row) => { const user = ensureUser(row.telegram_chat_id); user.applications.push(row); user.has_activity = true; });
  queue.rows.forEach((row) => { const user = ensureUser(row.telegram_chat_id); user.queue.push(row); user.has_activity = true; });

  sendJson(response, 200, {
    date,
    timezone,
    start_at: startAt,
    end_at: endAt,
    users: [...userMap.values()].sort((left, right) => String(left.full_name || left.company_email || left.telegram_chat_id).localeCompare(String(right.full_name || right.company_email || right.telegram_chat_id))),
  });
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new Error('Request body is too large.'));
    });
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(new Error('Invalid JSON body.')); }
    });
    request.on('error', reject);
  });
}

function sendFile(response, fileName, contentType) {
  const filePath = path.join(dashboardRoot, fileName);
  if (!fs.existsSync(filePath)) return sendJson(response, 404, { error: 'Dashboard asset not found.' });
  response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
  response.end(fs.readFileSync(filePath));
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function readCookie(request, name) {
  const cookies = String(request.headers.cookie || '').split(';');
  const item = cookies.find((cookie) => cookie.trim().startsWith(`${name}=`));
  return item ? decodeURIComponent(item.trim().slice(name.length + 1)) : null;
}

function setCookie(response, name, value, maxAge) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  response.setHeader('set-cookie', `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`);
}

module.exports = {
  createDashboardServer,
  DASHBOARD_TIMEZONES,
};
