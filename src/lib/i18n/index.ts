import { de, type MessageKey, type Messages } from './de';

export type { MessageKey, Messages };

export const locales = { de } satisfies Record<string, Messages>;
export type Locale = keyof typeof locales;
export const defaultLocale: Locale = 'de';

/**
 * Liefert den übersetzten Text für `key`. Platzhalter der Form `{name}` werden
 * durch `params.name` ersetzt; unbekannte Platzhalter bleiben stehen.
 */
export function t(
	key: MessageKey,
	params: Record<string, string | number> = {},
	locale: Locale = defaultLocale
): string {
	const template = locales[locale][key] ?? locales[defaultLocale][key];
	return template.replace(/\{(\w+)\}/g, (match, name: string) =>
		name in params ? String(params[name]) : match
	);
}
