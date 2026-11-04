# Paper-Radar – Produktbeschreibung

> Neue wissenschaftliche Paper zu den eigenen Themen, täglich und nachvollziehbar gerankt.
> Ohne Tracking, ohne Algorithmus-Blase, als freie Software zum Selbsthosten.

Stand: Version 0.1.0 (November 2026). Technische Details stehen in
[ARCHITECTURE.md](ARCHITECTURE.md), Datenquellen in [DATA_SOURCES.md](DATA_SOURCES.md),
Installation und Betrieb in der [README](../README.md).

## Problem

Wer in der Forschung auf dem Laufenden bleiben will, hat heute schlechte Optionen:

- **Zu viel:** arXiv allein veröffentlicht jeden Werktag Hunderte Paper. Kategorien-Listen
  und Mail-Alerts der Quellen sind ungefiltert und nicht über Quellen hinweg zusammengeführt.
- **Zu undurchsichtig:** Empfehlungsdienste ranken nach unbekannten Kriterien, verstärken das,
  was man schon kennt, und finanzieren sich über Nutzungsdaten.
- **Zu verstreut:** Preprint, Verlagsversion und PubMed-Eintrag desselben Papers tauchen
  getrennt auf, jeweils in einem anderen Werkzeug.

## Lösung

Paper-Radar sammelt neue Paper aus offenen Quellen, führt Dubletten zusammen und zeigt jeder
Person einen persönlichen Feed. Jedes Paper erscheint nur einmal, und jede Platzierung ist
mit **„Warum sehe ich das?“** erklärt.

## Zielgruppe

- **Forschende und Promovierende**, die ein Fachgebiet, bestimmte Methoden oder Arbeitsgruppen
  verfolgen.
- **Arbeitsgruppen, Institute und Bibliotheken**, die einen gemeinsamen, datenschutzfreundlichen
  Dienst für ihre Mitglieder betreiben wollen.
- **Wissenschaftsinteressierte und Fachjournalist:innen**, die Themen über Fachgrenzen hinweg
  beobachten.

## Produktprinzipien

1. **Transparenz statt Blackbox.** Das Ranking ist eine offengelegte Formel. Jede Person
   sieht, welches Abo, welches Stichwort und welcher Boost ein Paper nach oben gebracht hat.
2. **Kontrolle bei den Nutzer:innen.** Nur die eigenen Abos und Gewichte bestimmen den Feed.
   Es gibt kein Lernen aus Klicks und keine Verstärkung von Vorlieben.
3. **Datensparsamkeit.** Gespeichert wird nur die E-Mail-Adresse. Es gibt kein Tracking,
   keine Drittanbieter-Ressourcen und keine Zugriffs-Logs. Das Konto ist jederzeit vollständig
   löschbar.
4. **Fairness gegenüber den Quellen.** Abfragen laufen zentral, dedupliziert und innerhalb
   der Rate-Limits. Es werden nur Metadaten und Links gespeichert, keine PDFs. Lizenzen und
   Attributionspflichten werden eingehalten.
5. **Offenheit.** Freie Software unter AGPL-3.0, selbst betreibbar mit einem einzigen
   `docker compose up`.

## Funktionen

### Abonnieren

- **Stichwörter** mit Websuche-Syntax: `"exakte Phrase"`, `or`, `-ausschließen`.
- **arXiv-Kategorien** aus einer Auswahlliste der offiziellen Taxonomie.
- **Autor:innen** nach Name oder ORCID.
- **Gewicht je Abo:** Wichtige Themen ranken höher.
- **Sofort Inhalte:** Ein neues Abo lädt die Paper der letzten 30 Tage nach. Den Fortschritt
  zeigt die Seite live.

### Lesen

- **Täglicher Feed** mit Titel, Autor:innen, Abstract (sofern die Lizenz es erlaubt),
  Quelle und Zitationszahl.
- **„Warum sehe ich das?“** listet zu jedem Paper die passenden Abos und den Score-Anteil.
- **Aktionen:** gelesen, merken, ausblenden. Sie funktionieren auch ohne JavaScript.
- **Filter und Sortierung:** nach Relevanz oder „Häufig zitiert“.
- **Suche** über alle bereits gesammelten Paper.
- **Detailseite** mit Links zu arXiv, DOI, Europe PMC, PubMed und OpenAlex. PDFs sind nur
  verlinkt.
- **Merkliste** mit **BibTeX-Export**, auch für einzelne Paper.

### Mitnehmen

- **Persönlicher RSS- und Atom-Feed** unter einer geheimen URL, die sich jederzeit neu erzeugen
  lässt. Zusätzlich gibt es einen Feed je Abo.
