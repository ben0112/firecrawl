const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const directory = __dirname;
const dockerfile = readFileSync(join(directory, "Dockerfile"), "utf8");
const readme = readFileSync(join(directory, "README.md"), "utf8");
const baseDigest =
  "ghcr.io/ben0112/firecrawl@sha256:f9be0152af8ca42e1b5106f6566eef86dc0d1513ffd6dcd0129677d3a7e1055b";

assert.match(dockerfile, new RegExp(`ARG BASE_IMAGE=${baseDigest}`));
assert.match(
  dockerfile,
  /RUN printf '%s\\n' "\$GIT_SHA" > \/app\/BUILD_SHA/,
);
assert.match(dockerfile, /ENV FIRECRAWL_BUILD_SHA=\$GIT_SHA/);
assert.match(
  dockerfile,
  /LABEL org\.opencontainers\.image\.revision=\$GIT_SHA/,
);
assert.match(readme, /--build-arg BASE_IMAGE=/);

console.log("full_dist_overlay_contract_ok");
