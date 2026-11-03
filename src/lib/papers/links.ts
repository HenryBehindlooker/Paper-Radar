/**
 * Externe Links eines Papers aus seinen Identifikatoren. PDFs sind ausschließlich
 * Verweise auf die Quelle – Paper-Radar lädt oder spiegelt keine PDFs.
 */

export interface PaperIdsView {
	doi?: string | null;
	arxivId?: string | null;
	pmid?: string | null;
	pmcid?: string | null;
	openalexId?: string | null;
	europepmcId?: string | null;
}

export interface PaperLink {
	kind: 'arxiv' | 'doi' | 'europepmc' | 'pubmed' | 'pmc' | 'openalex' | 'pdf';
	label: string;
	url: string;
}

export function paperLinks(ids: PaperIdsView, pdfUrl?: string | null): PaperLink[] {
	const links: PaperLink[] = [];
	if (ids.arxivId) {
		links.push({
			kind: 'arxiv',
			label: `arXiv:${ids.arxivId}`,
			url: `https://arxiv.org/abs/${ids.arxivId}`
		});
	}
	if (ids.doi) {
		links.push({
			kind: 'doi',
			label: `DOI ${ids.doi}`,
			url: `https://doi.org/${encodeDoi(ids.doi)}`
		});
	}
	if (ids.europepmcId) {
		const [src, id] = ids.europepmcId.split('/');
		if (src && id) {
			links.push({
				kind: 'europepmc',
				label: 'Europe PMC',
				url: `https://europepmc.org/article/${encodeURIComponent(src)}/${encodeURIComponent(id)}`
			});
		}
	}
	if (ids.pmid) {
		links.push({
			kind: 'pubmed',
			label: `PubMed ${ids.pmid}`,
			url: `https://pubmed.ncbi.nlm.nih.gov/${ids.pmid}/`
		});
	}
	if (ids.pmcid) {
		links.push({
			kind: 'pmc',
			label: ids.pmcid,
			url: `https://pmc.ncbi.nlm.nih.gov/articles/${ids.pmcid}/`
		});
	}
	if (ids.openalexId) {
		links.push({
			kind: 'openalex',
			label: 'OpenAlex',
			url: `https://openalex.org/${ids.openalexId}`
		});
	}
	if (pdfUrl && /^https:\/\//i.test(pdfUrl)) {
		links.push({ kind: 'pdf', label: 'PDF (extern)', url: pdfUrl });
	}
	return links;
}

/** DOIs dürfen `/` enthalten; alles andere Problematische wird kodiert. */
function encodeDoi(doi: string): string {
	return encodeURIComponent(doi).replace(/%2F/gi, '/');
}
