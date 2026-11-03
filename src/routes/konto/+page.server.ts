import { error, fail, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/app';
import { deleteAccount } from '$lib/server/subscriptions';
import { t } from '$lib/i18n';
import type { Actions, PageServerLoad } from './$types';

/** Mögliche Namen des Auth.js-Session-Cookies (mit/ohne HTTPS-Präfix). */
const SESSION_COOKIES = ['authjs.session-token', '__Secure-authjs.session-token'];

export const load: PageServerLoad = async ({ locals }) => {
	const session = await locals.auth();
	if (!session?.user) error(401, 'Nicht angemeldet');
	return { email: session.user.email };
};

export const actions: Actions = {
	delete: async ({ locals, request, cookies }) => {
		const session = await locals.auth();
		if (!session?.user?.id) error(401, 'Nicht angemeldet');
		const form = await request.formData();
		const confirmation = String(form.get('confirm') ?? '')
			.trim()
			.toLowerCase();
		if (confirmation !== session.user.email.toLowerCase()) {
			return fail(400, { error: t('account.delete.mismatch') });
		}
		await deleteAccount(getDb(), session.user.id);
		for (const name of SESSION_COOKIES) cookies.delete(name, { path: '/' });
		redirect(303, '/?konto=geloescht');
	}
};
