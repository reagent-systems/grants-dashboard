import { db } from '../src/lib/server/db/index.ts';
import { capabilities, settings } from '../src/lib/server/db/schema.ts';

/**
 * Seed capability toggles + non-secret settings. Run once after db:push.
 *   Tier 1 = agent may auto-run when toggle is ON and under budget cap.
 *   Tier 2 = agent may only PROPOSE; you approve in the UI.
 *
 * Compute backend = RunPod (prepaid bucket, auto-reload OFF = $0 hard-stop).
 */
const CAPS = [
	{ key: 'hf.read',            tier: 1, enabled: false, description: 'Search/read Hugging Face datasets' },
	{ key: 'hf.model.search',    tier: 1, enabled: false, description: 'Search Hugging Face models' },
	{ key: 'hf.whoami',          tier: 1, enabled: false, description: 'Verify HF token / read workspace identity' },
	{ key: 'hf.write',           tier: 2, enabled: false, description: 'Push models/artifacts to HF Hub' },
	{ key: 'sheets.read',        tier: 1, enabled: false, description: 'Read the DoE experiment tracker' },
	{ key: 'sheets.write',       tier: 1, enabled: false, description: 'Append experiment rows to the DoE tracker' },
	{ key: 'runpod.balance',     tier: 1, enabled: false, description: 'Read RunPod balance + spend/hr (budget layer)' },
	{ key: 'runpod.train.submit',tier: 1, enabled: false, description: 'Launch a RunPod training pod (subject to monthly budget cap)' },
	{ key: 'runpod.pod.status',  tier: 1, enabled: false, description: 'Poll a RunPod pod status/runtime' },
	{ key: 'runpod.pod.terminate',tier:1, enabled: false, description: 'Terminate a RunPod pod (stops billing)' },
	{ key: 'grant.discover',     tier: 1, enabled: false, description: 'Discover grants via Granted AI' },
	{ key: 'grant.draft',        tier: 1, enabled: false, description: 'Draft grant applications' },
	{ key: 'grant.submit',       tier: 2, enabled: false, description: 'SUBMIT a grant application — approval required' }
];

/**
 * Non-secret settings the AGENT READS to acquire task parameters. Fill in the
 * real values via the dashboard UI (or edit here before seeding). NEVER a secret.
 */
const SETTINGS = [
	// RunPod compute config
	{ key: 'runpod.gpuTypeId',      value: 'NVIDIA A40',                           description: 'Default RunPod GPU type id for <1B training (cheap, plenty for <1B)' },
	{ key: 'runpod.cloudType',      value: 'SECURE',                               description: 'RunPod cloud type: SECURE or COMMUNITY (COMMUNITY is cheaper)' },
	{ key: 'runpod.trainImage',     value: 'TODO-set-your-training-container-image', description: 'Docker image for training pods (must checkpoint to HF)' },
	{ key: 'runpod.volumeInGb',     value: '0',                                    description: 'Network volume GB for persistence (0 = ephemeral; set >0 to survive $0 stop)' },
	// HF + DoE
	{ key: 'hf.workspace',          value: 'TODO-set-your-hf-org-or-username',     description: 'HF org/username to push artifacts + checkpoints to' },
	{ key: 'doe.spreadsheetId',     value: 'TODO-set-your-google-sheet-id',        description: 'Google Sheet ID for the DoE experiment tracker' },
	{ key: 'doe.range',             value: 'Experiments!A1',                       description: 'Append range in the DoE sheet (Experiments tab)' },
	{ key: 'doe.curationRange',     value: 'Curation!A1',                          description: 'Append range for dataset-version curation stats' },
	{ key: 'doe.metaLogRange',      value: 'MetaLog!A1',                           description: 'Append range for meta-loop cycle records' },
	// Budget layer (deterministic, server-enforced)
	{ key: 'budget.monthlyTrainingUsd', value: '20',                              description: 'HARD monthly training budget. Broker refuses jobs that would exceed month-to-date+estimate. This is enforced in code, not by the agent.' },
	{ key: 'budget.runpodLowThresholdUsd', value: '5',                            description: 'Alert threshold: warn to top up when RunPod balance drops below this' },
	{ key: 'model.range',           value: '<1B',                                  description: 'Allowed model size range now (<1B full fine-tune on single GPU). 7-12B deferred until a grant funds it.' }
];

for (const c of CAPS) await db.insert(capabilities).values(c).onConflictDoNothing();
for (const s of SETTINGS) await db.insert(settings).values(s).onConflictDoNothing();
console.log(`seeded ${CAPS.length} capabilities + ${SETTINGS.length} settings (all caps OFF by default)`);
