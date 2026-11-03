# Architektur

Technische Details zu Paper-Radar. Für Installation und Betrieb siehe die
[README](../README.md), für die Datenquellen [DATA_SOURCES.md](DATA_SOURCES.md).

## Überblick

```
             ┌──────────┐   HTTPS   ┌─────────────────┐      ┌───────────────────────┐
 Browser ───▶│  Caddy   │──────────▶│ App (SvelteKit) │─────▶│ PostgreSQL 16         │
 Feed-Reader │ (TLS)    │           │ liest/schreibt  │      │ Daten + pg-boss-Queue │
             └──────────┘           │ DB, reiht Jobs  │      └───────────▲───────────┘
                                    └─────────────────┘                  │
                                    ┌─────────────────┐                  │
 arXiv, Europe PMC, Crossref, ◀─────│ Worker (genau 1)│──────────────────┘
 OpenAlex (rate-limitiert)          │ pg-boss-Jobs    │
                                    └─────────────────┘
```

- Die **App** ruft nie Upstream-APIs auf. Sie liest und schreibt die Datenbank und reiht
  höchstens Jobs ein.
- Der **Worker** ist der einzige Prozess mit Upstream-Zugriff. Jede Quelle hat dort einen
  eigenen Rate-Limiter (`src/lib/server/sources/`).
- **Queue und Daten** liegen in derselben PostgreSQL-Instanz: pg-boss im Schema `pgboss`,
  die Daten im Schema `public`.

## Projektstruktur

```
src/lib/server/sources/   Adapter je Quelle + Rate-Limiter
src/lib/server/db/        Schema, Migrationen (Drizzle)
src/lib/server/jobs/      pg-boss-Jobs
src/lib/server/ranking/   Matching, Scoring
src/lib/server/feeds/     RSS/Atom/OPML
src/lib/server/enrichment/ OpenAlex-Anreicherung und Budget
src/lib/i18n/             UI-Texte (Deutsch, i18n-fähig)
src/routes/api/           JSON-Endpunkte
src/routes/feed/          RSS/Atom-Feeds
tests/fixtures/           Echte API-Antworten für Tests
docs/DATA_SOURCES.md      Endpunkte, Limits, Lizenzen der Quellen
docker/                   Caddy-Konfiguration, Backup-Skripte, Init-Skript der Dev-DB
scripts/                  Migration, Job einreihen, Worker-Bundle (esbuild)
```

## Anmeldung & Abos

- **Login per Magic-Link** (Auth.js, Nodemailer-Provider): kein Passwort. Neue Konten entstehen
  beim ersten Login. Der Link ist eine Stunde gültig und nur einmal verwendbar. Es gibt höchstens
  3 Anmelde-Mails pro Adresse in 15 Minuten. Bei Drosselung erscheint dieselbe Antwortseite,
  damit sich nicht prüfen lässt, ob eine Adresse existiert.
- **Sessions** liegen in der Datenbank. Das Cookie enthält nur ein zufälliges Token
  (`httpOnly`, `sameSite=lax`, `secure` bei HTTPS-`ORIGIN`).
- **Abos** (`/abos`):
  - Stichwort in `websearch_to_tsquery`-Syntax, arXiv-Kategorie aus der offiziellen Taxonomie
    oder Autor:in per Name bzw. ORCID.
  - Gewicht wählbar: weniger, normal, mehr, viel mehr. Höchstens 50 Abos pro Konto.
  - Ein neues Abo reiht einen Backfill-Job ein. Das passiert nur, wenn das deduplizierte Query
    noch nie nachgeladen wurde. Der Fortschritt aktualisiert sich live auf der Seite.
- **Konto löschen** (`/konto`, DSGVO) entfernt sofort die E-Mail-Adresse, Sessions,
  Anmelde-Tokens, Abos, Treffer und Merkliste.
- JSON: `GET /api/subscriptions` liefert die eigenen Abos mit Backfill-Status.

## Oberfläche

- **Feed** (`/`): Karten mit Titel, Autor:innen, Datum, Quelle, ausklappbarem Abstract (nur bei
  offener Lizenz) und „Warum sehe ich das?“. Aktionen sind gelesen, merken und ausblenden.
  Filter: Alle, Ungelesen, Ausgeblendet. Die Aktionen funktionieren auch ohne JavaScript.
- **Suche** (`/suche`): Volltext über alle gespeicherten Paper in Postgres-Websuche-Syntax.
- **Merkliste** (`/merkliste`) mit BibTeX-Export (`/merkliste/bibtex`).
- **Detailseite** (`/paper/<id>`): alle Autor:innen, Kategorien, Quellen, Links aus allen
  Kennungen (arXiv, DOI, Europe PMC, PubMed, PMC, OpenAlex), PDF nur als externer Verweis,
  BibTeX-Download.
