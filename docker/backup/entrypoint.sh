#!/bin/sh
# Startet crond für das nächtliche Backup (Zeitplan: BACKUP_SCHEDULE, Standard 02:30 Uhr UTC).
set -eu
umask 077
{
	echo "export DATABASE_URL='${DATABASE_URL}'"
	echo "export BACKUP_KEEP_DAYS='${BACKUP_KEEP_DAYS:-14}'"
} > /etc/paper-radar-backup.env
echo "${BACKUP_SCHEDULE:-30 2 * * *} /usr/local/bin/paper-radar-backup >> /proc/1/fd/1 2>&1" > /etc/crontabs/root
if [ "${BACKUP_ON_START:-false}" = "true" ]; then /usr/local/bin/paper-radar-backup; fi
echo "Backup-Dienst bereit (Zeitplan: ${BACKUP_SCHEDULE:-30 2 * * *}, Aufbewahrung: ${BACKUP_KEEP_DAYS:-14} Tage)"
exec crond -f -l 8
