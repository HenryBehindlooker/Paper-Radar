<script lang="ts">
	import { t } from '$lib/i18n';
</script>

<svelte:head>
	<title>{t('nav.about')} – {t('app.name')}</title>
</svelte:head>

<h1>Über Paper-Radar</h1>
<p>
	Paper-Radar zeigt dir täglich neue wissenschaftliche Paper zu deinen Stichwörtern,
	arXiv-Kategorien und Autor:innen – sortiert nach einer offengelegten Formel, ohne Tracking und
	ohne lernenden Empfehlungsalgorithmus. Der Quellcode ist frei (AGPL-3.0).
</p>

<section aria-labelledby="quellen">
	<h2 id="quellen">Datenquellen</h2>
	<p>
		Paper-Radar speichert nur Metadaten (Titel, Autor:innen, Abstracts, Kennungen) und Links. PDFs
		werden nie heruntergeladen oder gespiegelt – Links führen immer zur Quelle.
	</p>
	<div class="table">
		<table>
			<thead>
				<tr
					><th scope="col">Quelle</th><th scope="col">Wofür</th><th scope="col"
						>Lizenz der Metadaten</th
					></tr
				>
			</thead>
			<tbody>
				<tr>
					<td><a href="https://arxiv.org/">arXiv</a></td>
					<td>Neuerscheinungen je Kategorie (RSS), Suche und Nachladen</td>
					<td>CC0 1.0 (Metadaten inkl. Abstracts)</td>
				</tr>
				<tr>
					<td><a href="https://europepmc.org/">Europe PMC</a> (EMBL-EBI)</td>
					<td>Lebenswissenschaften inkl. Preprints</td>
					<td>Rechte der Verlage/Autor:innen; Abstracts nur bei offener Lizenz angezeigt</td>
				</tr>
				<tr>
					<td><a href="https://www.crossref.org/">Crossref</a></td>
					<td>DOI-Abgleich und Ergänzung der Metadaten</td>
					<td>Fakten bzw. CC0; Abstracts nur bei Creative-Commons-Lizenz</td>
				</tr>
				<tr>
					<td><a href="https://openalex.org/">OpenAlex</a></td>
					<td>Zitationszahlen und Autoren-IDs (nur Einzelabrufe)</td>
					<td>CC0</td>
				</tr>
			</tbody>
		</table>
	</div>
	<p lang="en">Thank you to arXiv for use of its open access interoperability.</p>
	<p class="muted">
		Paper-Radar ist ein unabhängiges Projekt und wird weder von arXiv noch von den anderen Quellen
		betrieben oder empfohlen. Alle Abfragen laufen zentral, gebündelt und unter Einhaltung der
		Nutzungsbedingungen und Rate-Limits der Quellen.
	</p>
</section>

<section aria-labelledby="ranking">
	<h2 id="ranking">So entsteht die Reihenfolge</h2>
	<p>Jedes Paper erscheint pro Person nur einmal, auch wenn mehrere Abos treffen. Der Score:</p>
	<pre><code
			>score = ( Textrelevanz × Abo-Gewicht
        + 0,6 × Abo-Gewicht   (wenn ein Autor-Abo trifft)
        + 0,3 × Abo-Gewicht   (wenn ein Kategorie-Abo trifft) )
        × 0,5 ^ (Alter in Tagen / 7)</code
		></pre>
	<ul>
		<li>
			<strong>Textrelevanz</strong>: PostgreSQL-Volltextsuche; Treffer im Titel zählen stärker als
			im Abstract. Bei mehreren Stichwort-Abos zählt das stärkste.
		</li>
		<li><strong>Abo-Gewicht</strong>: legst du selbst fest („weniger“ bis „viel mehr“).</li>
		<li>
			<strong>Aktualität</strong>: Nach einer Halbwertszeit (standardmäßig 7 Tage) zählt ein Paper
			nur noch halb so viel.
		</li>
		<li>
			Es gibt kein Lernen aus deinem Klickverhalten und keine Personalisierung über deine Abos
			hinaus. Unter „Warum sehe ich das?“ steht bei jedem Paper, welches Abo es getroffen hat.
		</li>
	</ul>
</section>

<section aria-labelledby="datenschutz">
	<h2 id="datenschutz">Datenschutz</h2>
	<ul>
		<li>
			<strong>Gespeichert</strong> wird nur deine E-Mail-Adresse sowie das, was du selbst anlegst: Abos,
			Treffer, Merkliste und Gelesen-/Ausgeblendet-Markierungen.
		</li>
		<li>
			<strong>Cookies</strong>: ausschließlich ein technisch notwendiges Sitzungs-Cookie nach der
			Anmeldung. Dein gewähltes Farbschema liegt nur in deinem Browser (localStorage).
		</li>
		<li>
			<strong>Kein Tracking</strong>: keine Analyse-Dienste, keine Werbung, keine eingebundenen
			Ressourcen von Drittanbietern. Mails enthalten keine Tracking-Pixel.
		</li>
		<li>
			<strong>E-Mails</strong> erhältst du nur für die Anmeldung (und, wenn du sie einschaltest, für die
			Wochen-Mail).
		</li>
		<li>
			<strong>Löschen</strong>: Unter „Konto“ kannst du dein Konto jederzeit sofort mit allen Daten
			löschen.
		</li>
	</ul>
</section>

<section aria-labelledby="mitmachen">
	<h2 id="mitmachen">Freie Software</h2>
	<p>
		Paper-Radar steht unter der
		<a href="https://www.gnu.org/licenses/agpl-3.0.html">GNU Affero General Public License v3.0</a>.
		Den Quellcode findest du auf
		<a href="https://github.com/HenryBehindlooker/Paper-Radar">GitHub</a>.
	</p>
</section>

<style>
	.table {
		overflow-x: auto;
	}

	table {
		border-collapse: collapse;
		width: 100%;
		font-size: 0.9rem;
	}

	th,
	td {
		text-align: left;
		vertical-align: top;
		padding: 0.4rem 0.5rem;
		border-bottom: 1px solid var(--color-border);
	}

	pre {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius);
		padding: 0.75rem;
		overflow-x: auto;
		font-size: 0.85rem;
	}
</style>
