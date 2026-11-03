<script lang="ts">
	import { resolve } from '$app/paths';
	import { t } from '$lib/i18n';
</script>

<svelte:head>
	<title>{t('login.sent.title')} – {t('app.name')}</title>
</svelte:head>

<h1>{t('login.sent.title')}</h1>
<p>{t('login.sent.text')}</p>
<p class="muted">{t('login.sent.spam')}</p>
<p><a href={resolve('/login')}>{t('login.again')}</a></p>
