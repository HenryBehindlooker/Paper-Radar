<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { t } from '$lib/i18n';

	let { data } = $props();
</script>

<svelte:head>
	<title>{t('app.name')}</title>
</svelte:head>

{#if page.url.searchParams.get('konto') === 'geloescht'}
	<p class="notice" role="status">{t('home.accountDeleted')}</p>
{/if}

<h1>{t('app.name')}</h1>
<p>{t('app.tagline')}</p>

{#if data.user}
	<p><a href={resolve('/abos')}>{t('home.toSubscriptions')}</a></p>
{:else}
	<p><a href={resolve('/login')}>{t('home.cta')}</a></p>
{/if}
