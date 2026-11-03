#!/bin/sh
# Stellt ein Backup vollständig wieder her: Datenbank neu anlegen, Dump einspielen.
# ACHTUNG: überschreibt alle aktuellen Daten. Vorher App und Worker stoppen:
#   docker compose stop app worker
#   docker compose exec backup paper-radar-restore /backups/paperradar-YYYYMMDD-HHMMSS.dump
#   docker compose start app worker
set -eu
file="${1:-}"
if [ -z "$file" ] || [ ! -f "$file" ]; then
	echo "Aufruf: paper-radar-restore /backups/paperradar-YYYYMMDD-HHMMSS.dump" >&2
	ls -1t /backups/paperradar-*.dump 2>/dev/null | head -5 >&2 || true
	exit 2
fi
db=$(echo "$DATABASE_URL" | sed -E 's#^.*/([^/?]+)(\?.*)?$#\1#')
admin=$(echo "$DATABASE_URL" | sed -E 's#/[^/?]+(\?.*)?$#/postgres\1#')
echo "$(date -u +%FT%TZ) Stelle ${file} in Datenbank „${db}“ wieder her …"
psql -v ON_ERROR_STOP=1 -q "$admin" -c "DROP DATABASE IF EXISTS \"${db}\" WITH (FORCE)" -c "CREATE DATABASE \"${db}\""
pg_restore --no-owner --exit-on-error -d "$DATABASE_URL" "$file"
echo "$(date -u +%FT%TZ) Wiederherstellung abgeschlossen."
