import { error } from '@sveltejs/kit';

/** ID der angemeldeten Person oder 401. */
export async function requireUserId(locals: App.Locals): Promise<string> {
	const session = await locals.auth();
	if (!session?.user?.id) error(401, 'Nicht angemeldet');
	return session.user.id;
}
