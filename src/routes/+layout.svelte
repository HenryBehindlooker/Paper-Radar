<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import { t } from '$lib/i18n';

	let { data, children } = $props();

	const current = (path: string) =>
		path === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(path);
</script>

<a class="skip" href="#inhalt">Zum Inhalt springen</a>

<header class="site-header">
	<a class="brand" href={resolve('/')}>{t('app.name')}</a>
	<nav aria-label="Hauptnavigation">
		{#if data.user}
			<a href={resolve('/')} aria-current={current('/') ? 'page' : undefined}>{t('nav.feed')}</a>
			<a href={resolve('/suche')} aria-current={current('/suche') ? 'page' : undefined}
				>{t('nav.search')}</a
			>
			<a href={resolve('/merkliste')} aria-current={current('/merkliste') ? 'page' : undefined}
				>{t('nav.saved')}</a
			>
			<a href={resolve('/abos')} aria-current={current('/abos') ? 'page' : undefined}
				>{t('nav.subscriptions')}</a
			>
			<a href={resolve('/konto')} aria-current={current('/konto') ? 'page' : undefined}
				>{t('nav.account')}</a
			>
			<form method="POST" action="/logout">
				<input type="hidden" name="redirectTo" value="/" />
				<button type="submit" class="link">{t('nav.logout')}</button>
			</form>
		{:else}
			<a href={resolve('/ueber')}>{t('nav.about')}</a>
			<a href={resolve('/login')}>{t('nav.login')}</a>
		{/if}
	</nav>
</header>

<main id="inhalt">
	{@render children()}
</main>

<footer class="site-footer">
	<p lang="en" data-testid="arxiv-attribution">
		Thank you to arXiv for use of its open access interoperability.
	</p>
	<p>{t('footer.data')}</p>
	<p class="footer-links">
		<a href={resolve('/ueber')}>{t('footer.about')}</a>
		<a href="https://github.com/HenryBehindlooker/Paper-Radar">{t('footer.source')}</a>
		<span>{t('footer.license')}</span>
		<ThemeToggle />
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

	.skip {
		position: absolute;
		left: -999px;
	}

	.skip:focus {
		left: 1rem;
		top: 1rem;
		background: var(--color-bg);
		padding: 0.5rem;
		z-index: 10;
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
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.9rem;
	}

	nav a[aria-current='page'] {
		font-weight: 700;
		text-decoration-thickness: 2px;
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
		margin-top: 2rem;
	}

	.footer-links {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 1rem;
	}
</style>
