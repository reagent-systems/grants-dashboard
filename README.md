# ML Research Agent — Control Portal

A SvelteKit + Vercel dashboard that acts as the **credential firewall** and
**control plane** between you (the operator) and an autonomous ML research
agent. The agent runs on a third-party LLM provider; this dashboard ensures
that provider **never sees your real credentials** — only toggles, intents,
and scrubbed status.

## The security model (read this first)

```
  ┌────────────┐   intent (secret-free)   ┌──────────────┐   real API call   ┌─────────┐
  │   AGENT    │ ───────────────────────► │  DASHBOARD   │ ────────────────► │ GCP/HF/ │
  │ (LLM, 3P   │ ◄─────────────────────── │  broker +    │ ◄──────────────── │ Google/ │
  │  provider) │   scrubbed status only   │  vault + UI  │   response        │ Granted │
  └────────────┘                          └──────────────┘                   └─────────┘
        │                                         ▲
        │ holds ONLY a scoped, revocable          │ you: password-gated
        │ AGENT_TOKEN (no cred access)            │ vault writes + approvals
        └─────────────────────────────────────────┘
```

**Three planes, strictly separated:**

| Plane | Holder | Can do | Cannot do |
|-------|--------|--------|-----------|
| Decision | Agent | submit intents, read scrubbed status | read vault, flip toggles, approve Tier-2 |
| Execution | Broker (serverless) | decrypt 1 secret in-function, call API, scrub result | persist/return plaintext |
| Vault/Control | Operator (you) | write creds, flip toggles, approve/reject | — |

### Invariants that make this safe
1. **No read path for secrets.** `vault.ts` exports `encrypt()` and an
   internal `decryptForBroker()` — there is **no** `getSecret()` a route
   could call to return plaintext. Decryption happens only inside broker
   functions, at call time, and the plaintext is GC'd immediately.
2. **The agent holds one revocable capability token.** Worst case if the
   LLM provider leaks the agent's entire context: an attacker can queue
   Tier-1 actions (bounded by the per-job budget cap) until you rotate
   `AGENT_TOKEN`. Your GCP/Google/HF/Granted credentials are untouched.
3. **Two-tier actions.** Tier 1 (cheap, reversible) auto-runs when its
   toggle is ON and under `MAX_JOB_USD`. Tier 2 (spendy/irreversible —
   full fine-tunes, grant submission) only ever *proposes*; you approve in
   the UI. This is the async human gate.
4. **Defense in depth:** `redact()` strips secret-shaped strings from
   anything heading back toward the agent; the audit log records every
   credential *use* (by id, never value) so you can prove the agent never
   saw one.

## Setup

```bash
pnpm install
cp .env.example .env            # fill in the values below
node scripts/hash-password.mjs 'your-operator-password'   # -> OPERATOR_PASSWORD_HASH
openssl rand -base64 32         # -> VAULT_MASTER_KEY
openssl rand -hex 32            # -> AGENT_TOKEN
pnpm db:push                    # create tables (Neon/Vercel Postgres)
pnpm dlx tsx scripts/seed.ts    # seed capability toggles (all OFF)
pnpm dev
```

Deploy: push to a Git repo, import into Vercel, add a Postgres store
(Neon), set the env vars in the Vercel dashboard, deploy. All capabilities
ship **OFF** — you turn them on one at a time as you gain trust.

## How the agent uses it
- `POST /api/agent/intent`  — submit a structured intent (Bearer AGENT_TOKEN)
- `GET  /api/agent/status`  — read toggles + scrubbed action history

## How you use it
- `/`                          — the control portal (password-gated UI)
- vault panel                  — paste a credential; encrypted on submit
- toggles                      — enable/disable each capability
- approvals                    — approve/reject Tier-2 proposals with feedback

## Status
Scaffold complete with live broker handlers for Hugging Face (dataset/model
search, whoami), Google Sheets (append/read for the DoE tracker), and GCP
Vertex (QLoRA + full fine-tune job submission). Not yet `pnpm install`ed or
build-tested (per request). Remaining handlers: `hf.write`, `grant.*`.

## Information-acquisition surface
The `settings` table holds non-secret task config the agent READS via
`GET /api/agent/status` — GCP region/machine/image, HF workspace, DoE
spreadsheet id, budget hints, model range. The operator edits these in the
"Task settings" panel. The agent never hardcodes params; it pulls them. Secrets
never go here — those live only in the encrypted `credentials` vault.
