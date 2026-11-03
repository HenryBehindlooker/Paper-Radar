/** Deutsche UI-Texte (Standardsprache). Weitere Sprachen implementieren dasselbe Schema. */
export const de = {
	'app.name': 'Paper-Radar',
	'app.tagline':
		'Neue wissenschaftliche Paper zu deinen Themen – täglich, ohne Tracking, ohne Algorithmus-Blase.',
	'nav.feed': 'Feed',
	'nav.search': 'Suche',
	'nav.saved': 'Merkliste',
	'nav.subscriptions': 'Abos',
	'nav.account': 'Konto',
	'nav.about': 'Über',
	'nav.login': 'Anmelden',
	'nav.logout': 'Abmelden',
	'footer.license': 'Freie Software unter der AGPL-3.0.',
	'footer.source': 'Quellcode',
	'footer.data':
		'Metadaten von arXiv, Europe PMC (EMBL-EBI), Crossref und OpenAlex. Paper-Radar ist ein unabhängiges Projekt und wird von keiner dieser Quellen betrieben oder empfohlen.',
	'footer.about': 'Über & Datenschutz',
	'theme.label': 'Farbschema',
	'theme.auto': 'Automatisch',
	'theme.light': 'Hell',
	'theme.dark': 'Dunkel',
	'home.cta': 'Jetzt anmelden und Themen abonnieren',
	'home.toSubscriptions': 'Zu deinen Abos',
	'home.accountDeleted': 'Dein Konto und alle zugehörigen Daten wurden gelöscht.',

	'feed.title': 'Neu für dich',
	'feed.filter.label': 'Anzeigen',
	'feed.filter.alle': 'Alle',
	'feed.filter.ungelesen': 'Ungelesen',
	'feed.filter.ausgeblendet': 'Ausgeblendet',
	'feed.emptyFilter': 'Keine Einträge für diesen Filter.',
	'pager.prev': 'Neuere',
	'pager.next': 'Ältere',
	'pager.more': 'Weitere Ergebnisse',

	'card.abstract': 'Abstract',
	'card.noAbstract': 'Kein Abstract anzeigbar (Lizenz unbekannt oder nicht offen).',
	'card.markSeen': 'Gelesen',
	'card.markUnseen': 'Als ungelesen markieren',
	'card.save': 'Merken',
	'card.unsave': 'Gemerkt',
	'card.hide': 'Ausblenden',
	'card.unhide': 'Wieder einblenden',
	'card.open': 'Zur Quelle',
	'card.details': 'Details',
	'card.citations': '{n} Zitationen',

	'search.title': 'Suche',
	'search.label': 'In allen gespeicherten Papern suchen',
	'search.help': 'Wörter werden UND-verknüpft; "Phrase", or, -ausschließen.',
	'search.submit': 'Suchen',
	'search.empty': 'Keine Treffer für „{q}“.',
	'search.results': 'Ergebnisse für „{q}“',

	'saved.title': 'Merkliste',
	'saved.empty': 'Noch nichts gemerkt. Über „Merken“ an einem Paper landet es hier.',
	'saved.export': 'Merkliste als BibTeX exportieren',

	'paper.authors': 'Autor:innen',
	'paper.published': 'Veröffentlicht',
	'paper.journal': 'Erschienen in',
	'paper.categories': 'Kategorien',
	'paper.sources': 'Quellen',
	'paper.links': 'Links',
	'paper.pdfNote': 'PDF-Links verweisen auf die Quelle; Paper-Radar speichert keine PDFs.',
	'paper.bibtex': 'BibTeX herunterladen',
	'paper.back': 'Zurück zum Feed',
	'feed.empty':
		'Noch keine Treffer. Neue Paper zu deinen Abos erscheinen hier, sobald sie eingelesen und zugeordnet sind.',
	'feed.noSubscriptions': 'Lege zuerst ein Abo an, damit hier passende Paper erscheinen.',
	'feed.why': 'Warum sehe ich das?',
	'feed.moreAuthors': 'u. a.',
	'feed.score': 'Relevanz',

	'login.title': 'Anmelden',
	'login.intro':
		'Gib deine E-Mail-Adresse ein. Du bekommst einen Anmeldelink – ohne Passwort. Neue Konten werden dabei automatisch angelegt.',
	'login.email': 'E-Mail-Adresse',
	'login.submit': 'Anmeldelink senden',
	'login.privacy':
		'Wir speichern nur deine E-Mail-Adresse. Kein Tracking, keine Weitergabe; dein Konto kannst du jederzeit löschen.',
	'login.sent.title': 'Prüfe dein Postfach',
	'login.sent.text':
		'Falls die Adresse gültig ist, haben wir dir einen Anmeldelink geschickt. Er ist eine Stunde gültig und funktioniert nur einmal.',
	'login.sent.spam':
		'Nichts angekommen? Schau im Spam-Ordner nach oder fordere den Link erneut an.',
	'login.again': 'Erneut anfordern',
	'login.error.title': 'Anmeldung fehlgeschlagen',
	'login.error.Verification':
		'Der Anmeldelink ist abgelaufen oder wurde bereits benutzt. Bitte fordere einen neuen an.',
	'login.error.Configuration':
		'Die Anmeldung ist auf diesem Server nicht richtig eingerichtet. Bitte versuche es später erneut.',
	'login.error.default': 'Bei der Anmeldung ist ein Fehler aufgetreten. Bitte versuche es erneut.',

	'subs.title': 'Deine Abos',
	'subs.intro':
		'Abonniere Stichwörter, arXiv-Kategorien oder Autor:innen. Neue Abos laden automatisch die Paper der letzten 30 Tage nach.',
	'subs.empty': 'Du hast noch keine Abos.',
	'subs.add': 'Abo hinzufügen',
	'subs.type': 'Art',
	'subs.type.keyword': 'Stichwort',
	'subs.type.category': 'arXiv-Kategorie',
	'subs.type.author': 'Autor:in',
	'subs.query.keyword': 'Suchbegriffe',
	'subs.query.keyword.help':
		'Wörter werden UND-verknüpft. "Phrase in Anführungszeichen", or für Alternativen, -wort zum Ausschließen.',
	'subs.query.category': 'Kategorie',
	'subs.query.category.choose': 'Kategorie wählen …',
	'subs.query.author': 'Name oder ORCID',
	'subs.query.author.help': 'z. B. „Rui Yang“, „Yang, Rui“ oder 0000-0002-1825-0097',
	'subs.weight': 'Gewicht',
	'subs.weight.0.5': 'weniger',
	'subs.weight.1': 'normal',
	'subs.weight.2': 'mehr',
	'subs.weight.3': 'viel mehr',
	'subs.remove': 'Entfernen',
	'subs.remove.confirm': 'Abo „{query}“ entfernen?',
	'subs.status.pending': 'Nachladen eingeplant …',
	'subs.status.running': 'Lädt Paper der letzten 30 Tage …',
	'subs.status.done': 'Aktiv',
	'subs.status.failed': 'Nachladen fehlgeschlagen – wird automatisch erneut versucht',
	'subs.shared': 'auch von {n} weiteren Konten abonniert',
	'subs.added': 'Abo hinzugefügt.',

	'account.title': 'Dein Konto',
	'account.email': 'Angemeldet als',
	'account.stored':
		'Gespeichert sind: deine E-Mail-Adresse, deine Abos sowie deine Treffer, Merkliste und Gelesen-Markierungen. Sonst nichts.',
	'account.delete.title': 'Konto löschen',
	'account.delete.text':
		'Löscht sofort und unwiderruflich dein Konto mit allen Abos, Treffern und deiner Merkliste.',
	'account.delete.confirm': 'Zur Bestätigung deine E-Mail-Adresse eingeben',
	'account.delete.submit': 'Konto endgültig löschen',
	'account.delete.mismatch': 'Die eingegebene Adresse stimmt nicht überein.'
} as const;

export type MessageKey = keyof typeof de;
export type Messages = Record<MessageKey, string>;