- **Über** (`/ueber`): Quellen und Lizenzen, Ranking-Methode, Datenschutz.
- Die Fußzeile enthält die Pflicht-Attribution („Thank you to arXiv for use of its open access
  interoperability.“) und die Quellen. Das Design ist mobile-first, mit Hell/Dunkel/Automatisch
  über CSS-Variablen (Auswahl nur im Browser gespeichert). Es werden keine Ressourcen von
  Drittanbietern geladen.

## Feeds & Wochen-Mail

- **Persönlicher RSS/Atom-Feed** (unter „Konto“ aktivierbar): Die Adresse ist
  `/feed/<feedId>.<signatur>/rss.xml` bzw. `atom.xml`. Gespeichert wird nur die zufällige
  `feedId`. Die Signatur ist ein HMAC mit einem aus `AUTH_SECRET` abgeleiteten Schlüssel.
  „Neue Adresse erzeugen“ macht die alte sofort ungültig. Zusätzlich gibt es einen Feed je Abo
  (`?abo=<id>`).
  - Feed-Abrufe brauchen keine Anmeldung, die Adresse ist das Geheimnis.
  - Abrufe werden mit `Last-Modified` und `304` gecacht und tragen `noindex`.
  - Ausgeblendete Treffer erscheinen nicht.
- **OPML-Export** (`/konto/opml`): Gesamtfeed plus ein Feed je Abo, zum Import in Feed-Reader.
- **Wochen-Mail**:
  - Opt-in unter „Konto“, Versand Montag 7:00 (Europe/Berlin), Job `weekly-digest`.
  - Inhalt sind die Top-10 der Treffer der letzten 7 Tage nach Live-Score, mit Begründung.
    Ohne Treffer kommt keine Mail.
  - Der Job ist idempotent: Er verschickt höchstens eine Mail pro Person in 6 Tagen.
  - Jede Mail hat einen signierten Abmeldelink. Ein `GET` darauf ändert nichts, weil
    Link-Scanner Links automatisch öffnen. Abgemeldet wird erst per Button oder per
    Ein-Klick-POST nach RFC 8058 (`List-Unsubscribe` + `List-Unsubscribe-Post`).
  - Der Worker braucht dafür `ORIGIN`, `AUTH_SECRET` und die SMTP-Variablen.
- **CSRF**: Für die Ein-Klick-Abmeldung ist die eingebaute Origin-Prüfung von SvelteKit durch
  eine identische eigene Prüfung ersetzt (`src/lib/server/csrf.ts`). Die einzige Ausnahme ist
  `POST /abmelden/<token>`.

## Anreicherung mit OpenAlex

- **Wöchentlich** (Job `enrich-openalex`, Sonntag 04:13 Europe/Berlin) werden Zitationszahlen
  und Autoren-IDs abgerufen, und zwar für gemerkte Paper sowie für gut gerankte Treffer der
  letzten 30 Tage (Relevanz ≥ `OPENALEX_MIN_RELEVANCE`). Gemerkte Paper kommen zuerst. Es gibt
  ausschließlich Einzelabrufe per OpenAlex-ID, DOI oder PMID, keine Listenabfragen.
- **Credit-Protokoll:** Verbrauch und gemeldetes Restbudget (`X-RateLimit-*`) jedes Requests
  landen je UTC-Tag in der Tabelle `openalex_usage`.
- **Tagesbudget:** `OPENALEX_DAILY_CREDIT_BUDGET` und `OPENALEX_DAILY_REQUEST_LIMIT`. Der Job
  pausiert sauber, statt einen Fehler zu werfen, wenn
  - eines der Budgets erreicht ist,
  - OpenAlex weniger als 50 Credits Restbudget meldet oder
  - der Server ein leeres Budget meldet.

  Er plant sich dann selbst für die nächste Mitternacht UTC neu ein (Budget-Reset bei
  OpenAlex). Ohne `OPENALEX_API_KEY` wird die Anreicherung übersprungen.

- Im Feed gibt es die Sortierung **„Häufig zitiert“**. Karten zeigen die Zitationszahl, sobald
  sie bekannt ist.

## Ranking („Warum sehe ich das?“)

Jedes Paper erscheint pro Person nur einmal, auch wenn mehrere Abos treffen. Der Score ist
nachvollziehbar und wird nicht personalisiert gelernt:

