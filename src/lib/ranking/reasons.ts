/**
 * Begründung eines Treffers („Warum sehe ich das?“). Wird mit dem Treffer gespeichert
 * und in der Oberfläche angezeigt; daher außerhalb von `server/`.
 */

export type MatchReasonType = 'keyword' | 'category' | 'author';

export interface MatchReason {
	subscriptionId: number;
	type: MatchReasonType;
	/** Abo-Eingabe zum Zeitpunkt des Treffers. */
	query: string;
	weight: number;
	/** Anteil dieses Abos am Score (vor dem Aktualitäts-Abfall). */
	contribution: number;
	/** Nur Stichwort: Treffer (auch) im Titel? */
	inTitle?: boolean;
}

function formatWeight(weight: number): string {
	if (weight === 1) return '';
	return weight > 1 ? ' (höher gewichtet)' : ' (niedriger gewichtet)';
}

/** Lesbare Begründung je Abo, wichtigste zuerst. */
export function explainReasons(reasons: readonly MatchReason[]): string[] {
	return [...reasons]
		.sort((a, b) => b.contribution - a.contribution)
		.map((r) => {
			const w = formatWeight(r.weight);
			switch (r.type) {
				case 'keyword':
					return `Stichwort „${r.query}“ ${r.inTitle ? 'im Titel' : 'im Abstract'}${w}`;
				case 'category':
					return `arXiv-Kategorie ${r.query}${w}`;
				case 'author':
					return `Autor:in ${r.query}${w}`;
			}
		});
}
