#!/bin/sh
# The bundled PostgreSQL 16 for "On this server" (lib/setup/database/localServerImage.ts).
#
#   local-db.sh start     create the cluster on first use, then start it (waits until it accepts connections)
#   local-db.sh stop      fast shutdown, if running
#   local-db.sh status    exit 0 when running
#   local-db.sh exists    exit 0 when the cluster has been created
#
# Runs as the image's own user (polynovea, uid 10001); PostgreSQL runs as that user too.
# The cluster lives on the data disk. It listens on 127.0.0.1 and a private unix socket only.
set -eu

PGBIN=/usr/lib/postgresql/16/bin
# Fixed, with no override: the wizard (localServerImage.ts), entrypoint.mjs and the archive_command
# below must all agree on it, and a fixed path cannot carry shell syntax into archive_command.
DATA_ROOT=/var/lib/polynovea
PGDATA="$DATA_ROOT/postgresql"
SOCKET_DIR=/var/run/postgresql
LOG_DIR="$DATA_ROOT/log"
PGBACKREST_CONFIG="$DATA_ROOT/etc/pgbackrest.conf"
PORT=5432
OS_USER="$(id -un)"

say() { printf '[local-db] %s\n' "$*" >&2; }

create_cluster() {
  umask 077
  mkdir -p "$PGDATA" "$LOG_DIR/pgbackrest" "$LOG_DIR/postgresql" "$DATA_ROOT/etc"
  if [ -n "$(ls -A "$PGDATA" 2>/dev/null)" ]; then
    say "$PGDATA is not empty but holds no cluster; refusing to touch it."
    exit 1
  fi
  say "Creating the database cluster in $PGDATA"
  "$PGBIN/initdb" --pgdata="$PGDATA" --username=postgres --auth-local=peer --auth-host=reject \
    --encoding=UTF8 --locale=C.UTF-8 --data-checksums >/dev/null

  # Who may connect, and how. Anything not listed is rejected.
  # - postgres (superuser): unix socket only, only for this image's OS user (peer + map). No password exists.
  # - polynovea_owner / polynovea_app: the polynovea database only, from 127.0.0.1 only, SCRAM only.
  cat >"$PGDATA/pg_hba.conf" <<EOF
# Written by local-db.sh (Polynovea server image).
local   all        postgres                          peer map=image
host    polynovea  polynovea_owner,polynovea_app  127.0.0.1/32  scram-sha-256
local   all        all                               reject
host    all        all          0.0.0.0/0            reject
host    all        all          ::/0                 reject
EOF
  cat >"$PGDATA/pg_ident.conf" <<EOF
# Written by local-db.sh: this image's OS user is the local administrator.
image   $OS_USER   postgres
EOF

  cat >>"$PGDATA/postgresql.conf" <<EOF

# --- Polynovea server image (local-db.sh) ---
listen_addresses = '127.0.0.1'
port = $PORT
unix_socket_directories = '$SOCKET_DIR'
unix_socket_permissions = 0700
password_encryption = scram-sha-256
ssl = off
wal_level = replica
archive_mode = on
archive_command = 'pgbackrest --config="$PGBACKREST_CONFIG" --log-path="$LOG_DIR/pgbackrest" --lock-path=/tmp/pgbackrest --stanza=polynovea archive-push "%p"'
archive_timeout = 300
max_wal_senders = 3
# Logs on the data disk, one file per weekday, overwritten a week later (14 days is the CMS's own limit).
logging_collector = on
log_directory = '$LOG_DIR/postgresql'
log_filename = 'postgresql-%a.log'
log_truncate_on_rotation = on
log_rotation_age = 1d
log_rotation_size = 0
log_line_prefix = '%m [%p] %q%u@%d '
log_connections = on
log_disconnections = off
EOF
}

running() {
  "$PGBIN/pg_ctl" status --pgdata="$PGDATA" >/dev/null 2>&1
}

case "${1:-}" in
  exists)
    [ -f "$PGDATA/PG_VERSION" ]
    ;;
  start)
    [ -f "$PGDATA/PG_VERSION" ] || create_cluster
    if running; then
      exit 0
    fi
    mkdir -p "$LOG_DIR/postgresql"
    # Start-up messages before the log collector takes over go to startup.log. A stale pid file from a
    # container that was killed is handled by pg_ctl itself.
    "$PGBIN/pg_ctl" start --pgdata="$PGDATA" --wait --timeout=90 --log="$LOG_DIR/postgresql/startup.log" >/dev/null
    say "PostgreSQL is running (127.0.0.1:$PORT and $SOCKET_DIR)."
    ;;
  stop)
    if [ -f "$PGDATA/PG_VERSION" ] && running; then
      "$PGBIN/pg_ctl" stop --pgdata="$PGDATA" --mode=fast --wait --timeout=60 >/dev/null
      say "PostgreSQL stopped."
    fi
    ;;
  status)
    running
    ;;
  *)
    say "usage: local-db.sh start|stop|status|exists"
    exit 2
    ;;
esac
