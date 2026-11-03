// See https://svelte.dev/docs/kit/types#app.d.ts
import type { DefaultSession } from '@auth/sveltekit';

declare module '@auth/core/types' {
	interface Session {
		user: { id: string; email: string } & Omit<DefaultSession['user'], 'id' | 'email'>;
	}
}

declare global {
	namespace App {
		// interface Error {}
		// interface Locals {} – auth() kommt aus @auth/sveltekit
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
