#!/bin/sh
# Copies the one-time setup code to the VM's serial console, so an owner can read it from the cloud
# console (AWS "Get system log", Azure serial console) without SSH. polynovea-console-code.service
# feeds it the CMS's log lines:
#
#   journalctl --follow --lines=0 --output=cat SYSLOG_IDENTIFIER=polynovea | console-code.sh
#
# Limits (owner's decision, Phase 5):
# - only the setup-code line, nothing else from the log, and no other secret;
# - only while /api/health says the CMS is in setup mode. Once setup is finished it writes nothing,
#   and if the CMS cannot be asked, it writes nothing (fail closed);
# - the code is single-use and expires after an hour, but anyone in the cloud account who can read
#   console output can see it until setup is finished (docs/self-hosting/setup/setup-code.md).
#
# Environment (tests): POLYNOVEA_CONSOLE (default /dev/console), POLYNOVEA_HEALTH_URL
# (default http://127.0.0.1:3000/api/health), POLYNOVEA_HEALTH_WAIT (seconds, default 90).
set -u

CONSOLE="${POLYNOVEA_CONSOLE:-/dev/console}"
HEALTH_URL="${POLYNOVEA_HEALTH_URL:-http://127.0.0.1:3000/api/health}"
WAIT="${POLYNOVEA_HEALTH_WAIT:-90}"

# The code is printed while the server starts, before it answers; wait for its answer.
in_setup_mode() {
  waited=0
  while [ "$waited" -le "$WAIT" ]; do
    state="$(curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null | sed -n 's/.*"state" *: *"\([a-z]*\)".*/\1/p')"
    case "$state" in
      setup) return 0 ;;
      running | unavailable) return 1 ;;
    esac
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}

while IFS= read -r line; do
  # Exactly the CMS's setup-code line; the code itself is Crockford base32 in groups.
  code="$(printf '%s\n' "$line" | sed -n 's/^\[setup\] Setup code: \([A-Za-z0-9-]\{16,80\}\)  *(works once.*$/\1/p')"
  [ -n "$code" ] || continue
  if in_setup_mode; then
    printf 'Polynovea CMS setup code: %s (works once, for 1 hour; a restart issues a new one)\n' "$code" >"$CONSOLE"
  fi
done
