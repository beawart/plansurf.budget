const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3001);
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_OWNER = process.env.GITHUB_OWNER || '';
const GITHUB_REPO = process.env.GITHUB_REPO || '';
const GITHUB_PATH = process.env.GITHUB_PATH || 'plansurf.budget-data.json';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 10;
const loginAttempts = new Map();
const revokedSessions = new Map();

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': CORS_ORIGIN,
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  Vary: 'Origin'
};

function respond(res, statusCode, payload) {
  res.writeHead(statusCode, jsonHeaders);
  res.end(JSON.stringify(payload));
}

function ensureReady() {
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO || !APP_PASSWORD || !SESSION_SECRET) {
    return {
      ok: false,
      error: 'The API is missing required server environment variables.'
    };
  }
  return { ok: true };
}

function allowedOrigin(req) {
  return !req.headers.origin || req.headers.origin === CORS_ORIGIN;
}

function secureEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function loginRateLimitKey(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

function isLoginRateLimited(req) {
  const key = loginRateLimitKey(req);
  const now = Date.now();
  const attempts = (loginAttempts.get(key) || []).filter((timestamp) => now - timestamp < LOGIN_WINDOW_MS);
  loginAttempts.set(key, attempts);
  return attempts.length >= MAX_LOGIN_ATTEMPTS;
}

function recordLoginAttempt(req) {
  const key = loginRateLimitKey(req);
  loginAttempts.get(key).push(Date.now());
}

function createSessionToken() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function getSessionToken(req) {
  const authorization = req.headers.authorization || '';
  const match = authorization.match(/^Bearer ([A-Za-z0-9_.-]+)$/);
  return match ? match[1] : '';
}

function validSession(req) {
  const token = getSessionToken(req);
  if (!token || revokedSessions.has(token)) return false;

  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return false;

  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (!secureEqual(signature, expected)) return false;

  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).exp > Date.now();
  } catch {
    return false;
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let oversized = Number(req.headers['content-length'] || 0) > MAX_BODY_BYTES;

    if (oversized) {
      req.resume();
      reject(Object.assign(new Error('Request body is too large.'), { statusCode: 413 }));
      return;
    }

    req.on('data', (chunk) => {
      if (oversized) return;
      raw += chunk;
      if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
        oversized = true;
        raw = '';
        reject(Object.assign(new Error('Request body is too large.'), { statusCode: 413 }));
      }
    });
    req.on('end', () => {
      if (oversized) return;
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function validBudgetData(data) {
  return Boolean(
    data &&
    data.app === 'plansurf-budget' &&
    Array.isArray(data.transactions) &&
    Array.isArray(data.goals)
  );
}

function recordLogout(token) {
  const expiry = Date.now() + SESSION_TTL_MS;
  revokedSessions.set(token, expiry);
  for (const [revokedToken, revokedExpiry] of revokedSessions) {
    if (revokedExpiry <= Date.now()) revokedSessions.delete(revokedToken);
  }
}

function encodeGitHubPath(pathValue) {
  return pathValue.split('/').filter(Boolean).map((segment) => encodeURIComponent(segment)).join('/');
}

async function fetchGitHubFile() {
  const config = ensureReady();
  if (!config.ok) {
    throw new Error(config.error);
  }

  const url = `https://api.github.com/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}/contents/${encodeGitHubPath(GITHUB_PATH)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });

  if (response.status === 404) {
    return { exists: false, data: null, sha: null };
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub fetch failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  if (!data.content) {
    return { exists: false, data: null };
  }

  const buffer = Buffer.from(data.content, 'base64');
  const rawText = buffer.toString('utf8');
  return {
    exists: true,
    sha: data.sha,
    data: rawText ? JSON.parse(rawText) : null
  };
}

async function writeGitHubFile(data) {
  const config = ensureReady();
  if (!config.ok) {
    throw new Error(config.error);
  }

  const url = `https://api.github.com/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}/contents/${encodeGitHubPath(GITHUB_PATH)}`;
  const content = JSON.stringify(data, null, 2);

  const existing = await fetchGitHubFile();

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: `Update budget data for ${GITHUB_PATH}`,
      content: Buffer.from(content, 'utf8').toString('base64'),
      sha: existing.exists ? existing.sha : undefined,
      branch: GITHUB_BRANCH
    })
  });

  const payload = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub write failed (${response.status}): ${payload}`);
  }

  return { ok: true, data: JSON.parse(payload) };
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    respond(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && requestUrl.pathname === '/health') {
    respond(res, 200, { ok: true, service: 'plansurf-api' });
    return;
  }

  if (requestUrl.pathname.startsWith('/api/') && !allowedOrigin(req)) {
    respond(res, 403, { error: 'This origin is not allowed.' });
    return;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/login') {
    const config = ensureReady();
    if (!config.ok) {
      respond(res, 503, { error: config.error });
      return;
    }
    if (isLoginRateLimited(req)) {
      respond(res, 429, { error: 'Too many login attempts. Try again in 15 minutes.' });
      return;
    }

    try {
      const body = await readJsonBody(req);
      recordLoginAttempt(req);
      if (typeof body.password !== 'string' || !secureEqual(body.password, APP_PASSWORD)) {
        respond(res, 401, { error: 'Incorrect password.' });
        return;
      }

      respond(res, 200, { token: createSessionToken(), expiresIn: SESSION_TTL_MS });
    } catch (error) {
      respond(res, error.statusCode || 400, { error: error.message || 'Invalid request.' });
    }
    return;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/logout') {
    const token = getSessionToken(req);
    if (validSession(req)) recordLogout(token);
    respond(res, 200, { ok: true });
    return;
  }

  if (requestUrl.pathname.startsWith('/api/') && !validSession(req)) {
    respond(res, 401, { error: 'Please log in to use budget sync.' });
    return;
  }

  if (req.method === 'GET' && requestUrl.pathname === '/api/budget') {
    try {
      const result = await fetchGitHubFile();
      if (!result.exists || !result.data) {
        respond(res, 200, { transactions: [], goals: [] });
        return;
      }
      respond(res, 200, result.data);
    } catch (error) {
      respond(res, 500, { error: error.message || 'Unable to read budget file.' });
    }
    return;
  }

  if (req.method === 'PUT' && requestUrl.pathname === '/api/budget') {
    try {
      const body = await readJsonBody(req);
      if (!validBudgetData(body)) {
        respond(res, 400, { error: 'Budget data must include the PlanSurf app marker, transactions, and goals.' });
        return;
      }

      await writeGitHubFile(body);
      respond(res, 200, { ok: true, message: 'Budget data saved.' });
    } catch (error) {
      const statusCode = error.statusCode || (error.message.includes('GitHub write failed (409)') ? 409 : 500);
      respond(res, statusCode, { error: error.message || 'Unable to save budget file.' });
    }
    return;
  }

  respond(res, 404, { error: 'Not found.' });
});

server.listen(PORT, () => {
  console.log(`Plansurf API listening on port ${PORT}`);
});
