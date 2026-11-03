import { env } from '$env/dynamic/private';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { SvelteKitAuth } from '@auth/sveltekit';
import Nodemailer from '@auth/sveltekit/providers/nodemailer';
import { getDb } from './app';
import { accounts, sessions, users, verificationTokens } from './db/schema';
import { createLogger } from './log';
import { createTransport, loadSmtpConfig, magicLinkMail, SendThrottle } from './mail';

const log = createLogger('auth');

/** Magic-Links sind eine Stunde gültig. */
export const MAGIC_LINK_MAX_AGE_S = 60 * 60;

/** Höchstens 3 Anmelde-Mails pro Adresse in 15 Minuten, 200 pro Stunde insgesamt. */
const throttle = new SendThrottle(3, 15 * 60_000, 200, 60 * 60_000);

const isHttps = () => (env.ORIGIN ?? '').startsWith('https://');

export const { handle, signIn, signOut } = SvelteKitAuth(async () => {
	const smtp = loadSmtpConfig(env);
	return {
		adapter: DrizzleAdapter(getDb(), {
			usersTable: users,
			accountsTable: accounts,
			sessionsTable: sessions,
			verificationTokensTable: verificationTokens
		}),
		// Datenbank-Sessions: das Cookie enthält nur ein zufälliges Token.
		session: { strategy: 'database', maxAge: 30 * 24 * 60 * 60, updateAge: 24 * 60 * 60 },
		// httpOnly + sameSite=lax sind Auth.js-Standard; „secure“ bei HTTPS erzwingen.
		useSecureCookies: isHttps(),
		trustHost: env.AUTH_TRUST_HOST === 'true',
		pages: {
			signIn: '/login',
			verifyRequest: '/login/mail-gesendet',
			error: '/login/fehler'
		},
		providers: [
			Nodemailer({
				server: {
					host: smtp.host,
					port: smtp.port,
					secure: smtp.secure,
					...(smtp.user ? { auth: { user: smtp.user, pass: smtp.password ?? '' } } : {})
				},
				from: smtp.from,
				maxAge: MAGIC_LINK_MAX_AGE_S,
				async sendVerificationRequest({ identifier, url, expires }) {
					// Bei Drosselung still nichts senden – die Antwortseite ist identisch,
					// damit sich nicht erkennen lässt, ob eine Adresse existiert.
					if (!throttle.take(identifier)) {
						log.warn('Anmelde-Mail gedrosselt');
						return;
					}
					const mail = magicLinkMail(url, expires);
					await createTransport(smtp).sendMail({
						to: identifier,
						from: smtp.from,
						subject: mail.subject,
						text: mail.text,
						html: mail.html
					});
				}
			})
		],
		callbacks: {
			session({ session, user }) {
				// Nur ID und E-Mail an die Oberfläche geben.
				return {
					expires: session.expires,
					user: { id: user.id, email: user.email }
				} as typeof session;
			}
		},
		logger: {
			error: (error) => {
				// Abgelaufene/benutzte Links sind erwartbar und kein Serverfehler.
				const type = (error as { type?: string }).type;
				if (type === 'Verification') log.info('Anmeldelink ungültig oder abgelaufen');
				else log.error('auth.js', { type, error: error.message });
			},
			warn: (code) => log.warn('auth.js', { code })
		}
	};
});
