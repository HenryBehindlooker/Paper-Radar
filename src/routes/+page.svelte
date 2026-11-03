<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import Pager from '$lib/components/Pager.svelte';
	import PaperCard from '$lib/components/PaperCard.svelte';
	import { t, type MessageKey } from '$lib/i18n';

	let { data } = $props();

	const FILTERS = ['alle', 'ungelesen', 'ausgeblendet'] as const;
	const SORTS = ['relevanz', 'zitiert'] as const;
	/** Feste Werte (keine Nutzereingabe), daher ohne URL-Kodierung. */
	function href(filter: string, sort: string): string {
		const parts = [
			filter !== 'alle' ? `filter=${filter}` : '',
			sort !== 'relevanz' ? `sortierung=${sort}` : ''
		].filter(Boolean);
		return parts.length ? `/?${parts.join('&')}` : '/';
	}
</script>

<svelte:head>
	<title>{data.feed ? t('feed.title') : t('app.name')}</title>
</svelte:head>

{#if page.url.searchParams.get('konto') === 'geloescht'}
	<p class="notice" role="status">{t('home.accountDeleted')}</p>
{/if}

{#if data.user && data.feed}
	<h1>{t('feed.title')}</h1>
	<nav class="filters" aria-label={t('feed.filter.label')}>
		{#each FILTERS as f (f)}
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- Startseite mit Filter-Parameter -->
			<a href={href(f, data.sort)} aria-current={data.filter === f ? 'page' : undefined}
				>{t(`feed.filter.${f}` as MessageKey)}</a
			>
		{/each}
	</nav>
	<nav class="filters sort" aria-label={t('feed.sort.label')}>
		{#each SORTS as so (so)}
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- Startseite mit Sortier-Parameter -->
			<a href={href(data.filter, so)} aria-current={data.sort === so ? 'page' : undefined}
				>{t(`feed.sort.${so}` as MessageKey)}</a
			>
		{/each}
	</nav>
	{#if data.feed.items.length === 0}
		{#if data.filter === 'alle' && data.feed.page === 1}
			<p class="muted">{t('feed.empty')}</p>
			<p><a href={resolve('/abos')}>{t('home.toSubscriptions')}</a></p>
		{:else}
			<p class="muted">{t('feed.emptyFilter')}</p>
		{/if}
	{:else}
		<ol class="list">
			{#each data.feed.items as card (card.paperId)}
				<li><PaperCard {card} /></li>
			{/each}
		</ol>
		<Pager page={data.feed.page} hasMore={data.feed.hasMore} />
	{/if}
{:else}
	<h1>{t('app.name')}</h1>
	<p>{t('app.tagline')}</p>
	<p><a href={resolve('/login')}>{t('home.cta')}</a></p>
{/if}

<style>
	.filters {
		display: flex;
		gap: 1rem;
		margin-bottom: 1rem;
	}

	.sort {
		font-size: 0.9rem;
		margin-top: -0.5rem;
	}

	.filters a[aria-current='page'] {
		font-weight: 700;
	}
</style>
