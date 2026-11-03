# Paper-Radar

Abonniere Themen, arXiv-Kategorien und Autoren und bekomme täglich einen
nachvollziehbar gerankten Feed neuer wissenschaftlicher Paper – **ohne Tracking,
ohne Algorithmus-Blase**, mit eigenem RSS-Feed und Wochen-Mail.

> Status: in Entwicklung (Phase 0 – Setup). Abschnitte mit _TODO_ werden in
> späteren Phasen ergänzt.

## Features (geplant)

- Abos auf Stichwörter (Postgres-Websuche-Syntax), arXiv-Kategorien und Autor:innen (Name/ORCID)
- Täglicher Feed mit transparentem Ranking („Warum sehe ich das?“)
- Merkliste, Suche, BibTeX-Export
- Persönlicher RSS/Atom-Feed unter geheimer URL, OPML-Export, Wochen-Mail
- Quellen: arXiv, Europe PMC, Crossref, OpenAlex (nur Anreicherung)

## Quickstart (lokal)

Voraussetzungen: Node.js ≥ 22.12, PostgreSQL 16 (z. B. per Docker).

```bash
cp .env.example .env
docker compose -f docker-compose.dev.yml up -d   # PostgreSQL mit Dev- und Testdatenbank
npm install
npm run db:migrate                               # Schema anlegen
npm run worker                                   # Hintergrund-Jobs (separates Terminal)
npm run dev                                      # Web-App
```

## Entwicklung

| Befehl                   | Zweck                                                                |
| ------------------------ | -------------------------------------------------------------------- |
| `npm run dev`            | Dev-Server                                                           |
| `npm run worker`         | Worker-Prozess (pg-boss-Jobs, einziger Ort für Upstream-API-Aufrufe) |
| `npm run db:generate`    | Migration aus `src/lib/server/db/schema.ts` erzeugen                 |
| `npm run db:migrate`     | Migrationen anwenden (macht der Worker beim Start ebenfalls)         |
| `npm run job -- <queue>` | Job sofort einreihen, z. B. `ingest-arxiv-daily`, `backfill 42`      |
| `npm run lint`           | Prettier-Check, ESLint, svelte-check (TS)                            |
| `npm test`               | Unit- und Integrationstests (Vitest)                                 |
| `npm run test:e2e`       | E2E-Smoke-Tests (Playwright)                                         |
| `npm run test:live`      | Optional: Adapter einmal gegen die echten APIs                       |
| `npm run format`         | Code formatieren                                                     |

Die Integrationstests brauchen `TEST_DATABASE_URL` (siehe `.env.example`). Diese Datenbank
wird bei jedem Lauf **geleert**. Ohne die Variable werden die Integrationstests übersprungen.

### Projektstruktur

```
src/lib/server/sources/   Adapter je Quelle + Rate-Limiter
src/lib/server/db/        Schema, Migrationen (Drizzle)
src/lib/server/jobs/      pg-boss-Jobs
src/lib/server/ranking/   Matching, Scoring
src/lib/i18n/             UI-Texte (Deutsch, i18n-fähig)
src/routes/api/           JSON-Endpunkte
src/routes/feed/          RSS/Atom-Feeds
tests/fixtures/           Echte API-Antworten für Tests
docs/DATA_SOURCES.md      Endpunkte, Limits, Lizenzen der Quellen
```

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

  | Queue                  | Wann                  | Was                                                                              |
  | ---------------------- | --------------------- | -------------------------------------------------------------------------------- |
  | `ingest-queries-daily` | täglich 05:43         | Europe PMC (Keyword/Autor) und arXiv-API (Keyword/Autor) je dedupliziertem Query |
  | `ingest-arxiv-daily`   | Mo–Fr 07:17           | arXiv-RSS für alle abonnierten Kategorien (gebündelt)                            |
  | `backfill`             | bei neuem Abo         | letzte 30 Tage aus allen passenden Quellen                                       |
  | `enrich-crossref`      | nach Ingestion, 09:07 | Crossref-Ergänzung für noch nicht geprüfte DOIs (bis 20 pro Request)             |
  | `cleanup`              | täglich 03:27         | Paper ohne Treffer und älter als 180 Tage, Verwaistes, Protokoll > 90 Tage       |

- **Nutzeraktionen lösen nie direkte Upstream-Aufrufe aus.** Sie reihen höchstens einen Job
  ein. Gleiche Abos werden über `source_queries` nur einmal abgefragt.
- **Genau ein Worker:** Die Rate-Limiter gelten je Prozess. Starte deshalb nur einen
  Worker-Prozess. Die App sendet nur Jobs.
- **Fehlerisolation:** Fällt eine Quelle aus, landet das in `fetch_log` und
  `source_query_status`, die anderen laufen weiter. Das Zeitfenster rückt nur bei Erfolg vor.
  Der nächste Lauf holt Versäumtes nach (bis zu 30 Tage).

## Docker

_TODO (Phase 8)_

## Konfiguration

Alle Einstellungen erfolgen über Umgebungsvariablen, siehe [`.env.example`](.env.example).
Secrets gehören ausschließlich in `.env` (nicht im Repository).

## Datenquellen & Lizenzen

Siehe [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md). Paper-Radar speichert nur
Metadaten und Links – keine PDFs.

## Datenschutz

Gespeichert wird nur die E-Mail-Adresse (für Login und optionale Wochen-Mail).
Kein Tracking, keine Analyse-Dienste. Das Konto samt aller Daten ist jederzeit löschbar.

## Contributing

_TODO (Phase 8)_

## Lizenz

[GNU Affero General Public License v3.0](LICENSE)
