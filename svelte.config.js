import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter({ out: 'build' }),
		// Eingebaute Origin-Prüfung aus; sie wird in src/hooks.server.ts (src/lib/server/csrf.ts)
		// identisch nachgebildet – mit einer Ausnahme für die Ein-Klick-Abmeldung (RFC 8058).
		csrf: { trustedOrigins: ['*'] }
	}
};

export default config;
