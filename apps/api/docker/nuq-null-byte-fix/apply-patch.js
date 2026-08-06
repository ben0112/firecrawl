"use strict";

const fs = require("node:fs");

const target = "/app/dist/src/services/worker/nuq.js";
let source = fs.readFileSync(target, "utf8");

function replaceOnce(label, needle, replacement) {
  const first = source.indexOf(needle);
  const last = source.lastIndexOf(needle);
  if (first === -1) {
    throw new Error(label + ": expected base-image code was not found");
  }
  if (first !== last) {
    throw new Error(label + ": expected exactly one match");
  }
  source =
    source.slice(0, first) + replacement + source.slice(first + needle.length);
}

if (source.includes('require("./strip-nul-bytes")')) {
  throw new Error("NuQ NUL-byte hotfix is already present");
}

replaceOnce(
  "helper import",
  'const redis_1 = require("./redis");',
  'const redis_1 = require("./redis");\n' +
    'const { stripNulBytes } = require("./strip-nul-bytes");',
);
replaceOnce(
  "completed result",
  "[id, lock, returnvalue]);",
  "[id, lock, stripNulBytes(returnvalue)]);",
);
replaceOnce(
  "failed reason",
  "[id, lock, failedReason]);",
  "[id, lock, stripNulBytes(failedReason)]);",
);

fs.writeFileSync(target, source);
