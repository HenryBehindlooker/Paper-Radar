<script lang="ts">
	import { t } from '$lib/i18n';

	let { data } = $props();
</script>

<svelte:head>
	<title>{t('login.title')} – {t('app.name')}</title>
</svelte:head>

<h1>{t('login.title')}</h1>
<p>{t('login.intro')}</p>

<form method="POST" class="card login">
	<input type="hidden" name="providerId" value="nodemailer" />
	<input type="hidden" name="redirectTo" value={data.redirectTo} />
	<label for="email">{t('login.email')}</label>
	<input id="email" name="email" type="email" autocomplete="email" required maxlength="320" />
	<button type="submit">{t('login.submit')}</button>
</form>

<p class="muted">{t('login.privacy')}</p>

<style>
	.login {
		display: grid;
		gap: 0.75rem;
		max-width: 28rem;
	}
</style>
