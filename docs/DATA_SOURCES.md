# Datenquellen

Für jede Quelle sind hier Endpunkte, Limits, Nutzungsbedingungen und
Attributionspflichten festgehalten. Die Angaben stammen aus der offiziellen
Dokumentation (Abruf am **2026-11-03**) und wurden mit echten Requests geprüft.
Die Antworten liegen als Fixtures unter `tests/fixtures/`.
Abweichungen zwischen Doku und tatsächlichem Verhalten sind mit **Live-Befund**
markiert.

| Quelle     | Zweck in Paper-Radar                                  | Limit in Paper-Radar                |
| ---------- | ----------------------------------------------------- | ----------------------------------- |
| arXiv      | Tägliche Neuerscheinungen (RSS), Suche/Backfill (API) | 1 Request / 3 s, 1 Verbindung       |
| Europe PMC | Keyword- und Autor-Abos (Life Sciences, Preprints)    | 5 req/s, 1 Verbindung (konservativ) |
| Crossref   | DOI-Lookup, Metadaten-Ergänzung                       | 5 req/s (Listen 1 req/s), 1 Verb.   |
| OpenAlex   | Anreicherung: Zitationszahl, Autoren-IDs (nur per ID) | 10 req/s, 1 Verbindung              |

## Gemeinsame Regeln (Implementierung)

- **User-Agent:** `Paper-Radar/<version> (+https://github.com/HenryBehindlooker/Paper-Radar; mailto:<CONTACT_EMAIL>)`.
  Der `mailto`-Teil erscheint nur, wenn `CONTACT_EMAIL` gesetzt ist.
- **Ein Limiter pro Quelle** (`src/lib/server/sources/rate-limiter.ts`). Alle Requests
  einer Quelle laufen durch ihn, auch Retries. Für arXiv teilen sich API und RSS einen
  Limiter.
- **Retries:** bei 429/500/502/503/504 und Netzwerkfehlern höchstens 3 Wiederholungen.
  `Retry-After` wird beachtet und pausiert die ganze Quelle. Fehlt der Header, gilt
  exponentieller Backoff mit Jitter. Liegt `Retry-After` über 120 s, bricht der Request
  mit `SourceRateLimitedError` ab, und der Job wird neu eingeplant statt zu blockieren.
- **Fehlerisolation:** Jede Quelle hat eigene Limiter und Fehlerklassen. Fällt eine
  Quelle aus, laufen die anderen weiter (Test: `factory.test.ts`).
- **Nur Metadaten und Links:** PDFs werden nie heruntergeladen oder gespiegelt.
  `pdfUrl` ist nur ein Verweis.
- **Secrets** (`OPENALEX_API_KEY`) werden nur serverseitig verwendet und in Logs aus
  URLs entfernt.

---

## arXiv

