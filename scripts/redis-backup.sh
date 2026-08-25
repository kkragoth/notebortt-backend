#!/bin/sh
# Redis backup (P6.2): triggers BGSAVE inside each redis instance and copies
# the resulting RDB snapshot into the shared ./backups mount (mounted into
# both redis containers). Run from the host:
#   ./scripts/redis-backup.sh
#
# Recovery window note: AOF (everysec) + these snapshots bound data loss to
# at most ~1s of acknowledged writes; see DEPLOY.md.
set -eu

STAMP="$(date +%Y%m%d-%H%M%S)"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

mkdir -p backups

for INSTANCE in redis-realtime redis-jobs; do
    docker compose exec -T "$INSTANCE" redis-cli BGSAVE >/dev/null
    # BGSAVE is async; wait for the child to finish.
    while ! docker compose exec -T "$INSTANCE" redis-cli INFO persistence | grep -q '^rdb_bgsave_in_progress:0'; do
        sleep 1
    done
    docker compose exec -T "$INSTANCE" cp /data/dump.rdb "/backups/$INSTANCE-$STAMP.rdb"
    echo "wrote backups/$INSTANCE-$STAMP.rdb"
done

find backups -name 'redis-*-*.rdb' -mtime "+$RETENTION_DAYS" -delete
