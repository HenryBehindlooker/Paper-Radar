<script lang="ts">
	import '../app.css';
	import { resolve } from '$app/paths';
	import { t } from '$lib/i18n';

	let { children } = $props();
</script>

<header class="site-header">
	<a class="brand" href={resolve('/')}>{t('app.name')}</a>
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
