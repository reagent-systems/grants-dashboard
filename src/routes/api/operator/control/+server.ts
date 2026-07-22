import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireOperator } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { capabilities, actions, auditLog, settings } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { brokerRegistry } from '$lib/server/broker';

/** Flip a capability toggle. Operator-only. */
export const PATCH: RequestHandler = async ({ request }) => {
	const { password, key, enabled } = await request.json();
	requireOperator(password);
	await db.update(capabilities).set({ enabled, updatedAt: new Date() }).where(eq(capabilities.key, key));
	await db.insert(auditLog).values({ actor: 'operator', event: 'capability.toggled', detail: { key, enabled } });
	return json({ ok: true });
};

/** Upsert a non-secret setting the agent reads. Operator-only. */
export const PUT: RequestHandler = async ({ request }) => {
	const { password, key, value, description } = await request.json();
	requireOperator(password);
	await db.insert(settings).values({ key, value, description: description ?? key })
		.onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
	await db.insert(auditLog).values({ actor: 'operator', event: 'setting.updated', detail: { key } });
	return json({ ok: true });
};

/**
 * Approve or reject a pending Tier-2 (or over-budget) action.
 * On approve, the broker runs and only the scrubbed result is stored.
 * This is the async human gate — grants submission lands here too.
 */
export const POST: RequestHandler = async ({ request }) => {
	const { password, actionId, decision, note } = await request.json();
	requireOperator(password);

	const [act] = await db.select().from(actions).where(eq(actions.id, actionId)).limit(1);
	if (!act) return json({ ok: false, reason: 'no such action' }, { status: 404 });

	if (decision === 'reject') {
		await db.update(actions).set({ status: 'rejected', operatorNote: note, decidedAt: new Date() }).where(eq(actions.id, actionId));
		await db.insert(auditLog).values({ actor: 'operator', event: 'action.rejected', detail: { actionId, note } });
		return json({ ok: true, status: 'rejected' });
	}

	await db.update(actions).set({ status: 'running', decidedAt: new Date(), operatorNote: note }).where(eq(actions.id, actionId));
	await db.insert(auditLog).values({ actor: 'operator', event: 'action.approved', detail: { actionId, note } });

	try {
		const handler = brokerRegistry[act.capability];
		if (!handler) throw new Error(`no broker handler for ${act.capability}`);
		const result = await handler(act.intent);
		await db.update(actions).set({ status: 'done', result, completedAt: new Date() }).where(eq(actions.id, actionId));
		return json({ ok: true, status: 'done', result });
	} catch (e) {
		const msg = e instanceof Error ? e.message : 'broker error';
		await db.update(actions).set({ status: 'failed', result: { error: msg } }).where(eq(actions.id, actionId));
		return json({ ok: false, status: 'failed', error: msg }, { status: 502 });
	}
};
