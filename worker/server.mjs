// Tiny authenticated HTTP wrapper around the Granted Playwright automation.
// Run this on a small always-on box (see README Option A). The dashboard broker
// calls it; credentials are passed in the request body (they originate from the
// vault, decrypted server-side by the broker — never from the agent).
//
// Auth: every request must carry `x-worker-token: <WORKER_TOKEN>` matching the
// env var. This is a shared secret between the dashboard and this worker.

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { discover, draft, submit } from './granted.mjs';

const PORT = Number(process.env.PORT || 8790);
const WORKER_TOKEN = process.env.WORKER_TOKEN;
const APPROVAL_TOKEN = process.env.GRANT_APPROVAL_TOKEN || ''; // set to gate submit

if (!WORKER_TOKEN) {
  console.error('WORKER_TOKEN env is required');
  process.exit(1);
}

function safeEq(a, b) {
  const ab = Buffer.from(a || ''), bb = Buffer.from(b || '');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 5_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const ROUTES = {
  '/discover': (b) => discover(b),
  '/draft': (b) => draft(b),
  '/submit': (b) => submit({ ...b, expectedApprovalToken: APPROVAL_TOKEN })
};

const server = createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  try {
    if (req.method !== 'POST' || !ROUTES[req.url]) return send(404, { error: 'not found' });
    if (!safeEq(req.headers['x-worker-token'], WORKER_TOKEN)) return send(401, { error: 'bad worker token' });
    const body = await readBody(req);
    const result = await ROUTES[req.url](body);
    // Scrub anything credential-shaped before returning (defense in depth).
    const scrubbed = JSON.parse(JSON.stringify(result).replace(/"password"\s*:\s*"[^"]*"/g, '"password":"[REDACTED]"'));
    send(200, scrubbed);
  } catch (e) {
    send(502, { ok: false, error: e?.message || 'worker error' });
  }
});

server.listen(PORT, () => console.log(`granted worker listening on :${PORT}`));
