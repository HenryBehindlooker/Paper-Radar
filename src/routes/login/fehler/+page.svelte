<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { t, type MessageKey } from '$lib/i18n';

	const known: Record<string, MessageKey> = {
		Verification: 'login.error.Verification',
		Configuration: 'login.error.Configuration'
	};
	const message = $derived(
		t(known[page.url.searchParams.get('error') ?? ''] ?? 'login.error.default')
	);
</script>

<svelte:head>
	<title>{t('login.error.title')} – {t('app.name')}</title>
</svelte:head>

<h1>{t('login.error.title')}</h1>
<p role="alert">{message}</p>
<p><a href={resolve('/login')}>{t('login.again')}</a></p>
