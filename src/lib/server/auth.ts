import { env } from '$env/dynamic/private';
import { timingSafeEqual, scryptSync } from 'node:crypto';
import { error } from '@sveltejs/kit';

function safeEq(a: string, b: string): boolean {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
}

/**
 * Agent auth — the ONE secret the agent holds. Grants access to:
 *   - POST intents to the action queue
 *   - GET status / metrics / capability toggles (read-only)
 * Does NOT grant: vault reads, toggle flips, Tier-2 approvals.
 */
export function requireAgent(request: Request): void {
	const expected = env.AGENT_TOKEN;
	if (!expected) throw error(500, 'agent auth not configured');
	const auth = request.headers.get('authorization') ?? '';
	const token = auth.replace(/^Bearer\s+/i, '');
	if (!token || !safeEq(token, expected)) {
		throw error(401, 'invalid agent token');
	}
}

/**
 * Operator auth — protects vault writes and Tier-2 approval toggles.
 * Only you, in a browser, behind this password. The agent has no way to
 * satisfy this check.
 */
export function requireOperator(password: string): void {
	const stored = env.OPERATOR_PASSWORD_HASH;
	if (!stored) throw error(500, 'operator auth not configured');
	const [salt, hash] = stored.split(':');
	if (!salt || !hash) throw error(500, 'operator auth not configured');
	const computed = scryptSync(password, salt, 64).toString('hex');
	if (!safeEq(computed, hash)) throw error(401, 'invalid operator credentials');
}
