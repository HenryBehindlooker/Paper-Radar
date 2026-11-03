# Changelog

Alle nennenswerten Änderungen werden hier dokumentiert.
Format angelehnt an [Keep a Changelog](https://keepachangelog.com/de/1.1.0/).

## [Unreleased]

### Hinzugefügt

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
