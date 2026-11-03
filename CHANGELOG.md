# Changelog

Alle nennenswerten Änderungen werden hier dokumentiert.
Format angelehnt an [Keep a Changelog](https://keepachangelog.com/de/1.1.0/).

## [Unreleased]

### Hinzugefügt

- Persönlicher RSS 2.0/Atom 1.0-Feed unter geheimer, rotierbarer URL (HMAC-signiert, nur
  Feed-ID gespeichert), Feed je Abo, Caching per Last-Modified/304; OPML-Export.
- Wochen-Mail (Opt-in, Montag 7 Uhr Europe/Berlin): Top-10 der Woche mit Begründung,
  idempotenter Job, signierter Abmeldelink und RFC-8058-Ein-Klick-Abmeldung.
- Eigener CSRF-Hook (gleiche Regeln wie SvelteKit) mit Ausnahme nur für die Abmeldung.

- Oberfläche: Feed-Karten mit Abstract, Begründung und Aktionen (gelesen, merken,
  ausblenden; auch ohne JavaScript), Filter und Seiten; Suche über die eigene Datenbank;
  Merkliste; Paper-Detailseite mit Links aus allen Kennungen (PDF nur als Verweis);
  BibTeX-Export für einzelne Paper und die Merkliste; Über-Seite (Quellen, Ranking,
  Datenschutz); Pflicht-Attribution in der Fußzeile; Hell/Dunkel-Umschalter.

- Matching und Ranking: reine, getestete Score-Funktionen (Textrelevanz × Gewicht,
  Autor-/Kategorie-Boost, Aktualitäts-Abfall mit konfigurierbarer Halbwertszeit),
  Matching-Job mit Wasserstand (inkl. Überlappung gegen späte Commits), Erstzuordnung
  neuer Abos (30 Tage), ein Treffer pro Person und Paper mit Begründungen.
- Startseite zeigt angemeldet die Treffer mit „Warum sehe ich das?“ (Live-Sortierung).

### Geändert

- Volltextindex begrenzt den indexierten Text (Titel 2.000, Abstract 50.000 Zeichen),
  da ein tsvector höchstens 1 MB groß sein darf; Abstracts werden weiterhin vollständig
  gespeichert.

- Anmeldung per E-Mail-Magic-Link (Auth.js, Drizzle-Adapter, Datenbank-Sessions) mit
  deutscher Anmelde-Mail ohne Tracking und Versand-Drosselung; Mailpit für Entwicklung/CI.
- Abo-Verwaltung (`/abos`): Stichwort, arXiv-Kategorie (Auswahlliste aus der offiziellen
  Taxonomie), Autor:in (Name/ORCID), Gewicht; Backfill-Job mit Live-Fortschritt.
- Konto-Seite mit vollständiger Löschung aller personenbezogenen Daten (DSGVO).
- Zugriffsschutz per Hook, Sicherheits-Header, JSON-API `GET /api/subscriptions`.
- E2E-Test für Login, Abo-Verwaltung und Konto-Löschung (Playwright + Mailpit).

- Datenbank (PostgreSQL 16, Drizzle ORM): Schema mit Migrationen, Volltextsuche über
  generierte `tsvector`-Spalte (Titel A, Abstract B) mit GIN-Index.
- Dedup/Merge von Papern über alle IDs (DOI, arXiv, PMID, PMCID, OpenAlex, Europe PMC)
  inkl. Zusammenführung von Preprint und Verlagsversion; Advisory-Locks gegen Dubletten.
- Deduplizierte Abo-Anfragen (`source_queries`) und Fetch-Protokoll mit Status je Quelle.
- pg-boss-Worker mit Queues und Zeitplänen: tägliche arXiv-RSS- und Query-Ingestion,
  Backfill (30 Tage), Crossref-Ergänzung, Aufräumen (180 Tage).
- Integrationstests gegen echte PostgreSQL; CI mit PostgreSQL-Service.

- Datenquellen-Adapter mit gemeinsamem `PaperSource`-Interface und `NormalizedPaper`:
  arXiv (Atom-API + RSS), Europe PMC (REST), Crossref (DOI-Lookup, Batch per Filter),
  OpenAlex (nur Einzelabrufe, Credit-Protokoll).
- Rate-Limiter pro Quelle (Mindestabstand, Parallelität, `Retry-After`-Pausen),
  HTTP-Client mit eigenem User-Agent, Backoff und Fehlerklassen.
- Lizenzprüfung für Abstracts (`abstractLicenseOk`), Übersetzung der
  `websearch_to_tsquery`-Syntax in die Abfragesprachen der Quellen.
- `docs/DATA_SOURCES.md` mit live geprüften Endpunkten, Limits, Lizenzen und
  Attributionspflichten; echte API-Antworten als Fixtures unter `tests/fixtures/`.

- Projekt-Setup: SvelteKit (TypeScript strict, adapter-node), ESLint, Prettier,
  Vitest, Playwright, CI (GitHub Actions), docker-compose für PostgreSQL (Dev).
