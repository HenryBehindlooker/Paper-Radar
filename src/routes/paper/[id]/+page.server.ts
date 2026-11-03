import { error, fail, redirect } from '@sveltejs/kit';
import { safeRedirectPath } from '$lib/redirect';
import { getDb } from '$lib/server/app';
import { paperDetail, parseStateField, setPaperState } from '$lib/server/papers-view';
import { requireUserId } from '$lib/server/session';
import type { Actions, PageServerLoad } from './$types';

function paperId(raw: string): number {
	const id = Number(raw);
	if (!Number.isSafeInteger(id) || id < 1) error(404, 'Paper nicht gefunden');
	return id;
}

export const load: PageServerLoad = async ({ locals, params }) => {
	const userId = await requireUserId(locals);
	const paper = await paperDetail(getDb(), userId, paperId(params.id));
	if (!paper) error(404, 'Paper nicht gefunden');
	return { paper };
};

export const actions: Actions = {
	/** gelesen / gemerkt / ausgeblendet setzen (von Karten überall in der App genutzt). */
	state: async ({ locals, params, request }) => {
		const userId = await requireUserId(locals);
		const form = await request.formData();
		const field = parseStateField(form.get('field'));
		if (!field) return fail(400, { error: 'Ungültige Aktion' });
		const value = form.get('value') === 'true';
		const ok = await setPaperState(getDb(), userId, paperId(params.id), field, value);
		if (!ok) error(404, 'Paper nicht gefunden');
		// Ohne JavaScript zurück zur Ausgangsseite; mit JavaScript aktualisiert enhance.
		if (request.headers.get('x-sveltekit-action') !== 'true') {
			redirect(303, safeRedirectPath(String(form.get('redirectTo') ?? ''), `/paper/${params.id}`));
		}
		return { field, value };
	}
};