```
score = ( Textrelevanz × Abo-Gewicht            (bestes Stichwort-Abo, ts_rank_cd normiert auf r/(r+1))
        + 0,6 × Abo-Gewicht, falls ein Autor-Abo trifft
        + 0,3 × Abo-Gewicht, falls ein Kategorie-Abo trifft )
        × 0,5 ^ (Alter in Tagen / Halbwertszeit)  (RANKING_HALF_LIFE_DAYS, Standard 7)
```

- Titeltreffer zählen stärker als Abstract-Treffer (tsvector-Gewichte A bzw. B).
- Gespeichert wird die Relevanz ohne Abfall. Der Feed rechnet den Aktualitäts-Abfall beim
  Lesen live, damit ältere Treffer mit der Zeit korrekt nach hinten rutschen.
- Zu jedem Treffer werden die getroffenen Abos gespeichert und im Feed unter
  „Warum sehe ich das?“ angezeigt, z. B. „Stichwort „crispr“ im Titel“.
- Matching-Job (`match`): Er läuft nach jeder Ingestion und wenn jemand ein neues Abo anlegt,
  zusätzlich alle 6 Stunden. Neue Paper werden gegen alle Abos geprüft, neue Abos gegen die
  vorhandenen Paper der letzten 30 Tage. Jedes deduplizierte Query wird nur einmal ausgewertet.
  Dabei sind ausschließlich lokale Datenbankabfragen im Spiel, keine Upstream-Aufrufe.
- Autor-Abos: ORCID exakt, Namen ohne Diakritika und auch mit abgekürzten Vornamen
  („Rui Yang“ trifft „R. Yang“).

## Datenbank & Jobs

- **Schema** (`src/lib/server/db/schema.ts`): `papers` (mit generierter `tsvector`-Spalte,
  Titel Gewicht A, Abstract Gewicht B, GIN-Index), `paper_ids` (Typ + Wert, eindeutig),
  `authors`, `paper_authors`, `users` (nur E-Mail), `subscriptions`, `source_queries`
  (deduplizierte Abo-Anfragen), `source_query_status`, `matches`, `fetch_log`.
- **Dedup/Merge:** Gleiche DOI, arXiv-ID, PMID usw. ergeben genau einen Datensatz. Wird einem
  arXiv-Preprint später eine DOI zugeordnet, werden Preprint und Verlagsversion
  zusammengeführt, einschließlich Treffern und Merkliste. Metadaten stammen aus der Quelle mit
  der höchsten Priorität (Crossref > Europe PMC > arXiv > OpenAlex). Anzeigbare Abstracts haben
  Vorrang. Es gilt das früheste Veröffentlichungsdatum.
- **Jobs** (pg-boss, Schema `pgboss`, Zeitzone Europe/Berlin):

  | Queue                  | Wann                        | Was                                                                              |
  | ---------------------- | --------------------------- | -------------------------------------------------------------------------------- |
  | `ingest-queries-daily` | täglich 05:43               | Europe PMC (Keyword/Autor) und arXiv-API (Keyword/Autor) je dedupliziertem Query |
  | `ingest-arxiv-daily`   | Mo–Fr 07:17                 | arXiv-RSS für alle abonnierten Kategorien (gebündelt)                            |
  | `backfill`             | bei neuem Abo               | letzte 30 Tage aus allen passenden Quellen                                       |
  | `enrich-crossref`      | nach Ingestion, 09:07       | Crossref-Ergänzung für noch nicht geprüfte DOIs (bis 20 pro Request)             |
  | `cleanup`              | täglich 03:27               | Paper ohne Treffer und älter als 180 Tage, Verwaistes, Protokoll > 90 Tage       |
  | `match`                | nach Ingestion, 6-stündlich | Neue Paper gegen alle Abos ranken (Wasserzeichen mit 15 min Überlappung)         |
  | `enrich-openalex`      | So 04:13                    | Zitationszahlen/Autoren-IDs per Einzelabruf, im Tagesbudget                      |
  | `weekly-digest`        | Mo 07:00                    | Wochen-Mail an Nutzer mit aktivierter Mail                                       |

- **Nutzeraktionen lösen nie direkte Upstream-Aufrufe aus.** Sie reihen höchstens einen Job
  ein. Gleiche Abos werden über `source_queries` nur einmal abgefragt.
- **Genau ein Worker:** Die Rate-Limiter gelten je Prozess. Starte deshalb nur einen
  Worker-Prozess. Die App sendet nur Jobs.
- **Fehlerisolation:** Fällt eine Quelle aus, landet das in `fetch_log` und
  `source_query_status`, die anderen laufen weiter. Das Zeitfenster rückt nur bei Erfolg vor.
  Der nächste Lauf holt Versäumtes nach (bis zu 30 Tage).
