import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireOperator } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { capabilities, actions, settings } from '$lib/server/db/schema';
import { desc } from 'drizzle-orm';

/**
 * Operator dashboard data feed. Password-gated (not the agent token) so the
 * browser UI can render toggles + settings + queue without holding the agent
 * token. Returns only already-scrubbed / non-secret columns.
 */
export const POST: RequestHandler = async ({ request }) => {
	const { password } = await request.json();
	requireOperator(password);
	const caps = await db.select().from(capabilities);
	const cfg = await db.select().from(settings);
	const acts = await db.select({
		id: actions.id, capability: actions.capability, tier: actions.tier,
		status: actions.status, estimatedUsd: actions.estimatedUsd,
		intent: actions.intent, operatorNote: actions.operatorNote, createdAt: actions.createdAt
	}).from(actions).orderBy(desc(actions.createdAt)).limit(50);
	return json({ capabilities: caps, settings: cfg, actions: acts });
};
