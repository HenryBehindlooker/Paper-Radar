<script lang="ts">
	import { resolve } from '$app/paths';
	import PaperCard from '$lib/components/PaperCard.svelte';
	import { t } from '$lib/i18n';
	import { paperLinks } from '$lib/papers/links';
	import { formatDate, sourceLabel } from '$lib/papers/format';

	let { data } = $props();
	const p = $derived(data.paper);
	const links = $derived(paperLinks(p.ids, p.pdfUrl));
</script>

<svelte:head>
	<title>{p.title} – {t('app.name')}</title>
</svelte:head>

<p><a href={resolve('/')}>← {t('paper.back')}</a></p>

<PaperCard card={{ ...p, abstract: null }} headingLevel={1} />

<section class="details">
	{#if p.abstract}
		<h2>{t('card.abstract')}</h2>
		{#each p.abstract.split(/\n\s*\n/) as para, i (i)}
			<p class="abstract">{para}</p>
		{/each}
	{:else}
		<p class="muted">{t('card.noAbstract')}</p>
	{/if}

	<dl>
		<dt>{t('paper.authors')}</dt>
		<dd data-testid="all-authors">{p.authors.join(', ') || '–'}</dd>
		<dt>{t('paper.published')}</dt>
		<dd>{formatDate(p.publishedAt)}</dd>
		{#if p.journal}
			<dt>{t('paper.journal')}</dt>
			<dd>{p.journal}</dd>
		{/if}
		{#if p.categories.length > 0}
			<dt>{t('paper.categories')}</dt>
			<dd>{p.categories.join(', ')}</dd>
		{/if}
		<dt>{t('paper.sources')}</dt>
		<dd>{p.sources.map(sourceLabel).join(', ')}</dd>
		{#if p.citedByCount !== null}
			<dt>OpenAlex</dt>
			<dd>{t('card.citations', { n: p.citedByCount })}</dd>
		{/if}
	</dl>

	<h2>{t('paper.links')}</h2>
	<ul class="links" data-testid="paper-links">
		{#each links as link (link.url)}
			<li>
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- externe Links -->
				<a href={link.url} target="_blank" rel="noopener noreferrer nofollow">{link.label} ↗</a>
			</li>
		{/each}
	</ul>
	{#if p.pdfUrl}<p class="muted">{t('paper.pdfNote')}</p>{/if}

	<p>
		<a href={resolve('/paper/[id]/bibtex', { id: String(p.paperId) })} download
			>{t('paper.bibtex')}</a
		>
	</p>
</section>

<style>
	.details {
		margin-top: 1rem;
	}

	.abstract {
		overflow-wrap: anywhere;
	}

	dl {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 0.25rem 1rem;
	}

	dt {
		font-weight: 600;
	}

	dd {
		margin: 0;
		overflow-wrap: anywhere;
	}

	@media (max-width: 30rem) {
		dl {
			grid-template-columns: 1fr;
		}

		dd {
			margin-bottom: 0.5rem;
		}
	}

	.links {
		padding-left: 1.2rem;
	}
</style>
