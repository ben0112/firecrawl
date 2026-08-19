# syntax=docker/dockerfile:1
ARG BASE_IMAGE=ghcr.io/ben0112/firecrawl@sha256:f9be0152af8ca42e1b5106f6566eef86dc0d1513ffd6dcd0129677d3a7e1055b
FROM ${BASE_IMAGE}

ARG GIT_SHA=unknown

# This deployment image is intentionally architecture-neutral. The pinned
# base supplies the already-built native Rust/Go modules and production
# dependencies from the same lockfile; the locally type-checked JavaScript
# build replaces the complete application dist tree. This avoids running the
# Go toolchain through QEMU when publishing an amd64 hotfix from Apple Silicon.
RUN rm -rf /app/dist && mkdir -p /app/dist
COPY --from=dist-context . /app/dist
RUN printf '%s\n' "$GIT_SHA" > /app/BUILD_SHA

ENV FIRECRAWL_BUILD_SHA=$GIT_SHA
LABEL org.opencontainers.image.revision=$GIT_SHA
