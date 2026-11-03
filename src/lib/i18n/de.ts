/** Deutsche UI-Texte (Standardsprache). Weitere Sprachen implementieren dasselbe Schema. */
export const de = {
	'app.name': 'Paper-Radar',
	'app.tagline':
		'Neue wissenschaftliche Paper zu deinen Themen – täglich, ohne Tracking, ohne Algorithmus-Blase.',
	'nav.feed': 'Feed',
	'nav.about': 'Über',
	'footer.license': 'Freie Software unter der AGPL-3.0.',
	'footer.source': 'Quellcode',
	'home.comingSoon':
		'Im Aufbau. Bald kannst du hier Themen, arXiv-Kategorien und Autoren abonnieren.'
} as const;

export type MessageKey = keyof typeof de;
export type Messages = Record<MessageKey, string>;
