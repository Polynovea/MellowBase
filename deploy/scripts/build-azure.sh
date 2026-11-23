#!/usr/bin/env bash
# Compiles deploy/azure/main.bicep to deploy/azure/azuredeploy.json, the ARM JSON the "Deploy to
# Azure" button opens. Run it after every change to main.bicep; validate.sh fails while they differ.
# Offline apart from downloading the Bicep compiler; no Azure account is used.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if ! command -v docker >/dev/null 2>&1 && [ -x "/c/Program Files/Docker/Docker/resources/bin/docker" ]; then
  export PATH="/c/Program Files/Docker/Docker/resources/bin:$PATH"
fi
export MSYS_NO_PATHCONV=1
MOUNT="$ROOT/deploy"
if command -v cygpath >/dev/null 2>&1; then MOUNT="$(cygpath -w "$MOUNT")"; fi
docker run --rm --name "polynovea-bicep-build-$$" -v "$MOUNT:/deploy" -w /deploy mcr.microsoft.com/azure-cli:2.67.0 sh -c \
  'az bicep install >/dev/null 2>&1; az bicep version && az bicep build --file azure/main.bicep --outfile azure/azuredeploy.json'
echo "wrote deploy/azure/azuredeploy.json"
