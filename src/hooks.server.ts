import { json, redirect, type Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { handle as authentication } from '$lib/server/auth';
import { isForbiddenCrossSiteRequest } from '$lib/server/csrf';

/** Seiten und APIs, die eine Anmeldung erfordern. */
const PROTECTED_PAGES = ['/abos', '/konto', '/suche', '/merkliste', '/paper'];
const PROTECTED_API = ['/api/subscriptions'];

const matches = (path: string, prefixes: string[]) =>
	prefixes.some((p) => path === p || path.startsWith(`${p}/`));

const authorization: Handle = async ({ event, resolve }) => {
	const path = event.url.pathname;
	const api = matches(path, PROTECTED_API);
	if (api || matches(path, PROTECTED_PAGES)) {
		const session = await event.locals.auth();
		if (!session?.user?.id) {
			if (api) return json({ error: 'Nicht angemeldet' }, { status: 401 });
			redirect(303, `/login?redirectTo=${encodeURIComponent(path + event.url.search)}`);
		}
	}
	return resolve(event);
};

/** Datenschutz- und Sicherheits-Header; keine Drittanbieter, kein Tracking. */
const securityHeaders: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'same-origin');
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set(
		'Permissions-Policy',
		'camera=(), microphone=(), geolocation=(), interest-cohort=()'
	);
	return response;
};

/** CSRF-Schutz für Formular-POSTs (siehe src/lib/server/csrf.ts). */
const csrf: Handle = async ({ event, resolve }) => {
	if (isForbiddenCrossSiteRequest(event.request, event.url)) {
		const message = `Cross-site ${event.request.method} form submissions are forbidden`;
		return event.request.headers.get('accept') === 'application/json'
			? json({ message }, { status: 403 })
			: new Response(message, { status: 403 });
	}
	return resolve(event);
};

export const handle = sequence(csrf, authentication, authorization, securityHeaders);
