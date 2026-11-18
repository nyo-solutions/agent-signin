#!/bin/bash
# Copy the web vault files out of the exact Vaultwarden image the Lambda uses, so
# CloudFront/S3 can serve them (some are larger than Lambda's 6 MB response limit).
set -euo pipefail
cd "$(dirname "$0")/.."
IMAGE=$(awk '/^FROM vaultwarden\/server:/{print $2}' image/Dockerfile)
OUT=build/web-vault
rm -rf "$OUT"; mkdir -p build
cid=$(docker create --platform linux/arm64 "$IMAGE")
trap 'docker rm "$cid" >/dev/null' EXIT
docker cp "$cid:/web-vault" "$OUT"
find "$OUT" -name '*.map' -delete            # source maps aren't needed (and are huge)
echo "$IMAGE web vault -> $OUT ($(find "$OUT" -type f | wc -l | tr -d ' ') files, $(du -sh "$OUT" | cut -f1))"
