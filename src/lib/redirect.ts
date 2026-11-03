/**
 * Nur relative, gleich-originige Pfade als Weiterleitungsziel zulassen
 * (verhindert offene Weiterleitungen über `?redirectTo=`).
 */
export function safeRedirectPath(value: string | null | undefined, fallback = '/abos'): string {
	if (!value) return fallback;
	if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback;
	if (/[\r\n]/.test(value)) return fallback;
	return value;
}
