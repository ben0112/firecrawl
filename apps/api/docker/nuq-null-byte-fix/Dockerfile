# syntax=docker/dockerfile:1
ARG BASE_IMAGE=ghcr.io/firecrawl/firecrawl@sha256:20ea02d51fb5e1063637d7e43b5dcdf429bf69b7e1c1615b48b24bff1d0c13ae
FROM ${BASE_IMAGE}

ARG GIT_SHA=unknown

# The base image is the official build for upstream main 0344bc87. Keep the
# hotfix layer architecture-neutral: replace only compiled JavaScript modules
# and leave the official native Rust/Go dependencies untouched.
COPY docker/nuq-null-byte-fix/strip-nul-bytes.js /app/dist/src/services/worker/strip-nul-bytes.js
COPY docker/nuq-null-byte-fix/apply-patch.js /tmp/apply-nuq-null-byte-fix.js
COPY docker/nuq-null-byte-fix/map-utils.js /app/dist/src/lib/map-utils.js
COPY docker/nuq-null-byte-fix/map-utils.js.map /app/dist/src/lib/map-utils.js.map
COPY docker/nuq-null-byte-fix/map-controller.js /app/dist/src/controllers/v2/map.js
COPY docker/nuq-null-byte-fix/map-controller.js.map /app/dist/src/controllers/v2/map.js.map
COPY docker/nuq-null-byte-fix/searxng.js /app/dist/src/search/searxng.js
COPY docker/nuq-null-byte-fix/searxng.js.map /app/dist/src/search/searxng.js.map

RUN node /tmp/apply-nuq-null-byte-fix.js \
    && rm /tmp/apply-nuq-null-byte-fix.js \
    && node -e 'const assert = require("node:assert/strict"); const { stripNulBytes } = require("/app/dist/src/services/worker/strip-nul-bytes.js"); const input = { ["key\u0000"]: ["a\u0000b", "literal \\u0000"] }; const output = stripNulBytes(input); assert.deepEqual(Object.keys(output), ["key"]); assert.deepEqual(output.key, ["ab", "literal \\u0000"]);' \
    && node -e 'const fs = require("node:fs"); const map = fs.readFileSync("/app/dist/src/lib/map-utils.js", "utf8"); const controller = fs.readFileSync("/app/dist/src/controllers/v2/map.js", "utf8"); if (!map.includes("Map homepage fallback aborted") || !map.includes("fallbackAttempted") || !controller.includes("discovery: result.discovery")) process.exit(1);' \
    && printf '%s\n' "$GIT_SHA" > /app/BUILD_SHA

ENV FIRECRAWL_BUILD_SHA=$GIT_SHA
LABEL org.opencontainers.image.revision=$GIT_SHA
