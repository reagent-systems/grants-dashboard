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

<main class="portal-page">
	<header class="portal-header">
		<h1 class="portal-title">control portal</h1>
	</header>

	<div class="portal-sections">
		<section class="portal-block" aria-labelledby="section-auth">
			<h2 id="section-auth" class="section-heading">Access</h2>
			<div class="panel auth">
				<label class="field">
					<span class="field-label">Operator password</span>
					<input type="password" bind:value={password} placeholder="unlock controls" />
				</label>
				<button type="button" onclick={refresh}>Unlock / Refresh</button>
			</div>
		</section>

		<section class="portal-block" aria-labelledby="section-vault">
			<h2 id="section-vault" class="section-heading">Vault</h2>
			<div class="panel vault">
				<select bind:value={vault.service}>
					<option value="hf">Hugging Face token</option>
					<option value="runpod">RunPod API key</option>
					<option value="gcp">Google service-account JSON (Sheets)</option>
					<option value="google_oauth">Google OAuth</option>
					<option value="granted">Granted AI login</option>
				</select>
				<input bind:value={vault.label} placeholder="label (e.g. prod SA)" />
				<textarea
					bind:value={vault.secret}
					placeholder="paste secret — encrypted on submit"
				></textarea>
				<div class="row">
					<button type="button" onclick={storeSecret}>Encrypt &amp; store</button>
					{#if msg}<span class="msg">{msg}</span>{/if}
				</div>
			</div>
		</section>

		<section class="portal-block" aria-labelledby="section-settings">
			<h2 id="section-settings" class="section-heading">Task settings</h2>
			{#if cfg.length === 0}
				<p class="empty">Unlock to load settings.</p>
			{:else}
				<ul class="item-grid">
					{#each cfg as s}
						<li class="item-card setting">
							<code class="item-key">{s.key}</code>
							<input
								value={s.value}
								onchange={(e) => saveSetting(s.key, e.currentTarget.value)}
							/>
							{#if s.description}
								<span class="item-desc">{s.description}</span>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<section class="portal-block" aria-labelledby="section-caps">
			<h2 id="section-caps" class="section-heading">Capabilities</h2>
			{#if caps.length === 0}
				<p class="empty">Unlock to load capabilities.</p>
			{:else}
				<ul class="item-list">
					{#each caps as c}
						<li class="item-card cap">
							<label class="switch">
								<input
									type="checkbox"
									checked={c.enabled}
									onchange={(e) => toggle(c.key, e.currentTarget.checked)}
								/>
								<span class="slider"></span>
							</label>
							<div class="cap-meta">
								<code class="item-key">{c.key}</code>
								<span class="tier tier-{c.tier}">Tier {c.tier}</span>
								{#if c.description}
									<span class="item-desc">{c.description}</span>
								{/if}
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<section class="portal-block" aria-labelledby="section-pending">
			<h2 id="section-pending" class="section-heading">Pending approvals ({pending.length})</h2>
			{#if pending.length === 0}
				<p class="empty">Nothing waiting.</p>
			{:else}
				<ul class="item-list">
					{#each pending as a}
						<li class="item-card action pending">
							<div class="action-body">
								<div class="action-top">
									<span class="mono">#{a.id}</span>
									<code class="item-key">{a.capability}</code>
									{#if a.estimatedUsd}<span class="cost">~${a.estimatedUsd}</span>{/if}
								</div>
								<pre>{JSON.stringify(a.intent, null, 2)}</pre>
							</div>
							<div class="btns">
								<button type="button" class="approve" onclick={() => decide(a.id, 'approve')}
									>Approve</button
								>
								<button type="button" class="reject" onclick={() => decide(a.id, 'reject')}
									>Reject</button
								>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<section class="portal-block" aria-labelledby="section-recent">
			<h2 id="section-recent" class="section-heading">Recent actions</h2>
			{#if recent.length === 0}
				<p class="empty">No recent actions.</p>
			{:else}
				<ul class="item-list">
					{#each recent as a}
						<li class="item-card action">
							<code class="item-key">{a.capability}</code>
							<span class="status status-{a.status}">{a.status}</span>
							{#if a.operatorNote}<em class="note">— {a.operatorNote}</em>{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	</div>
</main>

<style>
	.portal-page {
		min-height: 100vh;
		padding: 4rem clamp(1.5rem, 4vw, 4rem) 5rem;
		max-width: 960px;
		margin: 0 auto;
		background: var(--page-background);
		color: var(--text);
		font-family: var(--main-font);
	}

	.portal-header {
		margin-bottom: 3rem;
		padding-bottom: 2rem;
		border-bottom: 1px solid var(--border-header);
	}

	.portal-title {
		font-size: clamp(2.25rem, 5vw, 3.25rem);
		font-weight: 100;
		font-family: 'Raleway', var(--main-font);
		text-transform: lowercase;
		letter-spacing: -0.03em;
		line-height: 1.05;
		margin: 0;
	}

	.portal-sections {
		display: flex;
		flex-direction: column;
		gap: 2.5rem;
	}

	.portal-block {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.section-heading {
		font-size: 0.85rem;
		font-weight: 400;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-muted);
		margin: 0;
		padding-bottom: 0.35rem;
		border-bottom: 1px solid var(--border-soft);
	}

	.panel,
	.item-card {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 0.75rem;
		padding: 1.1rem 1.15rem;
		background: var(--card-bg);
		border: 1px solid var(--border);
		border-radius: 2px;
		box-shadow: 0 1px #00000008;
	}

	.item-grid,
	.item-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 1rem;
	}

	.item-grid {
		grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
		gap: 1rem 1.5rem;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.field-label,
	.item-desc,
	.empty,
	.note {
		font-size: 0.9rem;
		font-weight: 300;
		color: var(--text-soft);
		line-height: 1.35;
	}

	.empty {
		color: var(--text-muted);
	}

	.item-key,
	.mono {
		font-family: var(--ascii-font);
		font-weight: 300;
		font-size: 0.95rem;
		letter-spacing: -0.02em;
		color: #111;
	}

	.auth {
		flex-direction: row;
		flex-wrap: wrap;
		align-items: flex-end;
	}

	.auth .field {
		flex: 1 1 220px;
	}

	.vault select,
	.vault input,
	.vault textarea,
	.setting input,
	.auth input,
	input,
	select,
	textarea {
		width: 100%;
		background: var(--page-background);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 2px;
		padding: 0.55rem 0.7rem;
		font: inherit;
		font-weight: 300;
	}

	textarea {
		min-height: 90px;
		resize: vertical;
		font-family: var(--ascii-font);
		font-size: 0.85rem;
	}

	button {
		background: #1a1a1a;
		color: #fff;
		border: 0;
		border-radius: 2px;
		padding: 0.55rem 1rem;
		cursor: pointer;
		font-family: var(--main-font);
		font-weight: 300;
		font-size: 0.95rem;
		letter-spacing: 0.02em;
		align-self: flex-start;
		transition: background 0.2s ease;
	}

	button:hover {
		background: #333;
	}

	button.approve {
		background: var(--success);
	}

	button.approve:hover {
		background: #265a42;
	}

	button.reject {
		background: var(--danger);
	}

	button.reject:hover {
		background: #722525;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
	}

	.msg {
		font-family: var(--ascii-font);
		font-weight: 300;
		font-size: 0.9rem;
		color: var(--success);
	}

	.cap {
		flex-direction: row;
		align-items: center;
		gap: 1rem;
	}

	.cap-meta {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.4rem 0.75rem;
		min-width: 0;
	}

	.tier {
		font-family: var(--ascii-font);
		font-size: 0.8rem;
		font-weight: 300;
		color: var(--text-muted);
	}

	.tier-2 {
		color: var(--warn);
	}

	.tier-1 {
		color: var(--success);
	}

	.action {
		flex-direction: row;
		flex-wrap: wrap;
		justify-content: space-between;
		align-items: flex-start;
		gap: 1rem;
	}

	.action-body {
		flex: 1 1 280px;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.65rem;
	}

	.action-top {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.5rem 0.75rem;
	}

	.cost {
		font-family: var(--ascii-font);
		font-weight: 300;
		font-size: 0.95rem;
		color: var(--warn);
	}

	pre {
		background: var(--page-background);
		border: 1px solid var(--border-soft);
		padding: 0.7rem 0.8rem;
		border-radius: 2px;
		overflow: auto;
		font-family: var(--ascii-font);
		font-size: 0.78rem;
		font-weight: 300;
		line-height: 1.4;
		color: var(--text-soft);
	}

	.btns {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.status {
		font-family: var(--ascii-font);
		font-size: 0.85rem;
		font-weight: 300;
		color: var(--text-muted);
	}

	.status-done {
		color: var(--success);
	}

	.status-failed {
		color: var(--danger);
	}

	.status-pending_approval {
		color: var(--warn);
	}

	.switch {
		position: relative;
		display: inline-block;
		width: 40px;
		height: 22px;
		flex-shrink: 0;
	}

	.switch input {
		display: none;
	}

	.slider {
		position: absolute;
		inset: 0;
		background: #d8d8d8;
		border-radius: 22px;
		transition: 0.2s;
	}

	.slider:before {
		content: '';
		position: absolute;
		height: 16px;
		width: 16px;
		left: 3px;
		bottom: 3px;
		background: #fff;
		border-radius: 50%;
		transition: 0.2s;
		box-shadow: 0 1px 2px #00000022;
	}

	.switch input:checked + .slider {
		background: var(--success);
	}

	.switch input:checked + .slider:before {
		transform: translateX(18px);
	}

	@media (max-width: 520px) {
		.portal-page {
			padding-top: 2.5rem;
		}

		.auth {
			flex-direction: column;
			align-items: stretch;
		}

		.auth button {
			width: 100%;
		}
	}
</style>
