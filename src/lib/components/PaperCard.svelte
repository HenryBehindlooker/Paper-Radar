<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { t } from '$lib/i18n';
	import { formatDate, paragraphs, sourceLabel } from '$lib/papers/format';
	import { explainReasons, type MatchReason } from '$lib/ranking/reasons';

	interface Card {
		paperId: number;
		title: string;
		authors: string[];
		authorCount: number;
		publishedAt: Date | string;
		journal: string | null;
		abstract: string | null;
		sources: string[];
		landingUrl: string;
		reasons: MatchReason[];
		seen: boolean;
		saved: boolean;
		hidden: boolean;
		citedByCount?: number | null;
	}

	let { card, headingLevel = 2 }: { card: Card; headingLevel?: 1 | 2 | 3 } = $props();

	const back = $derived(page.url.pathname + page.url.search);
	const actions = $derived([
		{ field: 'seen', active: card.seen, on: t('card.markSeen'), off: t('card.markUnseen') },
		{ field: 'saved', active: card.saved, on: t('card.save'), off: t('card.unsave') },
		{ field: 'hidden', active: card.hidden, on: t('card.hide'), off: t('card.unhide') }
	]);
</script>

<article class="card paper" class:seen={card.seen} data-testid="paper-card">
	<svelte:element this={`h${headingLevel}`} class="title">
		<a href={resolve('/paper/[id]', { id: String(card.paperId) })}>{card.title}</a>
	</svelte:element>
	<p class="meta">
		{#if card.authors.length > 0}
			<span>
				{card.authors.join(', ')}{card.authorCount > card.authors.length
					? ` ${t('feed.moreAuthors')}`
					: ''}
			</span>
		{/if}
		<span>{formatDate(card.publishedAt)}</span>
		{#if card.journal}<span>{card.journal}</span>{/if}
		{#if card.citedByCount !== null && card.citedByCount !== undefined}
			<span data-testid="citations">{t('card.citations', { n: card.citedByCount })}</span>
		{/if}
		<span class="sources">
			{#each card.sources as source (source)}
				<span class="badge">{sourceLabel(source)}</span>
			{/each}
		</span>
	</p>

	{#if card.abstract}
		<details class="abstract">
			<summary>{t('card.abstract')}</summary>
			{#each paragraphs(card.abstract) as p, i (i)}
				<p>{p}</p>
			{/each}
		</details>
	{/if}

	{#if card.reasons.length > 0}
		<details class="why">
			<summary>{t('feed.why')}</summary>
			<ul>
				{#each explainReasons(card.reasons) as reason (reason)}
					<li>{reason}</li>
				{/each}
			</ul>
		</details>
	{/if}

	<div class="actions">
		{#each actions as a (a.field)}
			<form method="POST" action={`/paper/${card.paperId}?/state`} use:enhance>
				<input type="hidden" name="field" value={a.field} />
				<input type="hidden" name="value" value={String(!a.active)} />
				<input type="hidden" name="redirectTo" value={back} />
				<button type="submit" class="secondary small" aria-pressed={a.active}>
					{a.active ? a.off : a.on}
				</button>
			</form>
		{/each}
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- externer Link zur Quelle -->
		<a class="external" href={card.landingUrl} target="_blank" rel="noopener noreferrer">
			{t('card.open')} ↗
		</a>
	</div>
</article>

<style>
	.paper {
		display: grid;
		gap: 0.4rem;
	}

	.paper.seen .title a {
		color: var(--color-muted);
	}

	.title {
		font-size: 1.05rem;
		line-height: 1.35;
		margin: 0;
		overflow-wrap: anywhere;
	}

	.title a {
		color: var(--color-text);
		text-decoration: none;
	}

	.title a:hover,
	.title a:focus-visible {
		text-decoration: underline;
	}

	.meta {
		margin: 0;
		color: var(--color-muted);
		font-size: 0.875rem;
		display: flex;
		flex-wrap: wrap;
		gap: 0.15rem 0.6rem;
	}

	.badge {
		display: inline-block;
		padding: 0 0.4rem;
		border: 1px solid var(--color-border);
		border-radius: 999px;
		font-size: 0.75rem;
		margin-right: 0.25rem;
	}

	details {
		font-size: 0.925rem;
	}

	summary {
		cursor: pointer;
		color: var(--color-accent);
	}

	.abstract p {
		margin: 0.5rem 0 0;
		overflow-wrap: anywhere;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem;
		margin-top: 0.25rem;
	}

	.actions form {
		margin: 0;
	}

	.external {
		margin-left: auto;
		font-size: 0.9rem;
	}
</style>
