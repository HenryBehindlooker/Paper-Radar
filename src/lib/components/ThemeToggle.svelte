<script lang="ts">
	import { onMount } from 'svelte';
	import { t, type MessageKey } from '$lib/i18n';

	type Theme = 'auto' | 'light' | 'dark';
	const ORDER: Theme[] = ['auto', 'light', 'dark'];
	let theme = $state<Theme>('auto');

	onMount(() => {
		try {
			const stored = localStorage.getItem('theme');
			if (stored === 'light' || stored === 'dark') theme = stored;
		} catch {
			// Speicher nicht verfügbar → automatisch
		}
	});

	function cycle() {
		theme = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length] as Theme;
		const root = document.documentElement;
		if (theme === 'auto') delete root.dataset.theme;
		else root.dataset.theme = theme;
		try {
			if (theme === 'auto') localStorage.removeItem('theme');
			else localStorage.setItem('theme', theme);
		} catch {
			// ignorieren
		}
	}
</script>

<button
	type="button"
	class="link theme"
	onclick={cycle}
	aria-label={t('theme.label')}
	data-testid="theme-toggle"
>
	{t('theme.label')}: {t(`theme.${theme}` as MessageKey)}
</button>

<style>
	.theme {
		font-size: 0.875rem;
	}
</style>
