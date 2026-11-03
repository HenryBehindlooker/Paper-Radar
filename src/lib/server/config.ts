/**
 * Serverseitige Konfiguration aus Umgebungsvariablen (`.env`, siehe `.env.example`).
 * Wird sowohl von der SvelteKit-App als auch vom Worker-Prozess genutzt,
 * daher direkt über `process.env` statt `$env/dynamic/private`.
 */

export const APP_NAME = 'Paper-Radar';
export const APP_VERSION = '0.1.0';
export const REPO_URL = 'https://github.com/HenryBehindlooker/Paper-Radar';

export interface SourcesConfig {
	/** Kontaktadresse für User-Agent und Crossref-`mailto` (optional, empfohlen). */
	contactEmail?: string;
	/** OpenAlex-API-Key; ohne Key bleibt die OpenAlex-Anreicherung deaktiviert. */
	openalexApiKey?: string;
}

function optional(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

export function loadSourcesConfig(env: NodeJS.ProcessEnv = process.env): SourcesConfig {
	const contactEmail = optional(env.CONTACT_EMAIL);
	const openalexApiKey = optional(env.OPENALEX_API_KEY);
	return {
		...(contactEmail ? { contactEmail } : {}),
		...(openalexApiKey ? { openalexApiKey } : {})
	};
}

/** Eigener User-Agent mit Repo-URL (und Kontaktadresse, falls konfiguriert). */
export function userAgent(contactEmail?: string): string {
	const contact = contactEmail ? `; mailto:${contactEmail}` : '';
	return `${APP_NAME}/${APP_VERSION} (+${REPO_URL}${contact})`;
}
