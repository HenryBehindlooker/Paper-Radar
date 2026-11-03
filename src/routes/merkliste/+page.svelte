<script lang="ts">
	import Pager from '$lib/components/Pager.svelte';
	import PaperCard from '$lib/components/PaperCard.svelte';
	import { resolve } from '$app/paths';
	import { t } from '$lib/i18n';

	let { data } = $props();
</script>

<svelte:head>
	<title>{t('saved.title')} – {t('app.name')}</title>
</svelte:head>

<h1>{t('saved.title')}</h1>
{#if data.saved.items.length === 0}
	<p class="muted">{t('saved.empty')}</p>
{:else}
	<p><a href={resolve('/merkliste/bibtex')} download>{t('saved.export')}</a></p>
	<ol class="list">
		{#each data.saved.items as card (card.paperId)}
			<li><PaperCard {card} /></li>
		{/each}
	</ol>
	<Pager page={data.saved.page} hasMore={data.saved.hasMore} />
{/if}
