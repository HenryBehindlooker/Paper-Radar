import { redirect } from '@sveltejs/kit';
import { signIn } from '$lib/server/auth';
import { safeRedirectPath } from '$lib/redirect';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const redirectTo = safeRedirectPath(url.searchParams.get('redirectTo'));
	const session = await locals.auth();
	if (session?.user) redirect(303, redirectTo);
	return { redirectTo };
};

export const actions: Actions = { default: signIn };
