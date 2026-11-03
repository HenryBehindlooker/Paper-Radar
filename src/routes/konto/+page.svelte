<script lang="ts">
	import { t } from '$lib/i18n';

	let { data, form } = $props();
</script>

<svelte:head>
	<title>{t('account.title')} – {t('app.name')}</title>
</svelte:head>

<h1>{t('account.title')}</h1>
<p>{t('account.email')} <strong data-testid="account-email">{data.email}</strong></p>
<p class="muted">{t('account.stored')}</p>

<section class="card danger-zone">
	<h2>{t('account.delete.title')}</h2>
	<p>{t('account.delete.text')}</p>
	<form method="POST" action="?/delete" class="delete-form">
		<label for="confirm">{t('account.delete.confirm')}</label>
		<input id="confirm" name="confirm" type="email" autocomplete="off" required />
		{#if form?.error}
			<p class="error" role="alert">{form.error}</p>
		{/if}
		<button type="submit" class="danger">{t('account.delete.submit')}</button>
	</form>
</section>

<style>
	.danger-zone {
		border-color: #b42318;
	}

	.delete-form {
		display: grid;
		gap: 0.75rem;
		max-width: 28rem;
	}
</style>
