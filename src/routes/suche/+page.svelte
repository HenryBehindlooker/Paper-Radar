<script lang="ts">
	import Pager from '$lib/components/Pager.svelte';
	import PaperCard from '$lib/components/PaperCard.svelte';
	import { t } from '$lib/i18n';

	let { data } = $props();
</script>

<svelte:head>
	<title>{t('search.title')} – {t('app.name')}</title>
</svelte:head>

<h1>{t('search.title')}</h1>
<form method="GET" class="search" role="search">
	<label for="q">{t('search.label')}</label>
	<div class="row">
		<input id="q" name="q" type="search" value={data.q} maxlength="300" aria-describedby="q-help" />
		<button type="submit">{t('search.submit')}</button>
	</div>
	<p id="q-help" class="help">{t('search.help')}</p>
</form>

{#if data.results}
	{#if data.results.items.length === 0}
		<p class="muted">{t('search.empty', { q: data.q })}</p>
	{:else}
		<h2 class="visually-hidden">{t('search.results', { q: data.q })}</h2>
		<ol class="list">
			{#each data.results.items as card (card.paperId)}
				<li><PaperCard {card} headingLevel={3} /></li>
			{/each}
		</ol>
		<Pager page={data.results.page} hasMore={data.results.hasMore} />
	{/if}
{/if}

<style>
	.search {
		margin-bottom: 1rem;
	}

	.row {
		display: flex;
		gap: 0.5rem;
	}
</style>
