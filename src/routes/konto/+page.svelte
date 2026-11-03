<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { t } from '$lib/i18n';

	let { data, form } = $props();
</script>

<svelte:head>
	<title>{t('account.title')} – {t('app.name')}</title>
</svelte:head>

<h1>{t('account.title')}</h1>
<p>{t('account.email')} <strong data-testid="account-email">{data.email}</strong></p>
<p class="muted">{t('account.stored')}</p>

<section class="card" aria-labelledby="feed-title">
	<h2 id="feed-title">{t('account.feed.title')}</h2>
	<p>{t('account.feed.intro')}</p>
	{#if data.feed}
		{#if form && 'feed' in form && form.feed === 'rotated'}
			<p role="status" class="notice">{t('account.feed.rotated')}</p>
		{/if}
		<label for="rss">{t('account.feed.rss')}</label>
		<input id="rss" readonly value={data.feed.rss} onfocus={(e) => e.currentTarget.select()} />
		<label for="atom">{t('account.feed.atom')}</label>
		<input id="atom" readonly value={data.feed.atom} onfocus={(e) => e.currentTarget.select()} />
		{#if data.feed.perSubscription.length > 0}
			<details>
				<summary>{t('account.feed.perSubscription')}</summary>
				<ul class="per-sub">
					{#each data.feed.perSubscription as s (s.id)}
						<li><span>{s.label}</span> <code>{s.rss}</code></li>
					{/each}
				</ul>
			</details>
		{/if}
		<p>
			<a href={resolve('/konto/opml')} download>{t('account.feed.opml')}</a>
		</p>
		<div class="row">
			<form
				method="POST"
				action="?/feedRotate"
				use:enhance={({ cancel }) => {
					if (!confirm(t('account.feed.rotate.confirm'))) cancel();
				}}
			>
				<button type="submit" class="secondary">{t('account.feed.rotate')}</button>
			</form>
			<form method="POST" action="?/feedDisable" use:enhance>
				<button type="submit" class="secondary">{t('account.feed.disable')}</button>
			</form>
		</div>
	{:else}
		<form method="POST" action="?/feedEnable" use:enhance>
			<button type="submit">{t('account.feed.enable')}</button>
		</form>
	{/if}
</section>

<section class="card" aria-labelledby="digest-title">
	<h2 id="digest-title">{t('account.digest.title')}</h2>
	<p>{t('account.digest.intro')}</p>
	<p data-testid="digest-state">
		{data.weeklyDigest ? t('account.digest.enabled') : t('account.digest.disabled')}
	</p>
	<form method="POST" action="?/digest" use:enhance>
		<input type="hidden" name="enabled" value={String(!data.weeklyDigest)} />
		<button type="submit" class={data.weeklyDigest ? 'secondary' : ''}>
			{data.weeklyDigest ? t('account.digest.disable') : t('account.digest.enable')}
		</button>
	</form>
</section>

<section class="card danger-zone">
	<h2>{t('account.delete.title')}</h2>
	<p>{t('account.delete.text')}</p>
	<form method="POST" action="?/delete" class="delete-form">
		<label for="confirm">{t('account.delete.confirm')}</label>
		<input id="confirm" name="confirm" type="email" autocomplete="off" required />
		{#if form && 'error' in form && form.error}
			<p class="error" role="alert">{form.error}</p>
		{/if}
		<button type="submit" class="danger">{t('account.delete.submit')}</button>
	</form>
</section>

<style>
	section {
		margin-bottom: 1rem;
		display: grid;
		gap: 0.5rem;
	}

	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.row form {
		margin: 0;
	}

	.per-sub {
		padding-left: 1.2rem;
		font-size: 0.85rem;
	}

	.per-sub code {
		overflow-wrap: anywhere;
	}

	.danger-zone {
		border-color: #b42318;
	}

	.delete-form {
		display: grid;
		gap: 0.75rem;
		max-width: 28rem;
	}
</style>
