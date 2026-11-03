import { redirect } from '@sveltejs/kit';
import { signOut } from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = () => redirect(303, '/');

export const actions: Actions = { default: signOut };
