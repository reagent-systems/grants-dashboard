import { pgTable, text, timestamp, boolean, integer, jsonb, serial, uuid } from 'drizzle-orm/pg-core';

/**
 * VAULT — encrypted credentials.
 * `ciphertext` is AES-256-GCM. There is deliberately NO route that returns
 * this column to any client. It is read ONLY inside broker functions, at
 * execution time, and the plaintext never leaves the function scope.
 */
export const credentials = pgTable('credentials', {
	id: uuid('id').defaultRandom().primaryKey(),
	service: text('service').notNull(),        // 'gcp' | 'google_oauth' | 'hf' | 'granted'
	label: text('label').notNull(),
	ciphertext: text('ciphertext').notNull(),  // base64(iv || authTag || encrypted)
	createdAt: timestamp('created_at').defaultNow().notNull(),
	updatedAt: timestamp('updated_at').defaultNow().notNull()
});

/**
 * CAPABILITY TOGGLES — the "page of toggles" the agent reasons about.
 * The agent can READ these (to know what it may attempt) but only the
 * operator (you), behind password auth, can flip them.
 */
export const capabilities = pgTable('capabilities', {
	key: text('key').primaryKey(),             // 'hf.read', 'gcp.qlora.submit', 'grant.submit'...
	tier: integer('tier').notNull(),           // 1 = agent may auto-run, 2 = requires approval
	enabled: boolean('enabled').default(false).notNull(),
	description: text('description').notNull(),
	updatedAt: timestamp('updated_at').defaultNow().notNull()
});

/**
 * ACTION QUEUE — the intent/approval plane.
 * Agent INSERTs intents. Tier-1 with enabled capability -> broker executes.
 * Tier-2 -> waits in 'pending_approval' until operator flips it in the UI.
 */
export const actions = pgTable('actions', {
	id: serial('id').primaryKey(),
	capability: text('capability').notNull(),
	tier: integer('tier').notNull(),
	status: text('status').default('queued').notNull(),
	// queued | pending_approval | approved | rejected | running | done | failed
	intent: jsonb('intent').notNull(),         // structured, secret-free description
	estimatedUsd: integer('estimated_usd'),
	result: jsonb('result'),                   // scrubbed output returned to agent
	operatorNote: text('operator_note'),
	createdAt: timestamp('created_at').defaultNow().notNull(),
	decidedAt: timestamp('decided_at'),
	completedAt: timestamp('completed_at')
});

/**
 * AUDIT LOG — append-only. Every credential use, every agent call, every
 * operator decision. This is how you verify the agent never saw a secret.
 */
export const auditLog = pgTable('audit_log', {
	id: serial('id').primaryKey(),
	actor: text('actor').notNull(),            // 'agent' | 'operator' | 'broker'
	event: text('event').notNull(),
	detail: jsonb('detail'),
	createdAt: timestamp('created_at').defaultNow().notNull()
});

/**
 * SETTINGS — non-secret task configuration the AGENT READS to acquire the
 * information it needs to do work (GCP region, default container image,
 * HF workspace, the DoE spreadsheet id, budget hints...). This is the
 * "dashboard as information source" surface: I never hardcode task params,
 * I pull them from here. Operator writes; agent reads via /api/agent/status.
 * NEVER put a secret here — secrets go in the encrypted `credentials` vault.
 */
export const settings = pgTable('settings', {
	key: text('key').primaryKey(),
	value: text('value').notNull(),
	description: text('description').notNull(),
	updatedAt: timestamp('updated_at').defaultNow().notNull()
});

/**
 * EXPERIMENTS — DoE mirror so the agent's scientific state is visible to you
 * even when Sheets isn't the source of truth.
 */
export const experiments = pgTable('experiments', {
	id: serial('id').primaryKey(),
	name: text('name').notNull(),
	baseModel: text('base_model').notNull(),
	method: text('method').notNull(),          // 'qlora' | 'lora' | 'full_ft'
	hyperparams: jsonb('hyperparams').notNull(),
	targetMetric: text('target_metric'),
	result: jsonb('result'),
	status: text('status').default('planned').notNull(),
	createdAt: timestamp('created_at').defaultNow().notNull()
});
