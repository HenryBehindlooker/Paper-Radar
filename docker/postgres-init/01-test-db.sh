#!/bin/sh
# Legt die Datenbanken für Integrationstests (_test) und E2E-Tests (_e2e) an
# (nur beim ersten Start des Volumes).
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE DATABASE ${POSTGRES_DB}_test OWNER "$POSTGRES_USER";
CREATE DATABASE ${POSTGRES_DB}_e2e OWNER "$POSTGRES_USER";
SQL
