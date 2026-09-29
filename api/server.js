const http = require('http');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3001);
const API_KEY = process.env.API_KEY || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_OWNER = process.env.GITHUB_OWNER || '';
const GITHUB_REPO = process.env.GITHUB_REPO || '';
const GITHUB_PATH = process.env.GITHUB_PATH || 'plansurf.budget-data.json';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': CORS_ORIGIN,
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS'
};

function respond(res, statusCode, payload) {
  res.writeHead(statusCode, jsonHeaders);
  res.end(JSON.stringify(payload));
}

function ensureReady() {
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    return {
      ok: false,
      error: 'Missing required GitHub env vars. Set GITHUB_TOKEN, GITHUB_OWNER, and GITHUB_REPO.'
    };
  }
  return { ok: true };
}

function validateApiKey(req) {
  if (!API_KEY) {
    return false;
  }
  const provided = req.headers['x-api-key'];
  return provided === API_KEY;
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

  const existing = await fetchGitHubFile().catch(() => ({ exists: false, sha: null }));

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

  if (!validateApiKey(req)) {
    respond(res, 401, { error: 'Unauthorized. Missing or invalid x-api-key header.' });
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
      const body = await new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', (chunk) => {
          raw += chunk;
        });
        req.on('end', () => {
          if (!raw) {
            resolve({});
            return;
          }

          try {
            resolve(JSON.parse(raw));
          } catch (error) {
            reject(error);
          }
        });
        req.on('error', reject);
      });

      await writeGitHubFile(body);
      respond(res, 200, { ok: true, message: 'Budget data saved.' });
    } catch (error) {
      respond(res, 500, { error: error.message || 'Unable to save budget file.' });
    }
    return;
  }

  respond(res, 404, { error: 'Not found.' });
});

server.listen(PORT, () => {
  console.log(`Plansurf API listening on port ${PORT}`);
});
