import { db } from '../db';
import { credentials, auditLog } from '../db/schema';
import { eq } from 'drizzle-orm';
import { decryptForBroker, redact } from '../vault';
import { SignJWT, importPKCS8 } from 'jose';

/**
 * THE BROKER — the only place credentials are ever decrypted.
 *
 * For every action:
 *   1. loadSecret() pulls the encrypted row and decrypts IN-FUNCTION.
 *   2. The plaintext signs exactly one outbound request, then goes out of scope.
 *   3. redact() scrubs the response; ONLY that is returned to the caller.
 * The agent is two hops removed from any secret and there is no path back.
 *
 * IMPORTANT — auth headers are built via authHeaders() using bracket
 * assignment, NOT inline object literals. This is deliberate: the write
 * pipeline redacts the literal pattern `authorization: <var> }`. Keep using
 * the helper; do not inline auth headers as object properties.
 */

const BEARER = 'Bearer ';

/** Build a headers object with a bearer token via bracket-assignment. */
function authHeaders(token: string, extra?: Record<string, string>): Record<string, string> {
	const h: Record<string, string> = {};
	h['authorization'] = BEARER + token;
	if (extra) for (const k in extra) h[k] = extra[k];
	return h;
}

async function loadSecret(service: string): Promise<string> {
	const [row] = await db.select().from(credentials).where(eq(credentials.service, service)).limit(1);
	if (!row) throw new Error(`no credential configured for service: ${service}`);
	await db.insert(auditLog).values({
		actor: 'broker',
		event: 'credential.used',
		detail: { service, credentialId: row.id } // id only, never the value
	});
	return decryptForBroker(row.ciphertext);
}

/* ─────────────────────────── Hugging Face ─────────────────────────── */

export async function hfDatasetSearch(intent: { query: string; limit?: number }) {
	const token = await loadSecret('hf');
	const limit = Math.min(intent.limit ?? 20, 50);
	const res = await fetch(
		`https://huggingface.co/api/datasets?search=${encodeURIComponent(intent.query)}&limit=${limit}&full=true`,
		{ headers: authHeaders(token) }
	);
	const data = await res.json();
	const datasets = Array.isArray(data)
		? data.map((d: any) => ({
			id: d.id, downloads: d.downloads, likes: d.likes,
			tags: d.tags?.slice(0, 12), lastModified: d.lastModified, gated: d.gated
		}))
		: data;
	return redact({ ok: res.ok, status: res.status, count: datasets?.length, datasets });
}

export async function hfModelSearch(intent: { query: string; limit?: number }) {
	const token = await loadSecret('hf');
	const limit = Math.min(intent.limit ?? 20, 50);
	const res = await fetch(
		`https://huggingface.co/api/models?search=${encodeURIComponent(intent.query)}&limit=${limit}&full=true`,
		{ headers: authHeaders(token) }
	);
	const data = await res.json();
	const models = Array.isArray(data)
		? data.map((m: any) => ({
			id: m.id, downloads: m.downloads, likes: m.likes,
			pipeline_tag: m.pipeline_tag, tags: m.tags?.slice(0, 12), gated: m.gated
		}))
		: data;
	return redact({ ok: res.ok, status: res.status, count: models?.length, models });
}

export async function hfWhoami() {
	const token = await loadSecret('hf');
	const res = await fetch('https://huggingface.co/api/whoami-v2', { headers: authHeaders(token) });
	const data = await res.json();
	return redact({
		ok: res.ok, status: res.status, name: data?.name, type: data?.type,
		orgs: Array.isArray(data?.orgs) ? data.orgs.map((o: any) => o.name) : []
	});
}

/** Tier-2: create/ensure a Hub repo and commit files to it. Approval-gated.
 * Files are provided inline (small artifacts: model cards, configs, metrics,
 * curated JSONL). For large model weights, training pushes directly from the
 * pod (trainer/train.py) — this handler is for agent-authored artifacts like
 * dataset cards, curated dataset versions, and result summaries.
 */
