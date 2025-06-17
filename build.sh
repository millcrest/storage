#!/bin/bash

STORAGE_VERSION=$1
TYTONAI_VERSION=$2

IMAGE_NAME=storage-api:v$STORAGE_VERSION-tytonai-$TYTONAI_VERSION
HARBOR_PREFIX=${DOCKER_REGISTRY:-harbor.internal.millcrest.dev}/supabase
GOOGLE_PREFIX=${GOOGLE_REGISTRY:-asia-southeast1-docker.pkg.dev/tytonai/docker}/supabase

docker buildx build \
    --builder=container \
    -t $HARBOR_PREFIX/$IMAGE_NAME \
    -t $GOOGLE_PREFIX/$IMAGE_NAME \
    --build-arg VERSION=v$STORAGE_VERSION \
    --platform linux/amd64 \
    --provenance=false \
    --output "type=image,compression=zstd,compression-level=22,oci-mediatypes=true,force-compression=true,push=true" \
    .