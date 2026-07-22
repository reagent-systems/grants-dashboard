<script lang="ts">
	let password = $state('');
	let caps = $state<any[]>([]);
	let cfg = $state<any[]>([]);
	let pending = $state<any[]>([]);
	let recent = $state<any[]>([]);
	let vault = $state({ service: 'hf', label: '', secret: '' });
	let msg = $state('');

	async function refresh() {
		const r = await fetch('/api/operator/view', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ password })
		});
		if (r.ok) {
			const d = await r.json();
			caps = d.capabilities;
			cfg = d.settings ?? [];
			pending = d.actions.filter((a: any) => a.status === 'pending_approval');
			recent = d.actions.slice(0, 20);
		}
	}

	async function saveSetting(key: string, value: string) {
		await fetch('/api/operator/control', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ password, key, value })
		});
		refresh();
	}

	async function toggle(key: string, enabled: boolean) {
		await fetch('/api/operator/control', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ password, key, enabled })
		});
		refresh();
	}

	async function decide(actionId: number, decision: 'approve' | 'reject') {
		const note = decision === 'reject' ? prompt('Reason / feedback for the agent:') ?? '' : '';
		await fetch('/api/operator/control', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ password, actionId, decision, note })
		});
		refresh();
	}

	async function storeSecret() {
		const r = await fetch('/api/operator/vault', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ password, ...vault })
		});
		const d = await r.json();
		msg = d.message ?? d.error ?? 'done';
		vault.secret = '';
		vault.label = '';
	}
</script>

<main>
	<h1>ML Research Agent — Control Portal</h1>
	<p class="sub">Credentials stay here. The agent only sees toggles, intents, and scrubbed status.</p>

	<section class="auth">
		<label>Operator password
			<input type="password" bind:value={password} placeholder="unlock controls" />
		</label>
		<button onclick={refresh}>Unlock / Refresh</button>
	</section>

	<section>
		<h2>🔐 Vault — add a credential (write-only)</h2>
		<div class="vault">
			<select bind:value={vault.service}>
				<option value="hf">Hugging Face token</option>
				<option value="runpod">RunPod API key</option>
				<option value="gcp">Google service-account JSON (Sheets)</option>
				<option value="google_oauth">Google OAuth</option>
				<option value="granted">Granted AI login</option>
			</select>
			<input bind:value={vault.label} placeholder="label (e.g. 'prod SA')" />
			<textarea bind:value={vault.secret} placeholder="paste secret — encrypted on submit, never readable again"></textarea>
			<button onclick={storeSecret}>Encrypt &amp; store</button>
			{#if msg}<span class="msg">{msg}</span>{/if}
		</div>
	</section>

	<section>
		<h2>⚙️ Task settings (agent reads these)</h2>
		<p class="hint">Non-secret config the agent pulls to run jobs. No secrets here — those go in the vault.</p>
		{#each cfg as s}
			<div class="setting">
				<code>{s.key}</code>
				<input value={s.value} onchange={(e) => saveSetting(s.key, e.currentTarget.value)} />
				<span class="desc">{s.description}</span>
			</div>
		{/each}
		{#if cfg.length === 0}<p class="empty">Unlock to load settings.</p>{/if}
	</section>

	<section>
		<h2>🎛️ Capability toggles</h2>
		{#each caps as c}
			<div class="cap">
				<label class="switch">
					<input type="checkbox" checked={c.enabled} onchange={(e) => toggle(c.key, e.currentTarget.checked)} />
					<span class="slider"></span>
				</label>
				<code>{c.key}</code>
				<span class="tier tier-{c.tier}">Tier {c.tier}</span>
				<span class="desc">{c.description}</span>
			</div>
		{/each}
	</section>

	<section>
		<h2>⏳ Pending approvals ({pending.length})</h2>
		{#each pending as a}
			<div class="action pending">
				<div>
					<strong>#{a.id}</strong> <code>{a.capability}</code>
					{#if a.estimatedUsd}<span class="cost">~${a.estimatedUsd}</span>{/if}
					<pre>{JSON.stringify(a.intent, null, 2)}</pre>
				</div>
				<div class="btns">
					<button class="approve" onclick={() => decide(a.id, 'approve')}>Approve</button>
					<button class="reject" onclick={() => decide(a.id, 'reject')}>Reject</button>
				</div>
			</div>
		{/each}
		{#if pending.length === 0}<p class="empty">Nothing waiting on you.</p>{/if}
	</section>

	<section>
		<h2>📜 Recent actions</h2>
		{#each recent as a}
			<div class="action">
				<code>{a.capability}</code>
				<span class="status status-{a.status}">{a.status}</span>
				{#if a.operatorNote}<em>— {a.operatorNote}</em>{/if}
			</div>
		{/each}
	</section>
</main>

<style>
	:global(body) { background: #0b0e14; color: #d7dce5; font: 15px/1.5 ui-sans-serif, system-ui; margin: 0; }
	main { max-width: 900px; margin: 0 auto; padding: 2rem; }
	h1 { margin-bottom: 0.2rem; }
	.sub { color: #7d8798; margin-top: 0; }
	section { background: #131824; border: 1px solid #222a3a; border-radius: 12px; padding: 1.2rem; margin: 1rem 0; }
	h2 { margin-top: 0; font-size: 1.05rem; }
	input, select, textarea { background: #0b0e14; color: #d7dce5; border: 1px solid #2a3348; border-radius: 8px; padding: 0.5rem; font: inherit; }
	textarea { width: 100%; min-height: 90px; margin: 0.4rem 0; }
	button { background: #2f6feb; color: #fff; border: 0; border-radius: 8px; padding: 0.5rem 0.9rem; cursor: pointer; }
	button.reject { background: #c0392b; }
	button.approve { background: #1f9d55; }
	.cap { display: flex; align-items: center; gap: 0.6rem; padding: 0.4rem 0; border-bottom: 1px solid #1c2333; }
	.tier-2 { color: #f0a020; }
	.tier-1 { color: #4fb477; }
	.desc { color: #7d8798; font-size: 0.9rem; }
	.hint { color: #7d8798; font-size: 0.85rem; margin-top: 0; }
	.setting { display: flex; align-items: center; gap: 0.6rem; padding: 0.35rem 0; border-bottom: 1px solid #1c2333; }
	.setting code { min-width: 190px; color: #8ab4f8; }
	.setting input { flex: 1; }
	.action { display: flex; justify-content: space-between; gap: 1rem; padding: 0.5rem 0; border-bottom: 1px solid #1c2333; }
	.action.pending { background: #1a1d10; border-radius: 8px; padding: 0.8rem; margin: 0.5rem 0; }
	.cost { color: #f0a020; font-weight: 600; }
	pre { background: #0b0e14; padding: 0.6rem; border-radius: 8px; overflow: auto; font-size: 0.8rem; }
	.status-done { color: #4fb477; } .status-failed { color: #c0392b; } .status-pending_approval { color: #f0a020; }
	.empty { color: #7d8798; } .msg { color: #4fb477; margin-left: 0.5rem; }
	.switch { position: relative; display: inline-block; width: 40px; height: 22px; }
	.switch input { display: none; }
	.slider { position: absolute; inset: 0; background: #2a3348; border-radius: 22px; transition: 0.2s; }
	.slider:before { content: ''; position: absolute; height: 16px; width: 16px; left: 3px; bottom: 3px; background: #fff; border-radius: 50%; transition: 0.2s; }
	input:checked + .slider { background: #1f9d55; }
	input:checked + .slider:before { transform: translateX(18px); }
</style>