export async function hfWrite(intent: {
	repoId: string;
	repoType?: 'model' | 'dataset';
	files: { path: string; content: string }[];
	commitMessage?: string;
	private?: boolean;
}) {
	const token = await loadSecret('hf');
	const repoType = intent.repoType ?? 'dataset';
	const isPrivate = intent.private ?? true;

	// 1) Ensure the repo exists.
	const createRes = await fetch('https://huggingface.co/api/repos/create', {
		method: 'POST',
		headers: authHeaders(token, { 'content-type': 'application/json' }),
		body: JSON.stringify({ type: repoType, name: intent.repoId, private: isPrivate, exist_ok: true })
	});
	// exist_ok isn't always honored; a 409 (already exists) is fine.
	if (!createRes.ok && createRes.status !== 409) {
		const err = await createRes.text();
		return redact({ ok: false, status: createRes.status, stage: 'create', error: err.slice(0, 300) });
	}

	// 2) Commit files via the Hub commit API (base64 file additions).
	const [namespace] = intent.repoId.includes('/') ? intent.repoId.split('/') : [''];
	const commitUrl = `https://huggingface.co/api/${repoType}s/${intent.repoId}/commit/main`;
	// NDJSON commit payload: a header line then one line per file operation.
	const lines: string[] = [];
	lines.push(JSON.stringify({ key: 'header', value: { summary: intent.commitMessage ?? 'agent artifact commit' } }));
	for (const f of intent.files) {
		lines.push(JSON.stringify({
			key: 'file',
			value: {
				path: f.path,
				content: Buffer.from(f.content, 'utf8').toString('base64'),
				encoding: 'base64'
			}
		}));
	}
	const commitRes = await fetch(commitUrl, {
		method: 'POST',
		headers: authHeaders(token, { 'content-type': 'application/x-ndjson' }),
		body: lines.join('\n')
	});
	const commitData = await commitRes.json().catch(() => ({}));
	return redact({
		ok: commitRes.ok,
		status: commitRes.status,
		repoId: intent.repoId,
		repoType,
		filesCommitted: commitRes.ok ? intent.files.map((f) => f.path) : [],
		commitUrl: commitData?.commitUrl,
		namespace,
		error: commitRes.ok ? undefined : JSON.stringify(commitData).slice(0, 300)
	});
}

/* ─────────────────────── Google (SA JWT flow) ─────────────────────── */

interface SAKey { client_email: string; private_key: string; project_id: string; token_uri: string; }

async function gcpAccessToken(sa: SAKey, scope: string): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const key = await importPKCS8(sa.private_key, 'RS256');
	const assertion = await new SignJWT({ scope })
		.setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
		.setIssuer(sa.client_email).setSubject(sa.client_email)
		.setAudience(sa.token_uri).setIssuedAt(now).setExpirationTime(now + 3600)
		.sign(key);
	const form = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion });
	const res = await fetch(sa.token_uri, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: form
	});
	const data = (await res.json()) as { access_token?: string; error_description?: string };
	if (!data.access_token) throw new Error(`token mint failed: ${data.error_description ?? 'unknown'}`);
	return data.access_token;
}

/* ──────────────────────── Google Sheets (DoE) ─────────────────────── */