**Doku:** [API Terms of Use](https://info.arxiv.org/help/api/tou.html),
[API User Manual](https://info.arxiv.org/help/api/user-manual.html),
[RSS](https://info.arxiv.org/help/rss.html),
[API Access](https://info.arxiv.org/help/api/index.html),
[Identifier](https://info.arxiv.org/help/arxiv_identifier.html)

### Endpunkte

| Zweck            | Endpunkt                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Suche / Backfill | `GET https://export.arxiv.org/api/query?search_query=…&start=…&max_results=…&sortBy=submittedDate&sortOrder=descending` |
| Einzelabruf      | `GET https://export.arxiv.org/api/query?id_list=<id>`                                                                   |
| Tägliche Neuheit | `GET https://rss.arxiv.org/rss/<cat>[+<cat>…]` (kombinierte Feeds bis 2000 Einträge)                                    |

- Suchfelder: `ti:`, `au:`, `abs:`, `cat:`, `all:`. Operatoren: `AND`, `OR`, `ANDNOT`.
  Datumsfilter: `submittedDate:[YYYYMMDDHHMM TO YYYYMMDDHHMM]` (GMT).
- Paging: höchstens 2000 Einträge pro Request und 30 000 insgesamt. Paper-Radar nutzt
  Seiten zu 100 Einträgen.
- Die RSS-Feeds werden laut Doku täglich um Mitternacht Eastern Time aktualisiert. Am
  Wochenende gibt es keine Ankündigungen (`<skipDays>`).
- `arxiv:announce_type` ist `new`, `cross`, `replace` oder `replace-cross`. Paper-Radar
  übernimmt standardmäßig nur `new` und `cross`.

### Limits

> „When using the legacy APIs (including OAI-PMH, RSS, and the arXiv API), make no more
> than one request every three seconds, and limit requests to a single connection at a
> time.“ – gilt für alle Rechner eines Betreibers zusammen.

Umsetzung: mindestens 3 s Abstand zwischen zwei Request-Starts **und** 3 s nach dem Ende
des vorherigen Requests, höchstens eine Verbindung. Der Backoff startet bei 5 s.

### Lizenz und Nutzung

- **Metadaten** (Titel, Abstract, Autoren, IDs, Kategorien) stehen unter **CC0 1.0**.
  Deshalb ist `abstractLicenseOk = true`.
- Das Feld `dc:rights` im RSS betrifft die Lizenz des **E-Prints**, nicht die der
  Metadaten.
- E-Prints (PDF, Quellen) dürfen nicht gespeichert oder ausgeliefert werden. Paper-Radar
  verlinkt nur auf die Abstract-Seite und das PDF bei arXiv.
- Das Projekt darf nicht unter dem Namen „arXiv“ gebrandet werden, und es darf keine
  Unterstützung durch arXiv suggeriert werden.

### Attribution (Pflicht)

> „Thank you to arXiv for use of its open access interoperability.“

Der Satz muss auf dem Produkt erscheinen (Fußzeile, Phase 5).

### Live-Befunde

- Eine ungültige ID (`id_list=1234.1234`) liefert **einen leeren Feed** (HTTP 200,
  `totalResults=0`) statt des in der Doku beschriebenen Error-Eintrags. Der Parser kann
  beide Varianten.
- Eine unbekannte RSS-Kategorie liefert **HTTP 400** mit einem RSS-Kanal
  „Feed error for query“, der die gültigen Archive auflistet.
- `id_list` ohne Version liefert die aktuelle Version. Die Reihenfolge der Einträge
  entspricht nicht der Anfrage.
- Die RSS-Einträge enthalten kein Einreichungsdatum, nur `pubDate` (Ankündigungstag).
- Titel und Abstracts enthalten LaTeX (`$\mathbb P^3$`), das unverändert bleibt.
  Zeilenumbrüche werden normalisiert.
- `arxiv:doi` bzw. `arxiv:DOI` enthält die Verlags-DOI, falls vorhanden. arXivs eigene
  DataCite-DOIs `10.48550/arXiv.<id>` werden als arXiv-ID geführt.

---

## Europe PMC

**Doku:** OpenAPI-Spezifikation
`https://www.ebi.ac.uk/europepmc/webservices/rest/v3/api-docs`,
Suchfelder `https://www.ebi.ac.uk/europepmc/webservices/rest/fields`,
[EMBL-EBI Terms of Use](https://www.ebi.ac.uk/about/terms-of-use) (Stand 14.10.2026)

> **Hinweis:** Die Hilfeseiten auf `europepmc.org` (RestfulWebService, Developers,
> Copyright, Help) antworten auf automatisierte Abrufe mit **HTTP 403**. Belegt sind die
> OpenAPI-Spezifikation und die EMBL-EBI-Nutzungsbedingungen. Ein offizielles Rate-Limit
> und ein vorgegebener Attributionstext waren so nicht auffindbar.
> **Offener Punkt:** im Browser prüfen (siehe unten).

### Endpunkte

| Zweck       | Endpunkt                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| Suche       | `GET https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=…&resultType=core&format=json&pageSize=…&cursorMark=…` |
| Einzelabruf | ebenfalls über `search`: `DOI:"…"`, `EXT_ID:<pmid> AND SRC:MED`, `PMCID:PMC…`, `EXT_ID:<id> AND SRC:<src>`                |

- `resultType`: `idlist` | `lite` | `core`. Nur `core` enthält Abstracts.
- `pageSize`: Standard 25, **höchstens 1000**. Paging über `cursorMark` (`*` →
  `nextCursorMark`).
- `email` (optional): registriert die Adresse bei EBI für Service-News. Paper-Radar
  sendet ihn nicht.
- Genutzte Suchfelder (live geprüft): `TITLE_ABS:` für Keywords in Titel und Abstract,
  `AUTH:"Nachname Initialen"` (z. B. `AUTH:"Yang R"`), `AUTHORID:"<ORCID>"`,
  `FIRST_IDATE:[YYYY-MM-DD TO YYYY-MM-DD]` (erstes Indexierungsdatum, erfasst auch spät
  indexierte Arbeiten), `SRC:PPR` für Preprints.

### Limits

Ein offizielles Limit ist nicht dokumentiert bzw. nicht abrufbar, und die Antwort-Header
enthalten keine Rate-Limit-Angaben. Die EMBL-EBI-ToU verbieten eine Nutzung, „that
prevents, or is likely to prevent, EMBL-EBI providing services to others“. Umsetzung:
**5 req/s, eine Verbindung** (Projektvorgabe).

### Lizenz und Nutzung

- EMBL-EBI legt keine eigenen Beschränkungen auf, es gelten aber die Rechte der
  ursprünglichen Datengeber: „It is the responsibility of users … to ensure that their
  exploitation of the data does not infringe any of the rights of such third parties.“
- Daraus folgt für Paper-Radar: `abstractLicenseOk = true` nur, wenn das Feld `license`
  eine offene Lizenz angibt (`cc by…`, `cc0`, Public Domain). Andernfalls bleibt der
  Abstract gespeichert, wird aber als nicht anzeigbar markiert.
- Attribution: EMBL-EBI erwartet „attribution … in accordance with good scientific
  practice“. Der genaue Text steht laut ToU „on the relevant web page of the resource“,
  und diese Seite war nicht abrufbar. Vorläufig nennt die Fußzeile „Daten: Europe PMC
  (EMBL-EBI)“ mit Link.

### Live-Befunde

- Ein **ungültiges Sortierfeld** (`sort=FIRST_PDATE desc` statt `FIRST_PDATE_D`) liefert
  **HTTP 503** mit `{"errCode":503,"errMsg":"Search service is temporarily unavailable…"}`.
  Ein 503 kann also ein Client-Fehler sein. Die Retries sind deshalb begrenzt
  (Fixture `error-503.json`).
- Eine syntaktisch kaputte Query (`(CRISPR AND`) wird nicht abgelehnt, sondern liefert
  Treffer.
- Abstracts enthalten HTML/JATS (`<h4>`, `<p>`, `<bold>`, `<italic>`, `<title>`), Titel
  teils `<i>`. Paper-Radar wandelt beides in reinen Text um.
- In Stichproben fanden sich keine arXiv-Preprints in Europe PMC (Oktober 2026).

---

## Crossref

**Doku:** [REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/),
[Access and authentication](https://www.crossref.org/documentation/retrieve-metadata/rest-api/access-and-authentication/),
[Tips](https://www.crossref.org/documentation/retrieve-metadata/rest-api/tips-for-using-the-crossref-rest-api/),
[Metadata Retrieval – Licensing](https://www.crossref.org/documentation/retrieve-metadata/)

### Endpunkte

| Zweck         | Endpunkt                                                           |
| ------------- | ------------------------------------------------------------------ |
| Einzel-DOI    | `GET https://api.crossref.org/works/<doi>[?mailto=…]`              |
| Mehrere DOIs  | `GET https://api.crossref.org/works?filter=doi:<a>,doi:<b>&rows=…` |
| Agentur (DOI) | `GET https://api.crossref.org/works/<doi>/agency`                  |

### Limits

| Pool                         | Rate    | Parallel |
| ---------------------------- | ------- | -------- |
| Public (ohne Identifikation) | 5 / s   | 1        |
| Polite (`mailto`)            | 10 / s  | 3        |
| Metadata Plus (API-Key)      | 150 / s | –        |

- Die Limits stehen in den Headern `x-rate-limit-limit`, `x-rate-limit-interval` und
  `x-concurrency-limit`. Paper-Radar liest sie bei jeder Antwort und **verschärft** den
  Limiter entsprechend. Gelockert wird nie.
- Bei einem Limitverstoß kommt 429, bei manueller Sperre 403.
- **Live-Befund:** Im Public Pool gilt für **Listenabfragen** (`/works?filter=…`)
  `x-rate-limit-limit: 1` / `1s`, für Einzelabrufe 5 / `1s`. Header `x-api-pool:
public-single`.

### Lizenz und Nutzung

> „Almost all of the metadata we hold is reusable without restriction, with the exception
> of abstracts which are subject to publisher or author copyright. … The agreement we have
> with our members permits us to distribute abstracts, but they retain the license under
> which they were published.“

Daraus folgt für Paper-Radar: Ein Abstract wird **nur** übernommen
(`abstractLicenseOk = true`), wenn für `content-version` `vor` (oder `unspecified`) eine
`creativecommons.org`-Lizenz (`licenses/…` oder `publicdomain/…`) eingetragen ist, deren
Start einschließlich `delay-in-days` erreicht ist. Andernfalls wird der Abstract
**verworfen**. Beispiele aus den Fixtures: Wiley-AGB (`work-abstract-publisher-license.json`)
und ohne Lizenzangabe (`work-abstract-no-license.json`).

Attribution ist keine Pflicht. Die Metadaten sind Fakten bzw. CC0. Die Über-Seite nennt
Crossref trotzdem als Quelle.

### Live-Befunde

- Eine unbekannte DOI liefert **404** mit `text/plain` und dem Text „Resource not found.“
- DataCite-DOIs (z. B. arXiv `10.48550/arXiv.1706.03762`) liefern 404. `/agency` meldet
  `datacite`.
- Titel und Abstracts enthalten JATS (`<jats:p>`, `<jats:title>ABSTRACT</jats:title>`,
  `<i>`).
- `published` kann ein Teildatum sein (`[[1999, 4]]`). Paper-Radar ergänzt dann den
  Monatsersten bzw. Jahresanfang.

---

## OpenAlex

**Doku:** [Authentication](https://help.openalex.org/api/authentication/),
[Pricing](https://help.openalex.org/access/pricing/),
[Example costs](https://help.openalex.org/access/example-costs/),
[Get single entities](https://help.openalex.org/api/get-single-entities/),
[Errors](https://help.openalex.org/api/errors/),
[Citing OpenAlex](https://help.openalex.org/how-to/citing-openalex/)

### Endpunkte

| Zweck         | Endpunkt                                                |
| ------------- | ------------------------------------------------------- |
| Work per DOI  | `GET https://api.openalex.org/works/doi:<doi>?select=…` |
| Work per ID   | `GET https://api.openalex.org/works/W…`                 |
| Work per PMID | `GET https://api.openalex.org/works/pmid:<pmid>`        |

Den Key sendet Paper-Radar als `Authorization: Bearer <key>`, nie als Query-Parameter.

### Limits und Kosten

- **API-Key:** Laut aktueller Doku ist er **optional**. Ohne Key gilt ein kleineres
  Budget (live: `x-ratelimit-limit-usd: 0.1` pro Tag), mit kostenlosem Key **1 $/Tag**.
  Cursor-Paging funktioniert nur mit Key. **Projektvorgabe:** Paper-Radar nutzt OpenAlex
  nur mit Key. Ohne `OPENALEX_API_KEY` ist die Anreicherung deaktiviert
  (`SourceDisabledError`).
- **Rate:** 10 req/s ohne Key, 30 req/s mit Key. Paper-Radar bleibt bei 10 req/s und
  einer Verbindung.
- **Kosten:** Einzelabrufe sind **kostenlos**. List und Filter kosten 1 Credit, Search
  10 Credits, wobei 10 000 Credits 1 $ entsprechen. Paper-Radar nutzt ausschließlich
  Einzelabrufe.
- **Header:** `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Credits-Used`,
  `X-RateLimit-Reset` (Sekunden bis Mitternacht UTC). Paper-Radar protokolliert sie über
  `onOpenAlexUsage` (für Phase 7).
- **429** bedeutet entweder ein kurzfristiges Ratenlimit (Retry) oder ein erschöpftes
  Budget bzw. `not_enough_credits` (kein Retry, `SourceBudgetExhaustedError`, sauber
  pausieren). Fehlerantworten kosten 0 Credits.
- **Live-Befund:** Einzelabrufe funktionieren auch dann, wenn das Budget ohne Key bei 0
  steht (`x-ratelimit-credits-used: 0`).

### Lizenz und Nutzung

- Die Daten stehen unter **CC0**. Paper-Radar übernimmt aus OpenAlex trotzdem **keine
  Abstracts**, sondern nur Zitationszahlen sowie Autoren- und Werk-IDs.
- Zitierwunsch (keine Pflicht): Priem, J., Piwowar, H., & Orr, R. (2022). _OpenAlex: A
  fully-open index of scholarly works, authors, venues, institutions, and concepts._
  ArXiv. https://arxiv.org/abs/2205.01833

### Live-Befunde

- Eine unbekannte DOI liefert **404 mit HTML**, nicht mit JSON.
- `authorships[].author.id` kann `null` sein (z. B. Maldacena 1999).

---

## Fixtures

Alle Fixtures wurden am 2026-11-03 live abgerufen, mit dem User-Agent
`Paper-Radar/0.1 (+https://github.com/HenryBehindlooker/Paper-Radar)` und ohne
`mailto` bzw. API-Key.

| Datei                                           | Request                                                                                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `arxiv/search-cs-dl.atom.xml`                   | `api/query?search_query=cat:cs.DL AND submittedDate:[202610200000 TO 202610270000]&max_results=5&sortBy=submittedDate&sortOrder=descending` |
| `arxiv/idlist-mixed.atom.xml`                   | `api/query?id_list=hep-th/9711200,1706.03762v5,2103.00020&max_results=3`                                                                    |
| `arxiv/error-malformed-id.atom.xml`             | `api/query?id_list=1234.1234`                                                                                                               |
| `arxiv/search-empty.atom.xml`                   | `api/query?search_query=ti:"zzqqxxnonexistentphrase"&max_results=5`                                                                         |
| `arxiv/rss-cs-dl.rss.xml`                       | `rss.arxiv.org/rss/cs.DL`                                                                                                                   |
| `arxiv/rss-math-ag.rss.xml`                     | `rss.arxiv.org/rss/math.AG` (LaTeX in Titeln)                                                                                               |
| `arxiv/rss-nlin-cg.rss.xml`                     | `rss.arxiv.org/rss/nlin.CG` (1 Eintrag)                                                                                                     |
| `arxiv/rss-unknown-category.rss.xml`            | `rss.arxiv.org/rss/foo.BAR` (HTTP 400)                                                                                                      |
| `europepmc/search-crispr-core.json`             | `search?query=CRISPR AND FIRST_PDATE:[2026-10-20 TO 2026-10-27]&resultType=core&format=json&pageSize=5`                                     |
| `europepmc/search-preprints-core.json`          | `search?query=SRC:PPR AND malaria AND FIRST_PDATE:[2026-10-01 TO 2026-10-31]&resultType=core&format=json&pageSize=5`                        |
| `europepmc/search-empty.json`                   | `search?query=TITLE:"zzqqxxnonexistentphrase"&resultType=core&format=json`                                                                  |
| `europepmc/error-503.json`                      | `search?…&sort=FIRST_PDATE desc` (ungültiges Sortierfeld → 503)                                                                             |
| `europepmc/by-doi-core.json`                    | `search?query=DOI:"10.1002/advs.78445"&resultType=core&format=json`                                                                         |
| `europepmc/by-orcid-lite.json`                  | `search?query=AUTHORID:"0000-0003-0676-8857"&resultType=lite&format=json&pageSize=3`                                                        |
| `europepmc/umlaut-author-core.json`             | `search?query=AUTH:"Müller" AND FIRST_PDATE:[2026-10-20 TO 2026-10-27]&resultType=core&format=json&pageSize=3`                              |
| `crossref/work-cc-by.json`                      | `works/10.1002/advs.78445`                                                                                                                  |
| `crossref/work-no-license-springer.json`        | `works/10.1007/s00284-026-05157-w`                                                                                                          |
| `crossref/work-maldacena-1998.json`             | `works/10.1023/A:1026654312961`                                                                                                             |
| `crossref/work-posted-content.json`             | `works/10.64898/2026.10.25.26366323`                                                                                                        |
| `crossref/work-abstract-publisher-license.json` | `works/10.1002/smll.76416` (Abstract, Wiley-AGB)                                                                                            |
| `crossref/work-abstract-no-license.json`        | `works/10.1145/3859365` (Abstract, keine Lizenz)                                                                                            |
| `crossref/work-not-found.txt`                   | `works/10.1234/paper-radar-does-not-exist` (404)                                                                                            |
| `crossref/work-datacite-arxiv-doi.txt`          | `works/10.48550/arXiv.1706.03762` (404)                                                                                                     |
| `crossref/agency-datacite.json`                 | `works/10.48550/arXiv.1706.03762/agency`                                                                                                    |
| `crossref/works-filter-dois.json`               | `works?filter=doi:10.1002/advs.78445,doi:10.1145/3859365,doi:10.1234/paper-radar-does-not-exist&rows=20`                                    |
| `openalex/work-by-doi.json`                     | `works/doi:10.1023/A:1026654312961?select=id,doi,display_name,cited_by_count,counts_by_year,authorships,ids,updated_date,publication_date`  |
| `openalex/work-by-doi-full.json`                | `works/doi:10.1002/advs.78445`                                                                                                              |
| `openalex/work-not-found.html`                  | `works/doi:10.1234/paper-radar-does-not-exist` (404, HTML)                                                                                  |
| `openalex/author-by-orcid.json`                 | `authors/orcid:0000-0003-0676-8857?select=id,orcid,display_name,works_count,cited_by_count`                                                 |

## Offene Punkte

- [ ] **Europe PMC:** Rate-Limit-Empfehlung, Wiederverwendung von Abstracts und den
      gewünschten Attributionstext im Browser auf `europepmc.org/RestfulWebService`,
      `/developers` und `/Copyright` prüfen. Automatisierte Abrufe werden dort mit 403
      abgewiesen.
- [ ] **CONTACT_EMAIL** setzen, damit Crossref im Polite Pool läuft und der User-Agent
      kontaktierbar ist.
- [ ] **OPENALEX_API_KEY** setzen (kostenlos, openalex.org → Settings → API key).
