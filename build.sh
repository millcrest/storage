#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <storage-version> <tytonai-version>   e.g. $0 1.81.0 <tytonai-version>" >&2
  exit 1
fi

STORAGE_VERSION=$1
TYTONAI_VERSION=$2

IMAGE_NAME=storage-api:v$TYTONAI_VERSION-supa-$STORAGE_VERSION
GOOGLE_PREFIX=${GOOGLE_REGISTRY:-asia-southeast1-docker.pkg.dev/tyton-devops/docker}/supabase

if [[ -n "$(git status --porcelain)" ]]; then
  echo "working tree is dirty; commit or stash before building" >&2
  exit 1
fi

docker buildx build \
    --builder=container \
    --platform linux/amd64 \
    -t "$GOOGLE_PREFIX/$IMAGE_NAME" \
    --build-arg VERSION="v$STORAGE_VERSION" \
    --output "type=image,compression=zstd,push=true" \
    .
