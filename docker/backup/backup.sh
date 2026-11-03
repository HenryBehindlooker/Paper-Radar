#!/bin/sh
# Nächtliches Backup: pg_dump im Custom-Format nach /backups, ältere als BACKUP_KEEP_DAYS löschen.
set -eu
# Backups enthalten personenbezogene Daten (E-Mail-Adressen): nur für den Besitzer lesbar.
umask 077
. /etc/paper-radar-backup.env
stamp=$(date -u +%Y%m%d-%H%M%S)
file="/backups/paperradar-${stamp}.dump"
tmp="${file}.partial"
echo "$(date -u +%FT%TZ) Backup startet: ${file}"
pg_dump --format=custom --no-owner --file="${tmp}" "${DATABASE_URL}"
mv "${tmp}" "${file}"
find /backups -name 'paperradar-*.dump' -type f -mtime "+${BACKUP_KEEP_DAYS:-14}" -print -delete
echo "$(date -u +%FT%TZ) Backup fertig: $(du -h "${file}" | cut -f1)"
