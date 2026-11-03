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

Voraussetzungen: Node.js ≥ 22, Docker (für PostgreSQL).

```bash
cp .env.example .env
docker compose -f docker-compose.dev.yml up -d
npm install
npm run dev
```

## Entwicklung

| Befehl             | Zweck                                     |
| ------------------ | ----------------------------------------- |
| `npm run dev`      | Dev-Server                                |
| `npm run lint`     | Prettier-Check, ESLint, svelte-check (TS) |
| `npm test`         | Unit-Tests (Vitest)                       |
| `npm run test:e2e` | E2E-Smoke-Tests (Playwright)              |
| `npm run format`   | Code formatieren                          |

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
