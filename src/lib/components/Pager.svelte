<script lang="ts">
	import { page as current } from '$app/state';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import { t } from '$lib/i18n';

	let { page, hasMore }: { page: number; hasMore: boolean } = $props();

	function hrefFor(n: number): string {
		const params = new SvelteURLSearchParams(current.url.searchParams);
		if (n <= 1) params.delete('seite');
		else params.set('seite', String(n));
		const qs = params.toString();
		return `${current.url.pathname}${qs ? `?${qs}` : ''}`;
	}
</script>

{#if page > 1 || hasMore}
	<nav class="pager" aria-label="Seiten">
		<!-- eslint-disable svelte/no-navigation-without-resolve -- gleiche Seite, nur Query-Parameter -->
		{#if page > 1}<a href={hrefFor(page - 1)} rel="prev">← {t('pager.prev')}</a>{/if}
		{#if hasMore}<a href={hrefFor(page + 1)} rel="next">{t('pager.next')} →</a>{/if}
		<!-- eslint-enable svelte/no-navigation-without-resolve -->
	</nav>
{/if}

<style>
	.pager {
		display: flex;
		justify-content: space-between;
		margin: 1rem 0;
	}
</style>
