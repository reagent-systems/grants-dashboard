# Granted AI automation worker (Playwright)

Granted AI has **no public API** — it's a login-gated web app. This worker
drives it headlessly with Playwright. It is the broker handler for the
`grant.*` capabilities.

## Why a separate worker (not in the Vercel function)
Playwright needs real browser binaries and long-running execution — neither
works in Vercel's serverless runtime. So grant automation runs OUTSIDE the
SvelteKit app:

- **Option A (recommended): run this worker on a small always-on box** (a cheap
  VPS, a Fly.io machine, or the same host as anything else you self-host) and
  expose ONE internal endpoint the dashboard broker calls. Credentials are
  passed from the vault to the worker over an authenticated internal call —
  they still never reach the agent.
- **Option B: run it as a scheduled/triggered job** (e.g. GitHub Actions,
  a cron box) that reads a task queue and writes results back to the dashboard
  DB. Fully decoupled; no inbound endpoint needed.

Either way the security model holds: the agent submits a secret-free intent to
the dashboard; the dashboard hands the task + (server-side) credentials to this
worker; the worker returns scrubbed results. The agent never sees the Granted
login.

## Security
- Granted credentials live in the dashboard vault (service `granted`).
- This worker receives them only at execution time, uses them to log in, and
  never logs or returns them.
- `grant.submit` is Tier-2: this worker will REFUSE to submit unless the task
  carries an operator-approval token issued by the dashboard. Discovery and
  drafting are Tier-1.

## Files
- `granted.mjs` — the Playwright automation (login, discover, draft, submit-gated)
- `server.mjs` — a tiny authenticated HTTP wrapper (Option A)
- `package.json` — deps (`playwright`)

## Setup
```
cd worker
npm install
npx playwright install chromium
# Option A:
WORKER_TOKEN=<shared secret> node server.mjs
```

## Selectors may drift
Granted's DOM can change. Selectors are centralized at the top of `granted.mjs`
(the SELECTORS object). If automation breaks, re-inspect the site and update
that one object. This is the expected maintenance cost of UI automation — there
is no API to fall back on.
