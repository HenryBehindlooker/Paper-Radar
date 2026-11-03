import nodemailer, { type Transporter } from 'nodemailer';
import { APP_NAME } from './config';

/**
 * E-Mail-Versand über SMTP (nodemailer). In der Entwicklung fängt Mailpit
 * alle Mails ab (siehe docker-compose.dev.yml). Mails enthalten weder
 * Tracking-Pixel noch umgeschriebene Links.
 */

export interface SmtpConfig {
	host: string;
	port: number;
	secure: boolean;
	user?: string;
	password?: string;
	from: string;
}

export function loadSmtpConfig(env: Record<string, string | undefined>): SmtpConfig {
	const host = env.SMTP_HOST?.trim() || 'localhost';
	const port = Number(env.SMTP_PORT ?? 1025);
	const user = env.SMTP_USER?.trim();
	const password = env.SMTP_PASSWORD;
	return {
		host,
		port: Number.isFinite(port) ? port : 1025,
		secure: env.SMTP_SECURE === 'true',
		...(user ? { user } : {}),
		...(user && password ? { password } : {}),
		from: env.MAIL_FROM?.trim() || `${APP_NAME} <noreply@localhost>`
	};
}

export function createTransport(config: SmtpConfig): Transporter {
	return nodemailer.createTransport({
		host: config.host,
		port: config.port,
		secure: config.secure,
		...(config.user ? { auth: { user: config.user, pass: config.password ?? '' } } : {})
	});
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

export interface MagicLinkMail {
	subject: string;
	text: string;
	html: string;
}

/** Inhalt der Anmelde-Mail (Deutsch, ohne Tracking). */
export function magicLinkMail(url: string, expires: Date, now: Date = new Date()): MagicLinkMail {
	const host = new URL(url).host;
	const minutes = Math.max(1, Math.round((expires.getTime() - now.getTime()) / 60_000));
	const subject = `Dein Anmeldelink für ${APP_NAME}`;
	const text = [
		'Hallo,',
		'',
		`mit diesem Link meldest du dich bei ${APP_NAME} (${host}) an:`,
		'',
		url,
		'',
		`Der Link ist ${minutes} Minuten gültig und funktioniert nur einmal.`,
		'Wenn du keine Anmeldung angefordert hast, kannst du diese Mail ignorieren.',
		'',
		`– ${APP_NAME}`
	].join('\n');
	const safeUrl = escapeHtml(url);
	const html = `<!doctype html>
<html lang="de"><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1a1c20">
<p>Hallo,</p>
<p>mit diesem Link meldest du dich bei ${APP_NAME} (${escapeHtml(host)}) an:</p>
<p><a href="${safeUrl}" style="display:inline-block;padding:.6em 1.2em;background:#2563eb;color:#fff;border-radius:.4em;text-decoration:none">Jetzt anmelden</a></p>
<p style="font-size:.9em;color:#5b6270">Oder kopiere diese Adresse in deinen Browser:<br>${safeUrl}</p>
<p style="font-size:.9em;color:#5b6270">Der Link ist ${minutes} Minuten gültig und funktioniert nur einmal.
Wenn du keine Anmeldung angefordert hast, kannst du diese Mail ignorieren.</p>
</body></html>`;
	return { subject, text, html };
}

/**
 * Einfache Drosselung im Speicher (eine App-Instanz): begrenzt Anmelde-Mails
 * pro Adresse und insgesamt, damit das Formular nicht zum Mail-Versand missbraucht wird.
 */
export class SendThrottle {
	readonly #perKey = new Map<string, number[]>();
	#global: number[] = [];

	constructor(
		private readonly perKeyLimit: number,
		private readonly perKeyWindowMs: number,
		private readonly globalLimit: number,
		private readonly globalWindowMs: number
	) {}

	/** `true`, wenn gesendet werden darf (und zählt den Versand). */
	take(key: string, now: number = Date.now()): boolean {
		const recent = (this.#perKey.get(key) ?? []).filter((t) => now - t < this.perKeyWindowMs);
		this.#global = this.#global.filter((t) => now - t < this.globalWindowMs);
		if (recent.length >= this.perKeyLimit || this.#global.length >= this.globalLimit) {
			this.#perKey.set(key, recent);
			return false;
		}
		recent.push(now);
		this.#perKey.set(key, recent);
		this.#global.push(now);
		if (this.#perKey.size > 10_000) this.#prune(now);
		return true;
	}

	#prune(now: number): void {
		for (const [key, times] of this.#perKey) {
			if (times.every((t) => now - t >= this.perKeyWindowMs)) this.#perKey.delete(key);
		}
	}
}
