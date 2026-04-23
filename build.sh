#!/bin/bash

STORAGE_VERSION=$1
TYTONAI_VERSION=$2

IMAGE_NAME=storage-api:v$TYTONAI_VERSION-supa-$STORAGE_VERSION
HARBOR_PREFIX=${DOCKER_REGISTRY:-harbor.internal.millcrest.dev}/supabase
GOOGLE_PREFIX=${GOOGLE_REGISTRY:-asia-southeast1-docker.pkg.dev/tytonai/docker}/supabase

docker buildx build \
    --builder=container \
    -t $HARBOR_PREFIX/$IMAGE_NAME \
    -t $GOOGLE_PREFIX/$IMAGE_NAME \
    --build-arg VERSION=v$STORAGE_VERSION \
    --output "type=image,compression=zstd,push=true" \
    .