- **OPML-Export** aller Feeds für den eigenen Feedreader.
- **Wochen-Mail** (Opt-in, montags 7 Uhr) mit den zehn wichtigsten Papern der Woche samt
  Begründung, ohne Tracking-Pixel. Abmelden geht mit einem Klick, auch direkt aus dem
  Mailprogramm.

### Konto

- **Anmeldung per Magic-Link:** Es gibt keine Passwörter.
- **Konto löschen** entfernt sofort Abos, Treffer, Merkliste und E-Mail-Adresse.
- **Oberfläche:** auf Deutsch (übersetzbar), für Handys optimiert, mit Hell- und Dunkelmodus.

## So entsteht das Ranking

```
Score = (Textrelevanz × Abo-Gewicht + 0,6 × Autor-Boost + 0,3 × Kategorie-Boost)
        × 0,5 ^ (Alter in Tagen / Halbwertszeit)
```

- **Textrelevanz:** Volltextsuche über Titel (stärker gewichtet) und Abstract.
- **Boosts:** Paper von abonnierten Autor:innen und aus abonnierten Kategorien steigen.
- **Aktualität:** Der Score halbiert sich standardmäßig alle 7 Tage. Die Halbwertszeit ist pro
  Instanz einstellbar.

Die Formel steht auch auf der Über-Seite jeder Instanz.

## Datenquellen

| Quelle                               | Rolle                                              | Takt                       |
| ------------------------------------ | -------------------------------------------------- | -------------------------- |
| [arXiv](https://arxiv.org)           | Preprints aus Physik, Mathematik, Informatik u. a. | werktäglich + Abo-Anfragen |
| [Europe PMC](https://europepmc.org)  | Lebenswissenschaften inkl. Preprints und PubMed    | täglich                    |
| [Crossref](https://www.crossref.org) | Ergänzung der Metadaten über die DOI               | täglich                    |
| [OpenAlex](https://openalex.org)     | Zitationszahlen und Autoren-IDs (nur Anreicherung) | wöchentlich, mit Budget    |

Gleiche Abos mehrerer Personen werden nur einmal abgefragt. Fällt eine Quelle aus, laufen die
anderen weiter. Der Status jeder Quelle ist unter `/api/health` sichtbar.

## Betriebsmodell

- **Selbst hosten:** Ein Server mit Docker, eine Domain und ein SMTP-Zugang genügen. HTTPS,
  Datenbank-Migrationen und nächtliche Backups laufen automatisch.
- **Typische Betreiber:** Einzelpersonen, Arbeitsgruppen, Institute und Bibliotheken.
- **Kosten:** keine Lizenzkosten. Alle Datenquellen sind kostenlos nutzbar; OpenAlex braucht
  einen kostenlosen API-Key.
- **Lizenzpflicht:** Wer eine geänderte Version als Dienst anbietet, muss den Quellcode der
  Änderungen den Nutzer:innen zugänglich machen (AGPL-3.0).

## Nicht-Ziele

- **Kein PDF-Archiv und kein Volltext-Spiegel:** Paper-Radar verweist auf die Originale.
- **Keine Empfehlungen aus Nutzungsverhalten:** Es gibt kein Profiling und kein A/B-Testing.
- **Kein soziales Netzwerk:** keine Kommentare, Likes oder öffentlichen Profile.
- **Kein zentraler Dienst des Projekts:** Jede Instanz ist eigenständig.

## Status und Ausblick

**Version 0.1.0** bringt den kompletten Kern:

- Abos, Feed, Suche und Merkliste
- RSS, Atom und OPML
- die Wochen-Mail
- vier Datenquellen
- Docker-Betrieb mit Backups und Gesundheitsstatus

**Vor dem Produktivbetrieb:**

- `CONTACT_EMAIL` setzen. Die Adresse ist der Kontakt für die Datenquellen und Voraussetzung
  für den Crossref-„Polite Pool“.
- Den OpenAlex-API-Key eintragen und einmal live prüfen.
- Die Nutzungsbedingungen von Europe PMC einmal manuell im Browser lesen.

**Als Nächstes möglich:**

- **Semantisches Ranking:** Opt-in, mit pgvector und Embeddings. Es findet verwandte Arbeiten
  auch ohne passendes Stichwort.
- **Weitere Quellen:** z. B. PubMed E-Utilities und DOAJ.
- **Formeldarstellung:** in Titeln und Abstracts, z. B. mit KaTeX.
- **Weitere Sprachen:** Die Oberfläche ist bereits für Übersetzungen vorbereitet.
- **SvelteKit 3:** Umstieg, sobald Auth.js es unterstützt.
