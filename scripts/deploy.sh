#!/usr/bin/env bash
# Build the SPA and publish dist/ to an nginx host. Lambdas are deployed
# separately (npm run amplify:sandbox or an Amplify pipeline).
#
#   DEPLOY_HOST=user@host DEPLOY_PATH=/var/www/curtis npm run deploy
#
# DEPLOY_PATH/current is a symlink nginx serves; each deploy lands in
# DEPLOY_PATH/releases/<timestamp> and the symlink is swapped atomically.
set -euo pipefail

: "${DEPLOY_HOST:?Set DEPLOY_HOST (e.g. user@example.com)}"
: "${DEPLOY_PATH:?Set DEPLOY_PATH (e.g. /var/www/curtis)}"

cd "$(dirname "$0")/.."

release="$(date +%Y%m%d%H%M%S)"
archive="$(mktemp -t curtis-dist).tar.gz"
trap 'rm -f "$archive"' EXIT

echo "→ typecheck + build"
npm run build

echo "→ packaging dist/"
tar -czf "$archive" -C dist .

echo "→ uploading release $release to $DEPLOY_HOST"
scp -q "$archive" "$DEPLOY_HOST:/tmp/curtis-$release.tar.gz"

ssh "$DEPLOY_HOST" bash -s -- "$DEPLOY_PATH" "$release" <<'REMOTE'
set -euo pipefail
root="$1"
release="$2"
target="$root/releases/$release"
mkdir -p "$target"
tar -xzf "/tmp/curtis-$release.tar.gz" -C "$target"
rm -f "/tmp/curtis-$release.tar.gz"
ln -sfn "$target" "$root/current.tmp"
mv -Tf "$root/current.tmp" "$root/current"
ls -1dt "$root"/releases/* | tail -n +6 | xargs -r rm -rf
sudo nginx -t
sudo systemctl reload nginx
REMOTE

echo "✓ deployed $release"
