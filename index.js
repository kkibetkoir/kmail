const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors({ origin: '*' })); // tighten to your app origin in prod
app.use(express.json());

const UPSTREAM = 'https://kmail.pw';
const PORT = process.env.PORT || 3000;
const TIMEOUT_MS = 15000;

// ---------- session store (in-memory) ----------
// Maps our client token -> { cookie, email }
// A real deployment should use Redis / DB, but for a dev proxy this is fine.
const sessions = new Map();

function newSessionToken() {
  return crypto.randomBytes(24).toString('hex');
}

// Base headers matching what kmail.pw expects (mirrors your Swift headers).
const baseHeaders = {
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  Host: 'kmail.pw',
  Connection: 'keep-alive',
  'Accept-Encoding': 'gzip, deflate, br',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
};

// ---------- upstream fetch helper ----------
async function upstream(path, { cookie, method = 'GET' } = {}) {
  const url = `${UPSTREAM}${path}`;
  const headers = { ...baseHeaders };
  if (cookie) headers['Cookie'] = cookie;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method,
      headers,
      redirect: 'manual',
      signal: controller.signal,
    });
    const text = await res.text();

    // Harvest Set-Cookie (kmail sends one; Node's fetch exposes it via getSetCookie on Node 20+).
    let setCookie = null;
    if (typeof res.headers.getSetCookie === 'function') {
      const list = res.headers.getSetCookie();
      if (list.length) setCookie = list.map((c) => c.split(';')[0]).join('; ');
    } else {
      const raw = res.headers.get('set-cookie');
      if (raw) setCookie = raw.split(',')[0].split(';')[0];
    }

    return {
      status: res.status,
      text,
      setCookie,
      contentType: res.headers.get('content-type'),
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------- kmail serialized format decoder ----------
// The `.data` endpoint returns a flat array like:
//   [2,"routes/mail.$id","data",6,"email",8,"id","abc", ...]
// where integer `_N` tokens are placeholders whose value is at index N.
// Some entries are ["D", <int>] special markers.
function decodeKmailPayload(arr) {
  if (!Array.isArray(arr)) return arr;

  // Build lookup: token -> value (token is int at even index, value at odd index)
  const refs = new Map();
  for (let i = 0; i < arr.length; i += 2) {
    const token = arr[i];
    const value = arr[i + 1];
    if (typeof token === 'number') {
      refs.set(token, value);
    }
  }

  // Resolve a value: if it's a number token, look it up recursively.
  // Arrays of the form ["D", <int>] are special (Date); convert to something sane.
  const seen = new Set();
  function resolve(v, depth = 0) {
    if (depth > 50) return v;
    if (typeof v === 'number') {
      if (seen.has(v)) return v; // cycle guard
      if (!refs.has(v)) return v;
      seen.add(v);
      const resolved = resolve(refs.get(v), depth + 1);
      seen.delete(v);
      return resolved;
    }
    if (Array.isArray(v)) {
      // Special marker arrays like ["D", 1793109068000]
      if (
        v.length === 2 &&
        typeof v[0] === 'string' &&
        typeof v[1] === 'number' &&
        v[0].length === 1
      ) {
        if (v[0] === 'D') return new Date(v[1]).toISOString();
        return v[1];
      }
      return v.map((item) => resolve(item, depth + 1));
    }
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v))
        out[k] = resolve(val, depth + 1);
      return out;
    }
    return v;
  }

  // The top-level array is a pair list [keyToken, valueToken, keyToken, valueToken, ...]
  // Reconstruct into an object.
  const result = {};
  for (let i = 0; i < arr.length; i += 2) {
    const key = resolve(arr[i]);
    if (typeof key !== 'string') continue;
    result[key] = resolve(arr[i + 1]);
  }
  return result;
}

// ---------- routes ----------

app.get('/health', (_req, res) => res.json({ ok: true }));

// Ask kmail for a fresh address. Returns { token, email, mails, stats }
// `token` is what the client should send back on subsequent calls.
app.post('/api/refresh', async (_req, res) => {
  try {
    const { status, text, setCookie } = await upstream('/api/refresh');

    if (status < 200 || status >= 300) {
      return res
        .status(status)
        .json({ error: `Upstream ${status}`, body: text.slice(0, 300) });
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res
        .status(502)
        .json({ error: 'Upstream sent non-JSON', body: text.slice(0, 300) });
    }

    if (!setCookie) {
      return res
        .status(502)
        .json({ error: 'Upstream did not set a session cookie' });
    }

    const token = newSessionToken();
    sessions.set(token, {
      cookie: setCookie,
      email: data.email,
      createdAt: Date.now(),
    });

    return res.json({ token, ...data });
  } catch (err) {
    if (err.name === 'AbortError')
      return res.status(504).json({ error: 'Upstream timed out' });
    console.error('refresh error', err);
    return res.status(502).json({ error: 'Failed to reach kmail.pw' });
  }
});

// Poll inbox: same endpoint, but with stored cookie so we don't rotate the mailbox.
app.get('/api/messages', async (req, res) => {
  const token = req.query.token || req.header('x-kmail-token');
  const session = token && sessions.get(token);
  if (!session) {
    return res
      .status(401)
      .json({ error: 'Unknown token. Call POST /api/refresh first.' });
  }

  try {
    const { status, text, setCookie } = await upstream('/api/refresh', {
      cookie: session.cookie,
    });

    // Refresh the cookie if upstream rotated it.
    if (setCookie) session.cookie = setCookie;

    if (status < 200 || status >= 300) {
      return res
        .status(status)
        .json({ error: `Upstream ${status}`, body: text.slice(0, 300) });
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res
        .status(502)
        .json({ error: 'Upstream sent non-JSON', body: text.slice(0, 300) });
    }

    return res.json({ token, ...data });
  } catch (err) {
    if (err.name === 'AbortError')
      return res.status(504).json({ error: 'Upstream timed out' });
    console.error('messages error', err);
    return res.status(502).json({ error: 'Failed to reach kmail.pw' });
  }
});

// Fetch a single message, decoded into normal JSON.
app.get('/api/mail/:id', async (req, res) => {
  const token = req.query.token || req.header('x-kmail-token');
  const session = token && sessions.get(token);
  if (!session) {
    return res
      .status(401)
      .json({ error: 'Unknown token. Call POST /api/refresh first.' });
  }

  const messageId = req.params.id;
  // kmail message ids are URL-safe base64-ish; be strict to avoid SSRF.
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(messageId)) {
    return res.status(400).json({ error: 'Invalid message id' });
  }

  try {
    const { status, text, setCookie } = await upstream(
      `/mail/${messageId}.data`,
      {
        cookie: session.cookie,
      }
    );
    if (setCookie) session.cookie = setCookie;

    if (status < 200 || status >= 300) {
      return res
        .status(status)
        .json({ error: `Upstream ${status}`, body: text.slice(0, 300) });
    }

    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      return res
        .status(502)
        .json({ error: 'Upstream sent non-JSON', body: text.slice(0, 300) });
    }

    const decoded = decodeKmailPayload(raw);
    return res.json(decoded);
  } catch (err) {
    if (err.name === 'AbortError')
      return res.status(504).json({ error: 'Upstream timed out' });
    console.error('mail error', err);
    return res.status(502).json({ error: 'Failed to reach kmail.pw' });
  }
});

// Housekeeping: drop sessions older than 24h so the map doesn't grow forever.
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [k, v] of sessions) if (v.createdAt < cutoff) sessions.delete(k);
}, 60 * 60 * 1000).unref();

app.listen(PORT, () => console.log(`kmail proxy on http://localhost:${PORT}`));
