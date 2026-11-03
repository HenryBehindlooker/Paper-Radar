# Mitmachen

Danke, dass du Paper-Radar verbessern möchtest! Beiträge jeder Größe sind willkommen –
Fehlerberichte, Übersetzungen, Dokumentation, Code.

## Entwicklungsumgebung

Siehe „Schnellstart für die Entwicklung“ in der [README](README.md). Kurz:

```bash
cp .env.example .env
docker compose -f docker-compose.dev.yml up -d
npm install
npm run db:migrate
npm run dev        # und in einem zweiten Terminal: npm run worker
```

## Vor einem Pull Request

```bash
npm run lint       # Prettier, ESLint, svelte-check (TypeScript strict)
npm test           # Unit- und Integrationstests (TEST_DATABASE_URL aus .env)
npm run test:e2e   # E2E-Tests (PostgreSQL und Mailpit müssen laufen)
```

Alle drei müssen grün sein; die CI prüft dasselbe und baut zusätzlich das Docker-Image.

## Leitlinien

- **Datenquellen respektieren.** Neue Quellen oder Endpunkte nur nach Lektüre von Doku und
  Nutzungsbedingungen; Ergebnisse (Endpunkte, Limits, Lizenz, Attribution) in
  [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) festhalten und echte Antworten als Fixtures unter
  `tests/fixtures/` ablegen. Jede Quelle bekommt einen eigenen Rate-Limiter.
- **Nutzeraktionen lösen nie direkte Upstream-Aufrufe aus** – sie reihen Jobs ein.
- **Nur Metadaten und Links** – keine PDFs herunterladen oder spiegeln.
- **Datenschutz:** keine neuen personenbezogenen Daten, kein Tracking, keine Ressourcen von
  Drittanbietern (Schriften, Skripte, Bilder) in der Oberfläche.
- **Reine Funktionen** für Logik (Parsing, Ranking, BibTeX, Feeds) und Tests dazu; Datenbank-
  Logik mit Integrationstests gegen echte PostgreSQL.
- **Texte** der Oberfläche gehören nach `src/lib/i18n/` (Standardsprache Deutsch).
- **Schemaänderungen** in `src/lib/server/db/schema.ts`, Migration mit `npm run db:generate`
  erzeugen und mitcommitten.
- **Abhängigkeiten** nur in Versionen, die mindestens zwei Wochen alt sind; Versionen exakt
  pinnen.

## Lizenz

Mit deinem Beitrag stimmst du zu, dass er unter der
[GNU Affero General Public License v3.0](LICENSE) veröffentlicht wird.
