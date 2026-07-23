import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '$env/dynamic/private';

/**
 * VAULT CRYPTO — the enforcement point of the whole design.
 *
 * SECURITY INVARIANT:
 *   - `encrypt()` is called from the operator's vault-write route only.
 *   - `decryptForBroker()` returns plaintext ONLY to server-side broker
 *     functions, which use it to sign an outbound API request and then
 *     drop it. It is NEVER serialized into any HTTP response, log line,
 *     DB row, or value that reaches the agent's context.
 *   - There is intentionally no exported "getCredential" / "readSecret".
 *
 * If you ever find yourself wanting to return decrypted output to a
 * route handler that the agent can call — stop. That breaks the model.
 */

const ALGO = 'aes-256-gcm';

function masterKey(): Buffer {
	const raw = env.VAULT_MASTER_KEY;
	if (!raw) throw new Error('VAULT_MASTER_KEY not configured');
	const key = Buffer.from(raw, 'base64');
	if (key.length !== 32) {
		throw new Error('VAULT_MASTER_KEY must be 32 bytes (base64-encoded).');
	}
	return key;
}

/** Encrypt a plaintext secret. Called only from the operator write path. */
export function encrypt(plaintext: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv(ALGO, masterKey(), iv);
	const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return Buffer.concat([iv, tag, enc]).toString('base64');
}

/**
 * Decrypt — INTERNAL to the broker. Marked with a scary name so any code
 * review that sees it called outside src/lib/server/broker/ is a red flag.
 * The returned string must be used and discarded within the same function;
 * do not assign it to anything that escapes broker scope.
 */
export function decryptForBroker(ciphertext: string): string {
	const raw = Buffer.from(ciphertext, 'base64');
	const iv = raw.subarray(0, 12);
	const tag = raw.subarray(12, 28);
	const enc = raw.subarray(28);
	const decipher = createDecipheriv(ALGO, masterKey(), iv);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

/**
 * Redact — belt-and-suspenders. Any object that might travel back toward
 * the agent passes through this to strip anything secret-shaped.
 */
const SECRET_PATTERNS = [
	/AIza[0-9A-Za-z_-]{20,}/g,          // Google API keys
	/ya29\.[0-9A-Za-z_-]+/g,            // Google OAuth access tokens
	/hf_[0-9A-Za-z]{20,}/g,             // HF tokens
	/-----BEGIN[\s\S]+?PRIVATE KEY-----/g,
	/"private_key"\s*:\s*"[^"]+"/g
];

export function redact<T>(value: T): T {
	let s = JSON.stringify(value);
	for (const p of SECRET_PATTERNS) s = s.replace(p, '[REDACTED]');
	return JSON.parse(s);
}
