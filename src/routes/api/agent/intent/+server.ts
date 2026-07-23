import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAgent } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { actions, capabilities, auditLog, settings } from '$lib/server/db/schema';
import { eq, and, gte, inArray } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { brokerRegistry } from '$lib/server/broker';
import { redact } from '$lib/server/vault';

/**
 * AGENT INTENT ENDPOINT — with deterministic budget enforcement.
 *
 * Decision order (NONE of it trusts the LLM to self-limit):
 *   1. unknown capability            -> rejected
 *   2. capability disabled           -> rejected
 *   3. per-job estimate > MAX_JOB_USD -> approval
 *   4. spend-tracked cap: for training capabilities, month-to-date spend +
 *      this estimate > budget.monthlyTrainingUsd -> approval
 *   5. Tier 2                         -> approval
 *   6. otherwise Tier 1              -> broker executes now, scrubbed result
 *
 * The monthly cap here is the SECOND brake; RunPod's own $0 auto-stop is the
 * hard platform ceiling. The agent never funds the account.
 */

// Capabilities that actually spend money on compute (subject to the monthly cap).
const SPEND_CAPABILITIES = ['runpod.train.submit'];

async function getSetting(key: string): Promise<string | undefined> {
	const [row] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
	return row?.value;
}

/** Sum estimatedUsd of spend-capability actions this calendar month that ran or are running. */
async function monthToDateSpend(): Promise<number> {
	const start = new Date();
	start.setDate(1); start.setHours(0, 0, 0, 0);
	const rows = await db.select({ est: actions.estimatedUsd, status: actions.status, cap: actions.capability })
		.from(actions)
		.where(and(gte(actions.createdAt, start), inArray(actions.capability, SPEND_CAPABILITIES)));
	// Count spend that was actually committed (ran/running/done), not rejected/pending.
	const committed = ['running', 'done', 'approved'];
	return rows.filter((r) => committed.includes(r.status)).reduce((sum, r) => sum + (r.est ?? 0), 0);
}

export const POST: RequestHandler = async ({ request }) => {
	requireAgent(request);
	const body = await request.json();
	const { capability, intent, estimatedUsd = 0 } = body;

	const [cap] = await db.select().from(capabilities).where(eq(capabilities.key, capability)).limit(1);
	if (!cap) return json({ status: 'rejected', reason: 'unknown capability' }, { status: 400 });

	await db.insert(auditLog).values({
		actor: 'agent', event: 'intent.submitted',
		detail: redact({ capability, intent, estimatedUsd })
	});

	if (!cap.enabled) {
		const [row] = await db.insert(actions).values({
			capability, tier: cap.tier, status: 'rejected',
			intent, estimatedUsd, operatorNote: 'capability toggle is OFF'
		}).returning();
		return json({ status: 'rejected', reason: 'capability disabled by operator', actionId: row.id });
	}

	// Determine whether this needs approval, and why.
	let needsApproval = cap.tier === 2;
	let reason = cap.tier === 2 ? 'tier-2 action requires operator approval' : '';

	const maxJobUsd = Number(env.MAX_JOB_USD ?? '15');
	if (estimatedUsd > maxJobUsd) {
		needsApproval = true;
		reason = `estimated $${estimatedUsd} exceeds per-job cap $${maxJobUsd}`;
	}

	// Deterministic monthly training-budget cap (the spend-tracked brake).
	if (SPEND_CAPABILITIES.includes(capability)) {
		const monthlyBudget = Number(await getSetting('budget.monthlyTrainingUsd') ?? '0');
		const mtd = await monthToDateSpend();
		if (monthlyBudget > 0 && mtd + estimatedUsd > monthlyBudget) {
			needsApproval = true;
			reason = `month-to-date training spend $${mtd.toFixed(2)} + this $${estimatedUsd} would exceed monthly budget $${monthlyBudget}`;
		}
	}

	if (needsApproval) {
		const [row] = await db.insert(actions).values({
			capability, tier: cap.tier, status: 'pending_approval', intent, estimatedUsd, operatorNote: reason
		}).returning();
		return json({ status: 'pending_approval', actionId: row.id, reason });
	}

	// Enabled, within all budget gates -> execute through broker now.
	const [row] = await db.insert(actions).values({
		capability, tier: 1, status: 'running', intent, estimatedUsd
	}).returning();

	try {
		const handler = brokerRegistry[capability];
		if (!handler) throw new Error(`no broker handler for ${capability}`);
		const result = await handler(intent);              // secret used server-side, scrubbed result out
		await db.update(actions).set({ status: 'done', result, completedAt: new Date() }).where(eq(actions.id, row.id));
		return json({ status: 'done', actionId: row.id, result });
	} catch (e) {
		const msg = e instanceof Error ? e.message : 'broker error';
		await db.update(actions).set({ status: 'failed', result: { error: msg } }).where(eq(actions.id, row.id));
		return json({ status: 'failed', actionId: row.id, error: msg }, { status: 502 });
	}
};
