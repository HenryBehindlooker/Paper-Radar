/**
 * Erzeugung von RSS 2.0, Atom 1.0 und OPML 2.0 als reine Funktionen.
 * Alle Texte werden XML-maskiert; Steuerzeichen, die in XML 1.0 verboten sind, entfernt.
 */

export interface FeedEntry {
	id: string;
	title: string;
	link: string;
	/** Reiner Text (wird maskiert). */
	summary: string;
	authors: string[];
	published: Date;
	updated: Date;
	categories: string[];
}

export interface FeedMeta {
	title: string;
	description: string;
	/** URL der Web-Ansicht. */
	homeUrl: string;
	/** URL dieses Feeds (rel="self"). */
	selfUrl: string;
	updated: Date;
	generator: string;
}

// XML 1.0 erlaubt nur Tab, LF, CR und Zeichen ab U+0020 (ohne Surrogat-Lücken, U+FFFE/FFFF).
// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function escapeXml(value: string): string {
	return value
		.replace(INVALID_XML, '')
		.replace(LONE_SURROGATE, '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

const RFC822_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const RFC822_MONTHS = [
	'Jan',
	'Feb',
	'Mar',
	'Apr',
	'May',
	'Jun',
	'Jul',
	'Aug',
	'Sep',
	'Oct',
	'Nov',
	'Dec'
];

/** RFC 822/1123-Datum in GMT, z. B. `Tue, 03 Nov 2026 06:00:00 GMT` (RSS). */
export function rfc822(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${RFC822_DAYS[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${RFC822_MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} GMT`;
}

export function buildRss(meta: FeedMeta, entries: readonly FeedEntry[]): string {
	const items = entries
		.map((e) => {
			const cats = e.categories.map((c) => `      <category>${escapeXml(c)}</category>`).join('\n');
			const creator = e.authors.length
				? `      <dc:creator>${escapeXml(e.authors.join(', '))}</dc:creator>\n`
				: '';
			return `    <item>
      <title>${escapeXml(e.title)}</title>
      <link>${escapeXml(e.link)}</link>
      <guid isPermaLink="false">${escapeXml(e.id)}</guid>
      <pubDate>${rfc822(e.published)}</pubDate>
${creator}      <description>${escapeXml(e.summary)}</description>
${cats ? `${cats}\n` : ''}    </item>`;
		})
		.join('\n');
	return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${escapeXml(meta.title)}</title>
    <link>${escapeXml(meta.homeUrl)}</link>
    <description>${escapeXml(meta.description)}</description>
    <language>de</language>
    <generator>${escapeXml(meta.generator)}</generator>
    <lastBuildDate>${rfc822(meta.updated)}</lastBuildDate>
    <atom:link href="${escapeXml(meta.selfUrl)}" rel="self" type="application/rss+xml"/>
${items ? `${items}\n` : ''}  </channel>
</rss>
`;
}

export function buildAtom(meta: FeedMeta, entries: readonly FeedEntry[]): string {
	const items = entries
		.map((e) => {
			const authors = (e.authors.length ? e.authors : ['Unbekannt'])
				.map((a) => `    <author><name>${escapeXml(a)}</name></author>`)
				.join('\n');
			const cats = e.categories.map((c) => `    <category term="${escapeXml(c)}"/>`).join('\n');
			return `  <entry>
    <id>${escapeXml(e.id)}</id>
    <title>${escapeXml(e.title)}</title>
    <link rel="alternate" href="${escapeXml(e.link)}"/>
    <published>${e.published.toISOString()}</published>
    <updated>${e.updated.toISOString()}</updated>
${authors}
    <summary type="text">${escapeXml(e.summary)}</summary>
${cats ? `${cats}\n` : ''}  </entry>`;
		})
		.join('\n');
	return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="de">
  <id>${escapeXml(meta.selfUrl)}</id>
  <title>${escapeXml(meta.title)}</title>
  <subtitle>${escapeXml(meta.description)}</subtitle>
  <updated>${meta.updated.toISOString()}</updated>
  <link rel="self" type="application/atom+xml" href="${escapeXml(meta.selfUrl)}"/>
  <link rel="alternate" type="text/html" href="${escapeXml(meta.homeUrl)}"/>
  <generator>${escapeXml(meta.generator)}</generator>
${items ? `${items}\n` : ''}</feed>
`;
}

export interface OpmlOutline {
	title: string;
	xmlUrl: string;
	htmlUrl: string;
}

export function buildOpml(title: string, created: Date, outlines: readonly OpmlOutline[]): string {
	const body = outlines
		.map(
			(o) =>
				`      <outline type="rss" text="${escapeXml(o.title)}" title="${escapeXml(o.title)}" xmlUrl="${escapeXml(o.xmlUrl)}" htmlUrl="${escapeXml(o.htmlUrl)}"/>`
		)
		.join('\n');
	return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>${escapeXml(title)}</title>
    <dateCreated>${rfc822(created)}</dateCreated>
  </head>
  <body>
    <outline text="${escapeXml(title)}" title="${escapeXml(title)}">
${body ? `${body}\n` : ''}    </outline>
  </body>
</opml>
`;
}
