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
BGSAVE_TIMEOUT_SECONDS="${BGSAVE_TIMEOUT_SECONDS:-60}"

mkdir -p backups

for INSTANCE in redis-realtime redis-jobs; do
    reply="$(docker compose exec -T "$INSTANCE" redis-cli BGSAVE)"
    # redis-cli exits 0 even when the server refuses the save, so the reply
    # text is what tells success from failure.
    case "$reply" in
        "Background saving started"|"Background saving scheduled") ;;
        *)
            echo "redis-backup: $INSTANCE refused BGSAVE: $reply" >&2
            exit 1
            ;;
    esac

    # Wait for the child to finish, with a deadline so a stuck bgsave cannot
    # hang an unattended backup run forever.
    waited=0
    while :; do
        info="$(docker compose exec -T "$INSTANCE" redis-cli INFO persistence)"
        in_progress="$(printf '%s\n' "$info" | sed -n 's/^rdb_bgsave_in_progress://p' | tr -d '\r')"
        last_status="$(printf '%s\n' "$info" | sed -n 's/^rdb_last_bgsave_status://p' | tr -d '\r')"
        if [ "$in_progress" = "0" ]; then
            break
        fi
        if [ "$waited" -ge "$BGSAVE_TIMEOUT_SECONDS" ]; then
            echo "redis-backup: $INSTANCE bgsave still running after ${waited}s" >&2
            exit 1
        fi
        waited=$((waited + 1))
        sleep 1
    done

    # A finished-but-failed save must not be stamped as a fresh snapshot.
    if [ "$last_status" != "ok" ]; then
        echo "redis-backup: $INSTANCE last bgsave status: $last_status" >&2
        exit 1
    fi

    # Never copy a missing/empty dump under today's stamp.
    docker compose exec -T "$INSTANCE" sh -c 'test -s /data/dump.rdb'

    docker compose exec -T "$INSTANCE" cp /data/dump.rdb "/backups/$INSTANCE-$STAMP.rdb"
    echo "wrote backups/$INSTANCE-$STAMP.rdb"
done

find backups -name 'redis-*-*.rdb' -mtime "+$RETENTION_DAYS" -delete
