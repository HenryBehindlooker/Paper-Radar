<script lang="ts">
	import { t } from '$lib/i18n';
</script>

<svelte:head>
	<title>{t('app.name')}</title>
</svelte:head>

<h1>{t('app.name')}</h1>
<p>{t('app.tagline')}</p>
<p class="muted">{t('home.comingSoon')}</p>

<style>
	.muted {
		color: var(--color-muted);
	}
</style>
