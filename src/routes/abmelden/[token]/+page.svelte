<script lang="ts">
	import { resolve } from '$app/paths';
	import { t } from '$lib/i18n';

	let { data, form } = $props();
</script>

<svelte:head>
	<title>{t('unsubscribe.title')} – {t('app.name')}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<h1>{t('unsubscribe.title')}</h1>
{#if form?.done}
	<p role="status" data-testid="unsubscribed">{t('unsubscribe.done')}</p>
	<p><a href={resolve('/konto')}>{t('unsubscribe.settings')}</a></p>
{:else if form && !form.done}
	<p role="alert">{t('unsubscribe.invalid')}</p>
{:else if data.valid}
	<p>{t('unsubscribe.confirm')}</p>
	<form method="POST">
		<button type="submit">{t('unsubscribe.submit')}</button>
	</form>
{:else}
	<p role="alert">{t('unsubscribe.invalid')}</p>
{/if}
