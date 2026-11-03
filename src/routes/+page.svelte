<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { explainReasons } from '$lib/ranking/reasons';
	import { t } from '$lib/i18n';

	let { data } = $props();

	const dateFormat = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeZone: 'UTC' });
</script>

<svelte:head>
	<title>{t('app.name')}</title>
</svelte:head>

{#if page.url.searchParams.get('konto') === 'geloescht'}
	<p class="notice" role="status">{t('home.accountDeleted')}</p>
{/if}

{#if data.user && data.feed}
	<h1>{t('feed.title')}</h1>
	{#if data.feed.length === 0}
		<p class="muted">{t('feed.empty')}</p>
		<p><a href={resolve('/abos')}>{t('home.toSubscriptions')}</a></p>
	{:else}
		<ol class="feed">
			{#each data.feed as item (item.paperId)}
				<li class="card item" data-testid="feed-item">
					<h2 class="title">
						<a href={item.landingUrl} rel="noopener noreferrer" target="_blank">{item.title}</a>
					</h2>
					<p class="meta">
						{item.authors.join(', ')}{item.authorCount > item.authors.length
							? ` ${t('feed.moreAuthors')}`
							: ''}
						· {dateFormat.format(new Date(item.publishedAt))}
						{#if item.journal}· {item.journal}{/if}
					</p>
					<details class="why">
						<summary>{t('feed.why')}</summary>
						<ul>
							{#each explainReasons(item.reasons) as reason (reason)}
								<li>{reason}</li>
							{/each}
						</ul>
						<p class="muted">{t('feed.score')}: {item.score.toFixed(3)}</p>
					</details>
				</li>
			{/each}
		</ol>
	{/if}
{:else}
	<h1>{t('app.name')}</h1>
	<p>{t('app.tagline')}</p>
	<p><a href={resolve('/login')}>{t('home.cta')}</a></p>
{/if}

<style>
	.feed {
		list-style: none;
		padding: 0;
		display: grid;
		gap: 0.75rem;
	}

	.title {
		font-size: 1.05rem;
		margin: 0 0 0.25rem;
		overflow-wrap: anywhere;
	}

	.title a {
		color: var(--color-text);
		text-decoration: none;
	}

	.title a:hover {
		text-decoration: underline;
	}

	.meta {
		margin: 0;
		color: var(--color-muted);
		font-size: 0.9rem;
	}

	.why {
		margin-top: 0.5rem;
		font-size: 0.9rem;
	}

	.why summary {
		cursor: pointer;
		color: var(--color-accent);
	}
</style>
