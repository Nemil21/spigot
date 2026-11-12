#!/usr/bin/env bash
# SP-056: generate the APIMatic TypeScript and Python SDKs from openapi.yaml.
#
# Needs an APIMatic account (a human step): either `npx @apimatic/cli auth login` first, or
# APIMATIC_API_KEY in the environment. The CLI uploads openapi.yaml to APIMatic's cloud to generate.
# Output lands in packages/sdk/{typescript,python}/apimatic/ (committed), next to the hand-written
# clients, which stay the README's stable surface.
#
#   bash packages/sdk/apimatic/generate.sh            # both languages
#   bash packages/sdk/apimatic/generate.sh python     # one
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
CLI="@apimatic/cli@2.2.0"
if [[ $# -gt 0 ]]; then LANGS=("$@"); else LANGS=(typescript python); fi

# The CLI reads <input>/src/spec/*: stage openapi.yaml there (not committed twice).
INPUT="$(mktemp -d)"
trap 'rm -rf "$INPUT"' EXIT
mkdir -p "$INPUT/src/spec"
cp "$ROOT/openapi.yaml" "$INPUT/src/spec/openapi.yaml"

AUTH=()
if [[ -n "${APIMATIC_API_KEY:-}" ]]; then AUTH=(--auth-key "$APIMATIC_API_KEY"); fi

for lang in "${LANGS[@]}"; do
  dest="$ROOT/packages/sdk/$lang/apimatic"
  echo "Generating $lang SDK into ${dest#"$ROOT"/}"
  npx -y "$CLI" sdk generate --language "$lang" --input "$INPUT" --destination "$dest" --force ${AUTH[@]+"${AUTH[@]}"}
done
