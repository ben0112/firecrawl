# syntax=docker/dockerfile:1
ARG BASE_IMAGE=ghcr.io/firecrawl/firecrawl@sha256:20ea02d51fb5e1063637d7e43b5dcdf429bf69b7e1c1615b48b24bff1d0c13ae
FROM ${BASE_IMAGE}

ARG GIT_SHA=unknown

# The base image is the official build for upstream main 0344bc87. Keep the
# hotfix layer architecture-neutral: replace only the NuQ persistence helper
# and leave the official native Rust/Go dependencies untouched.
COPY docker/nuq-null-byte-fix/strip-nul-bytes.js /app/dist/src/services/worker/strip-nul-bytes.js
COPY docker/nuq-null-byte-fix/apply-patch.js /tmp/apply-nuq-null-byte-fix.js

RUN node /tmp/apply-nuq-null-byte-fix.js \
    && rm /tmp/apply-nuq-null-byte-fix.js \
    && node -e 'const assert = require("node:assert/strict"); const { stripNulBytes } = require("/app/dist/src/services/worker/strip-nul-bytes.js"); const input = { ["key\u0000"]: ["a\u0000b", "literal \\u0000"] }; const output = stripNulBytes(input); assert.deepEqual(Object.keys(output), ["key"]); assert.deepEqual(output.key, ["ab", "literal \\u0000"]);' \
    && printf '%s\n' "$GIT_SHA" > /app/BUILD_SHA

ENV FIRECRAWL_BUILD_SHA=$GIT_SHA
LABEL org.opencontainers.image.revision=$GIT_SHA
