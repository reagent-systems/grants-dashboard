import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAgent } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { actions, capabilities, settings } from '$lib/server/db/schema';
import { desc } from 'drizzle-orm';

/**
 * AGENT READ-ONLY STATUS + INFORMATION ACQUISITION.
 * This is how the agent LEARNS what to do without hardcoding anything:
 *   - capabilities: which toggles are ON (what I'm allowed to attempt)
 *   - settings: non-secret task config (region, image, HF workspace,
 *     DoE spreadsheet id, budget hints) — I READ params from here
 *   - actions: my recent queued/ran items, already scrubbed
 * No credential columns are selectable anywhere in this response.
 */
export const GET: RequestHandler = async ({ request }) => {
	requireAgent(request);
	const caps = await db.select().from(capabilities);
	const cfg = await db.select().from(settings);
	const recent = await db.select({
		id: actions.id, capability: actions.capability, tier: actions.tier,
		status: actions.status, estimatedUsd: actions.estimatedUsd,
		result: actions.result, operatorNote: actions.operatorNote, createdAt: actions.createdAt
	}).from(actions).orderBy(desc(actions.createdAt)).limit(50);
	return json({ capabilities: caps, settings: cfg, actions: recent });
};
