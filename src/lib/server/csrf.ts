/**
 * CSRF-Schutz für Formular-Requests – entspricht der Prüfung von SvelteKit, die dafür in
 * `svelte.config.js` abgeschaltet ist (`trustedOrigins: ['*']`). Grund ist genau eine
 * Ausnahme: Ein-Klick-Abmeldung nach RFC 8058 (`List-Unsubscribe-Post`). Mail-Anbieter
 * senden diesen POST von ihren Servern ohne passenden Origin; seine einzige Wirkung ist das
 * Abmelden der Person, deren signiertes Token in der URL steht.
 */

const FORM_TYPES = [
	'application/x-www-form-urlencoded',
	'multipart/form-data',
	'text/plain',
	'application/x-sveltekit-formdata'
];
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Pfade, die Cross-Site-Formular-POSTs annehmen dürfen. */
export const CSRF_EXEMPT: readonly RegExp[] = [/^\/abmelden\/[A-Za-z0-9_.%-]+$/];

export function isFormContentType(contentType: string | null): boolean {
	const type = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
	return FORM_TYPES.includes(type);
}

export function isForbiddenCrossSiteRequest(
	request: { method: string; headers: Headers },
	url: URL,
	exempt: readonly RegExp[] = CSRF_EXEMPT
): boolean {
	if (!UNSAFE_METHODS.has(request.method.toUpperCase())) return false;
	if (!isFormContentType(request.headers.get('content-type'))) return false;
	if (request.headers.get('origin') === url.origin) return false;
	return !exempt.some((re) => re.test(url.pathname));
}
