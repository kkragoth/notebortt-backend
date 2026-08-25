#!/bin/sh
# Postgres logical backup (P6.2). Writes a gzipped custom-format dump into
# BACKUP_DIR (default ./backups). Run via the compose `backup` profile:
#   docker compose --profile backup run --rm pg-backup
set -eu

BACKUP_DIR="${BACKUP_DIR:-./backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

mkdir -p "$BACKUP_DIR"
OUT="$BACKUP_DIR/pg-$STAMP.dump"

PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
    -h "${POSTGRES_HOST:-postgres}" \
    -U "${POSTGRES_USER:-notecanva}" \
    -d "${POSTGRES_DB:-notecanva}" \
    -Fc \
    -f "$OUT"

echo "wrote $OUT"

# Bound local retention so the disk cannot fill silently.
find "$BACKUP_DIR" -name 'pg-*.dump' -mtime "+$RETENTION_DAYS" -delete