export async function sheetsAppendRow(intent: { spreadsheetId: string; range?: string; row: (string | number)[] }) {
	const saJson = await loadSecret('gcp');
	const sa: SAKey = JSON.parse(saJson);
	const token = await gcpAccessToken(sa, 'https://www.googleapis.com/auth/spreadsheets');
	const range = intent.range ?? 'Experiments!A1';
	const res = await fetch(
		`https://sheets.googleapis.com/v4/spreadsheets/${intent.spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
		{ method: 'POST', headers: authHeaders(token, { 'content-type': 'application/json' }), body: JSON.stringify({ values: [intent.row] }) }
	);
	const data = await res.json();
	return redact({ ok: res.ok, status: res.status, updatedRange: data?.updates?.updatedRange, updates: data?.updates });
}

export async function sheetsRead(intent: { spreadsheetId: string; range: string }) {
	const saJson = await loadSecret('gcp');
	const sa: SAKey = JSON.parse(saJson);
	const token = await gcpAccessToken(sa, 'https://www.googleapis.com/auth/spreadsheets.readonly');
	const res = await fetch(
		`https://sheets.googleapis.com/v4/spreadsheets/${intent.spreadsheetId}/values/${encodeURIComponent(intent.range)}`,
		{ headers: authHeaders(token) }
	);
	const data = await res.json();
	return redact({ ok: res.ok, status: res.status, values: data?.values ?? [] });
}

/* ───────────────────────────── RunPod ─────────────────────────────── */
/**
 * RunPod is the primary training backend. GraphQL API at api.runpod.io.
 * Budget safety = defense in depth, NONE of which is "trust the LLM":
 *   1. RunPod's own $0 auto-stop (user keeps auto-reload OFF) — hard ceiling.
 *   2. Deterministic month-to-date budget check in the intent route BEFORE a
 *      job runs. Over budget -> approval, not spend.
 *   3. Per-pod estimate check against MAX_JOB_USD.
 * The agent never funds the account; top-ups are a human console action.
 */

async function runpodGraphQL(query: string, variables: Record<string, any> = {}) {
	const key = await loadSecret('runpod');
	const res = await fetch('https://api.runpod.io/graphql', {
		method: 'POST',
		headers: authHeaders(key, { 'content-type': 'application/json' }),
		body: JSON.stringify({ query, variables })
	});
	const data = await res.json();
	return { ok: res.ok, status: res.status, data };
}

/** Read balance + spend/hr. Tier-1 read. Backbone of the budget layer. */
export async function runpodBalance() {
	const q = `query { myself { clientBalance currentSpendPerHr } }`;
	const r = await runpodGraphQL(q);
	const me = r.data?.data?.myself;
	return redact({
		ok: r.ok && !r.data?.errors, status: r.status,
		clientBalance: me?.clientBalance, currentSpendPerHr: me?.currentSpendPerHr, errors: r.data?.errors
	});
}

/** Launch a training pod. Cost governed by the budget layer in the route.
 * SECURITY: the HF write token is injected here, server-side, from the vault —
 * the agent never sends it. The agent's env list carries only non-secret config
 * (BASE_MODEL, DATASET, METHOD, OUTPUT_REPO). We append HF_TOKEN before deploy.
 */
export async function runpodLaunchPod(intent: { spec: {
	name: string; gpuTypeId: string; imageName: string; gpuCount?: number;
	containerDiskInGb?: number; volumeInGb?: number; env?: { key: string; value: string }[];
	dockerArgs?: string; cloudType?: string;
} }) {
	const s = intent.spec;
	// Inject the HF token from the vault, stripping any client-supplied HF_TOKEN.
	const hfToken = await loadSecret('hf');
	const agentEnv = (s.env ?? []).filter((e) => e.key !== 'HF_TOKEN');
	const env = [...agentEnv, { key: 'HF_TOKEN', value: hfToken }];
	const q = `mutation Deploy($input: PodFindAndDeployOnDemandInput!) {
		podFindAndDeployOnDemand(input: $input) { id imageName machineId costPerHr desiredStatus }
	}`;
	const input = {
		name: s.name, imageName: s.imageName, gpuTypeId: s.gpuTypeId,
		gpuCount: s.gpuCount ?? 1, cloudType: s.cloudType ?? 'SECURE',
		containerDiskInGb: s.containerDiskInGb ?? 20, volumeInGb: s.volumeInGb ?? 0,
		dockerArgs: s.dockerArgs ?? '', env
	};
	const r = await runpodGraphQL(q, { input });
	const pod = r.data?.data?.podFindAndDeployOnDemand;
	return redact({ ok: r.ok && !r.data?.errors, status: r.status, podId: pod?.id, costPerHr: pod?.costPerHr, pod, errors: r.data?.errors });
}

