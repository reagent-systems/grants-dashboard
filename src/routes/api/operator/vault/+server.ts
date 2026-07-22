import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireOperator } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { credentials, auditLog } from '$lib/server/db/schema';
import { encrypt } from '$lib/server/vault';

/**
 * OPERATOR VAULT WRITE — write-only from your browser.
 * You paste a secret; it is encrypted immediately and stored. There is no
 * corresponding GET that returns plaintext. The agent cannot call this
 * (requireOperator needs your password, which the agent never has).
 */
export const POST: RequestHandler = async ({ request }) => {
	const { password, service, label, secret } = await request.json();
	requireOperator(password);

	const ciphertext = encrypt(secret);
	await db.insert(credentials).values({ service, label, ciphertext });
	await db.insert(auditLog).values({
		actor: 'operator',
		event: 'credential.stored',
		detail: { service, label } // never the secret
	});
	return json({ ok: true, message: `stored ${service} credential (encrypted)` });
};
