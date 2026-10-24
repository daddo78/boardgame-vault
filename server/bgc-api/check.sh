#!/usr/bin/env bash
# Type-check (src and test), test and build bgc-api on this computer.
# The repo lives on Google Drive, where npm can't write node_modules (EBADF), so this works in a copy on the
# local disk and only reads the repo. Usage: ./check.sh
set -euo pipefail
cd "$(dirname "$0")"
WORK="${BGC_API_WORK:-${LOCALAPPDATA:-${TMPDIR:-/tmp}}/bgc-api-work}"
mkdir -p "$WORK"
rm -rf "$WORK/src" "$WORK/test"
cp -r src test package.json package-lock.json tsconfig.json tsconfig.test.json "$WORK/"
cd "$WORK"
# Reinstall only when the lockfile changed
if ! cmp -s package-lock.json node_modules/.package-lock.json.copy 2>/dev/null; then
  npm ci --no-audit --no-fund
  cp package-lock.json node_modules/.package-lock.json.copy
fi
npx tsc -p tsconfig.test.json   # src and test (the build below checks src alone again, as the Dockerfile does)
npm test
npx tsc -p tsconfig.json
echo "bgc-api: types, tests and build OK (in $WORK)"
