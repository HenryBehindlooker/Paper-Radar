#!/bin/sh
# Legt die Testdatenbank für die Integrationstests an (nur beim ersten Start des Volumes).
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE DATABASE ${POSTGRES_DB}_test OWNER "$POSTGRES_USER";
SQL
