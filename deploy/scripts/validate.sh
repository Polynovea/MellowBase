#!/usr/bin/env bash
# Validates the deploy/ templates offline. Nothing is deployed and no cloud account is used: every
# tool runs in a throwaway container with no credentials. Network access is only for pulling the tool
# images, OpenTofu providers and the Bicep compiler.
#
#   bash deploy/scripts/validate.sh            # everything
#   bash deploy/scripts/validate.sh bicep      # one of: cfn bicep tofu shellcheck checkov
#
# On a shared laptop it takes the heavy-job lock ($LOCALAPPDATA/polynovea-heavy.lock) first and always
# releases it, removing its containers.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY="$ROOT/deploy"
LANE="${POLYNOVEA_LOCK_LANE:-p5-w2}"
PREFIX="polynovea-validate-$$"
TOFU_VERSION="${TOFU_VERSION:-1.13.10}"
STEPS=("${@:-cfn bicep tofu shellcheck checkov}")
STEPS=(${STEPS[*]})

# Docker Desktop's tools may be missing from PATH in Git Bash.
if ! command -v docker >/dev/null 2>&1 && [ -x "/c/Program Files/Docker/Docker/resources/bin/docker" ]; then
  export PATH="/c/Program Files/Docker/Docker/resources/bin:$PATH"
fi
command -v docker >/dev/null || { echo "docker is required" >&2; exit 2; }

# Paths as Docker sees them (Git Bash on Windows rewrites /c/... unless told not to).
export MSYS_NO_PATHCONV=1
MOUNT="$DEPLOY"
if command -v cygpath >/dev/null 2>&1; then MOUNT="$(cygpath -w "$DEPLOY")"; fi

# ---------------------------------------------------------------- heavy-job lock
LOCK_BASE="${LOCALAPPDATA:-${TMPDIR:-/tmp}}"
if command -v cygpath >/dev/null 2>&1 && [ -n "${LOCALAPPDATA:-}" ]; then LOCK_BASE="$(cygpath -u "$LOCALAPPDATA")"; fi
LOCK="$LOCK_BASE/polynovea-heavy.lock"
HAVE_LOCK=0

release() {
  docker ps -aq --filter "name=$PREFIX" | xargs -r docker rm -f >/dev/null 2>&1 || true
  if [ "$HAVE_LOCK" = 1 ]; then rm -rf "$LOCK"; echo "lock released"; fi
}
trap release EXIT
trap 'exit 130' INT TERM

if [ "${POLYNOVEA_SKIP_LOCK:-0}" != 1 ]; then
  until mkdir "$LOCK" 2>/dev/null; do
    echo "waiting for the heavy-job lock: $(cat "$LOCK/owner.json" 2>/dev/null || echo '(no owner yet)')"
    sleep 30
  done
  HAVE_LOCK=1
  printf '{"lane":"%s","pid":%s,"started":"%s"}\n' "$LANE" "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LOCK/owner.json"
  echo "lock taken ($LANE, pid $$)"
fi

run() { # run NAME [--entrypoint X] IMAGE CMD...
  local name="$1"; shift
  local extra=()
  if [ "$1" = "--entrypoint" ]; then extra=(--entrypoint "$2"); shift 2; fi
  docker run --rm --name "$PREFIX-$name" --memory 2g --cpus 2 -v "$MOUNT:/deploy" -w /deploy "${extra[@]}" "$@"
}

FAILED=()
step() { # step LABEL CMD...
  local label="$1"; shift
  echo; echo "=== $label"
  if "$@"; then echo "--- $label: PASS"; else echo "--- $label: FAIL"; FAILED+=("$label"); fi
}

for s in "${STEPS[@]}"; do
  case "$s" in
    cfn)
      step "cfn-lint (CloudFormation)" run cfn python:3.12-slim sh -c \
        'pip install -q --disable-pip-version-check --root-user-action=ignore "cfn-lint>=1.20,<2" && cfn-lint --version && cfn-lint aws/polynovea.yaml'
      ;;
    bicep)
      # Compiles Bicep with its linter, and checks the committed ARM JSON (used by the Deploy to Azure
      # button) is exactly what main.bicep compiles to.
      step "bicep build + lint (Azure)" run bicep mcr.microsoft.com/azure-cli:2.67.0 sh -c \
        'az bicep install >/dev/null 2>&1; az bicep version && az bicep build --file azure/main.bicep --stdout > /tmp/azuredeploy.json && az bicep lint --file azure/main.bicep && az bicep build-params --file azure/main.bicepparam --stdout > /dev/null && python3 -c "import json,sys;a=json.load(open(\"/tmp/azuredeploy.json\"));b=json.load(open(\"azure/azuredeploy.json\"));a.get(\"metadata\",{}).pop(\"_generator\",None);b.get(\"metadata\",{}).pop(\"_generator\",None);sys.exit(0 if a==b else (print(\"azure/azuredeploy.json is out of date: run bash deploy/scripts/build-azure.sh\") or 1))"'
      ;;
    tofu)
      # Since OpenTofu 1.10 its images are only for copying the binary into your own image.
      printf 'FROM ghcr.io/opentofu/opentofu:%s-minimal AS tofu\nFROM alpine:3.20\nCOPY --from=tofu /usr/local/bin/tofu /usr/local/bin/tofu\n' "$TOFU_VERSION" \
        | docker build -q -t "polynovea-validate-tofu:$TOFU_VERSION" - >/dev/null
      step "tofu fmt -check" run tofu-fmt "polynovea-validate-tofu:$TOFU_VERSION" tofu fmt -check -recursive -diff opentofu
      for example in aws azure; do
        step "tofu validate ($example)" run "tofu-$example" "polynovea-validate-tofu:$TOFU_VERSION" sh -c \
          "cp -r /deploy/opentofu /work && cd /work/examples/$example && tofu init -backend=false -input=false -no-color >/dev/null && tofu validate -no-color"
      done
      ;;
    shellcheck)
      step "shellcheck (first-boot and helper scripts)" run shellcheck koalaman/shellcheck:v0.10.0 \
        -S warning scripts/vm-bootstrap.sh scripts/validate.sh scripts/build-azure.sh
      ;;
    checkov)
      step "checkov (CloudFormation, ARM, OpenTofu)" run checkov bridgecrew/checkov:3.2.495 \
        --config-file /deploy/scripts/checkov.yaml \
        -f /deploy/aws/polynovea.yaml -f /deploy/azure/azuredeploy.json \
        -d /deploy/opentofu
      ;;
    *) echo "unknown step: $s" >&2; FAILED+=("$s") ;;
  esac
done

echo
if [ ${#FAILED[@]} -eq 0 ]; then echo "ALL PASSED: ${STEPS[*]}"; exit 0; fi
echo "FAILED: ${FAILED[*]}"; exit 1
