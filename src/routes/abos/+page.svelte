<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidate } from '$app/navigation';
	import { ARXIV_CATEGORY_GROUPS } from '$lib/arxiv-categories';
	import { t, type MessageKey } from '$lib/i18n';

	let { data, form } = $props();

	type Kind = 'keyword' | 'category' | 'author';
	const KINDS: Kind[] = ['keyword', 'category', 'author'];
	const WEIGHTS = ['0.5', '1', '2', '3'] as const;

	const previous = $derived(form && 'values' in form ? form.values : undefined);
	let kind = $state<Kind>('keyword');
	$effect(() => {
		const v = previous?.type;
		if (v === 'keyword' || v === 'category' || v === 'author') kind = v;
	});

	const categoryName = new Map(
		ARXIV_CATEGORY_GROUPS.flatMap((g) => g.categories.map((c) => [c.id, c.name] as const))
	);

	function describe(type: Kind, query: string): string {
		return type === 'category' && categoryName.has(query)
			? `${query} – ${categoryName.get(query)}`
			: query;
	}

	// Solange ein Nachladen läuft, den Status alle 3 Sekunden aktualisieren.
	const busy = $derived(
		data.subscriptions.some((s) => s.backfillStatus === 'pending' || s.backfillStatus === 'running')
	);
	$effect(() => {
		if (!busy) return;
		const timer = setInterval(() => invalidate('app:subscriptions'), 3000);
		return () => clearInterval(timer);
	});

	const statusKey = (s: string) => `subs.status.${s}` as MessageKey;
	const weightKey = (w: number | string) => `subs.weight.${w}` as MessageKey;
	const typeKey = (k: string) => `subs.type.${k}` as MessageKey;
</script>

<svelte:head>
	<title>{t('subs.title')} – {t('app.name')}</title>
</svelte:head>

<h1>{t('subs.title')}</h1>
<p>{t('subs.intro')}</p>

<section class="card">
	<h2>{t('subs.add')}</h2>
	<form
		method="POST"
		action="?/add"
		class="add-form"
		use:enhance={({ formElement }) =>
			async ({ result, update }) => {
				// Kein natives Reset: die gewählte Abo-Art bleibt erhalten, nur die Eingabe wird geleert.
				await update({ reset: false });
				if (result.type === 'success') {
					const input = formElement.querySelector<HTMLInputElement>('input#query');
					if (input) input.value = '';
				}
			}}
	>
		<fieldset class="kinds">
			<legend>{t('subs.type')}</legend>
			{#each KINDS as k (k)}
				<label class="kind">
					<input type="radio" name="type" value={k} bind:group={kind} />
					{t(typeKey(k))}
				</label>
			{/each}
		</fieldset>

		{#if kind === 'keyword'}
			<div>
				<label for="query">{t('subs.query.keyword')}</label>
				<input
					id="query"
					name="query"
					required
					maxlength="500"
					value={previous?.query ?? ''}
					aria-describedby="query-help"
				/>
				<p id="query-help" class="help">{t('subs.query.keyword.help')}</p>
			</div>
		{:else if kind === 'category'}
			<div>
				<label for="query">{t('subs.query.category')}</label>
				<select id="query" name="query" required>
					<option value="">{t('subs.query.category.choose')}</option>
					{#each ARXIV_CATEGORY_GROUPS as group (group.name)}
						<optgroup label={group.name}>
							{#each group.categories as c (c.id)}
								<option value={c.id} selected={previous?.query === c.id}>{c.id} – {c.name}</option>
							{/each}
						</optgroup>
					{/each}
				</select>
			</div>
		{:else}
			<div>
				<label for="query">{t('subs.query.author')}</label>
				<input
					id="query"
					name="query"
					required
					maxlength="200"
					value={previous?.query ?? ''}
					aria-describedby="author-help"
				/>
				<p id="author-help" class="help">{t('subs.query.author.help')}</p>
			</div>
		{/if}

		<div>
			<label for="weight">{t('subs.weight')}</label>
			<select id="weight" name="weight">
				{#each WEIGHTS as w (w)}
					<option value={w} selected={(previous?.weight ?? '1') === w}>{t(weightKey(w))}</option>
				{/each}
			</select>
		</div>

		{#if form && 'error' in form && form.error}
			<p class="error" role="alert">{form.error}</p>
		{/if}
		{#if form && 'added' in form}
			<p role="status">{t('subs.added')}</p>
		{/if}

		<button type="submit">{t('subs.add')}</button>
	</form>
</section>

<section>
	{#if data.subscriptions.length === 0}
		<p class="muted">{t('subs.empty')}</p>
	{:else}
		<ul class="subs" aria-live="polite">
			{#each data.subscriptions as s (s.id)}
				<li class="card sub" data-testid="subscription">
					<div class="sub-main">
						<span class="badge">{t(typeKey(s.type))}</span>
						<strong>{describe(s.type, s.query)}</strong>
						<span class="status status-{s.backfillStatus}" data-testid="backfill-status">
							{t(statusKey(s.backfillStatus))}
						</span>
						{#if s.sharedWith > 1}
							<span class="muted">{t('subs.shared', { n: s.sharedWith - 1 })}</span>
						{/if}
					</div>
					<div class="sub-actions">
						<form method="POST" action="?/weight" use:enhance>
							<input type="hidden" name="id" value={s.id} />
							<label class="visually-hidden" for="w-{s.id}">{t('subs.weight')}</label>
							<select
								id="w-{s.id}"
								name="weight"
								onchange={(e) => e.currentTarget.form?.requestSubmit()}
							>
								{#each WEIGHTS as w (w)}
									<option value={w} selected={String(s.weight) === w}>{t(weightKey(w))}</option>
								{/each}
							</select>
							<noscript><button type="submit" class="secondary">OK</button></noscript>
						</form>
						<form
							method="POST"
							action="?/remove"
							use:enhance={({ cancel }) => {
								if (!confirm(t('subs.remove.confirm', { query: s.query }))) cancel();
							}}
						>
							<input type="hidden" name="id" value={s.id} />
							<button type="submit" class="secondary">{t('subs.remove')}</button>
						</form>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.add-form {
		display: grid;
		gap: 0.9rem;
	}

	.kinds {
		border: 0;
		padding: 0;
		margin: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 1.25rem;
	}

	.kinds legend {
		font-weight: 600;
		margin-bottom: 0.25rem;
	}

	.kind {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-weight: 400;
		margin: 0;
	}

	.kind input {
		width: auto;
	}

	.subs {
		list-style: none;
		padding: 0;
		display: grid;
		gap: 0.75rem;
	}

	.sub {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.sub-main {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.sub-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.sub-actions form {
		margin: 0;
	}

	.sub-actions select {
		width: auto;
	}

	.badge {
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--color-muted);
	}

	.status {
		font-size: 0.9rem;
	}

	.status-pending,
	.status-running {
		color: var(--color-accent);
	}

	.status-failed {
		color: #b42318;
	}
</style>
