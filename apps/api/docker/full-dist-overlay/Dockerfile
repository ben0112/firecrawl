# syntax=docker/dockerfile:1
ARG BASE_IMAGE=docker.io/benjaminzhang/firecrawl@sha256:3a443eb6d9dee607e03111f146fc4d051fff528609179e407d8392f79d75ba87
FROM ${BASE_IMAGE}

ARG GIT_SHA=unknown

# This deployment image is intentionally architecture-neutral. The pinned
# base supplies the already-built native Rust/Go modules and production
# dependencies from the same lockfile; the locally type-checked JavaScript
# build replaces the complete application dist tree. This avoids running the
# Go toolchain through QEMU when publishing an amd64 hotfix from Apple Silicon.
COPY --from=dist-context . /app/dist

ENV FIRECRAWL_BUILD_SHA=$GIT_SHA
LABEL org.opencontainers.image.revision=$GIT_SHA