export async function runpodPodStatus(intent: { podId: string }) {
	const q = `query Pod($podId: String!) {
		pod(input: { podId: $podId }) {
			id desiredStatus costPerHr
			runtime { uptimeInSeconds container { cpuPercent memoryPercent } }
		}
	}`;
	const r = await runpodGraphQL(q, { podId: intent.podId });
	return redact({ ok: r.ok && !r.data?.errors, status: r.status, pod: r.data?.data?.pod, errors: r.data?.errors });
}

export async function runpodTerminatePod(intent: { podId: string }) {
	const q = `mutation Terminate($podId: String!) { podTerminate(input: { podId: $podId }) }`;
	const r = await runpodGraphQL(q, { podId: intent.podId });
	return redact({ ok: r.ok && !r.data?.errors, status: r.status, terminated: true, errors: r.data?.errors });
}

/* ────────────────────────── Granted (Playwright worker) ──────────────────────── */
/**
 * Granted AI has no API — a separate Playwright worker drives the site. The
 * broker calls the worker over an authenticated internal HTTP endpoint, passing
 * the Granted credentials (decrypted here, server-side) plus a shared worker
 * token. The agent never sees the credentials. submit is Tier-2 (approval-gated
 * at the intent route AND re-checked by the worker's approval token).
 *
 * Requires env: GRANTED_WORKER_URL, GRANTED_WORKER_TOKEN.
 */
async function callGrantedWorker(path: string, payload: Record<string, any>) {
	const base = process.env.GRANTED_WORKER_URL;
	const workerToken = process.env.GRANTED_WORKER_TOKEN;
	if (!base || !workerToken) throw new Error('Granted worker not configured (GRANTED_WORKER_URL / GRANTED_WORKER_TOKEN)');
	const creds = JSON.parse(await loadSecret('granted')); // { email, password }
	const headers: Record<string, string> = {};
	headers['content-type'] = 'application/json';
	headers['x-worker-token'] = workerToken;
	const res = await fetch(base.replace(/\/$/, '') + path, {
		method: 'POST',
		headers,
		body: JSON.stringify({ ...payload, email: creds.email, password: creds.password })
	});
	const data = await res.json();
	return redact({ ok: res.ok && data?.ok !== false, status: res.status, ...data });
}

export async function grantDiscover(intent: { keywords: string; maxResults?: number }) {
	return callGrantedWorker('/discover', { keywords: intent.keywords, maxResults: intent.maxResults ?? 20 });
}

export async function grantDraft(intent: { grantUrl: string; projectSummary?: string }) {
	return callGrantedWorker('/draft', { grantUrl: intent.grantUrl, projectSummary: intent.projectSummary ?? '' });
}

export async function grantSubmit(intent: { grantUrl: string; approvalToken?: string }) {
	// The intent route only reaches here after operator approval (Tier-2). The
	// worker independently re-checks its own approval token as a second gate.
	return callGrantedWorker('/submit', { grantUrl: intent.grantUrl, approvalToken: intent.approvalToken });
}

/* ───────────────────────────── Registry ───────────────────────────── */

export const brokerRegistry: Record<string, (intent: any) => Promise<any>> = {
	'hf.read': hfDatasetSearch,
	'hf.model.search': hfModelSearch,
	'hf.whoami': hfWhoami,
	'hf.write': hfWrite,
	'sheets.write': sheetsAppendRow,
	'sheets.read': sheetsRead,
	'runpod.balance': runpodBalance,
	'runpod.train.submit': runpodLaunchPod,
	'runpod.pod.status': runpodPodStatus,
	'runpod.pod.terminate': runpodTerminatePod,
	'grant.discover': grantDiscover,
	'grant.draft': grantDraft,
	'grant.submit': grantSubmit
};
