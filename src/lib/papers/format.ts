/** Anzeige-Helfer (Client und Server). */

const SOURCE_LABELS: Record<string, string> = {
	arxiv: 'arXiv',
	europepmc: 'Europe PMC',
	crossref: 'Crossref',
	openalex: 'OpenAlex'
};

export function sourceLabel(source: string): string {
	return SOURCE_LABELS[source] ?? source;
}

const dateFormat = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeZone: 'UTC' });

export function formatDate(value: Date | string): string {
	return dateFormat.format(new Date(value));
}

/** Absätze eines Abstracts (durch Leerzeilen getrennt). */
export function paragraphs(text: string): string[] {
	return text
		.split(/\n\s*\n/)
		.map((p) => p.trim())
		.filter(Boolean);
}
