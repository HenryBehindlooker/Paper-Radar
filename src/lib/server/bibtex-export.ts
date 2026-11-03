import { toBibtexFile, type BibtexInput } from '../papers/bibtex';
import type { PaperCard } from './papers-view';

export function bibtexInputFromCard(card: PaperCard): BibtexInput {
	const url = card.ids.arxivId
		? `https://arxiv.org/abs/${card.ids.arxivId}`
		: card.ids.doi
			? `https://doi.org/${card.ids.doi}`
			: card.landingUrl;
	return {
		title: card.title,
		authors: card.authors,
		publishedAt: new Date(card.publishedAt),
		journal: card.journal,
		doi: card.ids.doi ?? null,
		arxivId: card.ids.arxivId ?? null,
		primaryCategory: card.ids.arxivId ? (card.categories[0] ?? null) : null,
		pmid: card.ids.pmid ?? null,
		url
	};
}

export function bibtexResponse(cards: readonly PaperCard[], filename: string): Response {
	return new Response(toBibtexFile(cards.map(bibtexInputFromCard)), {
		headers: {
			'Content-Type': 'application/x-bibtex; charset=utf-8',
			'Content-Disposition': `attachment; filename="${filename}"`,
			'Cache-Control': 'private, no-store'
		}
	});
}
