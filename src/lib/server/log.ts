/**
 * Minimaler strukturierter Logger (JSON-Zeilen auf stdout/stderr).
 * Loggt nie personenbezogene Daten; Aufrufer übergeben nur technische Felder.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
	debug(msg: string, data?: Record<string, unknown>): void;
	info(msg: string, data?: Record<string, unknown>): void;
	warn(msg: string, data?: Record<string, unknown>): void;
	error(msg: string, data?: Record<string, unknown>): void;
	child(scope: string): Logger;
}

function currentLevel(): LogLevel {
	const level = process.env.LOG_LEVEL;
	return level === 'debug' || level === 'info' || level === 'warn' || level === 'error'
		? level
		: 'info';
}

export function createLogger(scope: string): Logger {
	const write = (level: LogLevel, msg: string, data?: Record<string, unknown>) => {
		if (order[level] < order[currentLevel()]) return;
		const line = JSON.stringify({ time: new Date().toISOString(), level, scope, msg, ...data });
		if (level === 'error' || level === 'warn') console.error(line);
		else console.log(line);
	};
	return {
		debug: (msg, data) => write('debug', msg, data),
		info: (msg, data) => write('info', msg, data),
		warn: (msg, data) => write('warn', msg, data),
		error: (msg, data) => write('error', msg, data),
		child: (sub) => createLogger(`${scope}:${sub}`)
	};
}

/** Logger, der nichts ausgibt (für Tests). */
export const silentLogger: Logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	child: () => silentLogger
};
