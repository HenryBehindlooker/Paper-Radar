<script lang="ts">
	import '../app.css';
	import { resolve } from '$app/paths';
	import { t } from '$lib/i18n';

	let { data, children } = $props();
</script>

<header class="site-header">
	<a class="brand" href={resolve('/')}>{t('app.name')}</a>
	<nav aria-label="Hauptnavigation">
		{#if data.user}
			<a href={resolve('/abos')}>{t('nav.subscriptions')}</a>
			<a href={resolve('/konto')}>{t('nav.account')}</a>
			<form method="POST" action="/logout">
				<input type="hidden" name="redirectTo" value="/" />
				<button type="submit" class="link">{t('nav.logout')}</button>
			</form>
		{:else}
			<a href={resolve('/login')}>{t('nav.login')}</a>
		{/if}
	</nav>
</header>

<main>
	{@render children()}
</main>

<footer class="site-footer">
	<p>
		{t('footer.license')}
		<a href="https://github.com/HenryBehindlooker/Paper-Radar">{t('footer.source')}</a>
	</p>
</footer>

<style>
	.site-header,
	main,
	.site-footer {
		max-width: var(--max-width);
		margin: 0 auto;
		padding: var(--space);
	}

	.site-header {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem 1rem;
	}

	nav {
		display: flex;
		align-items: center;
		gap: 1rem;
	}

	nav form {
		margin: 0;
	}

	.brand {
		font-weight: 700;
		font-size: 1.25rem;
		text-decoration: none;
		color: var(--color-text);
	}

	.site-footer {
		color: var(--color-muted);
		font-size: 0.875rem;
		border-top: 1px solid var(--color-border);
	}
</style>
