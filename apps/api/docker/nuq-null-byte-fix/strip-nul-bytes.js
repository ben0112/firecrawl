"use strict";

/**
 * Remove actual NUL bytes from every string key and value before a payload is
 * written to a PostgreSQL JSONB column. The walk is iterative so deeply nested
 * scrape output cannot overflow the JavaScript call stack.
 */
function stripNulBytes(value) {
  if (typeof value === "string") {
    return value.replace(/\u0000/g, "");
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const root = Array.isArray(value)
    ? new Array(value.length)
    : Object.create(null);
  const pendingFor = source =>
    Array.isArray(source)
      ? source.map((item, index) => ({ slot: index, source: item }))
      : Object.entries(source).map(([key, item]) => ({
          slot: key.replace(/\u0000/g, ""),
          source: item,
        }));
  const stack = [{ destination: root, pending: pendingFor(value) }];

  while (stack.length > 0) {
    const frame = stack.pop();
    for (const { slot, source } of frame.pending) {
      let sanitized;
      if (typeof source === "string") {
        sanitized = source.replace(/\u0000/g, "");
      } else if (source !== null && typeof source === "object") {
        sanitized = Array.isArray(source)
          ? new Array(source.length)
          : Object.create(null);
        stack.push({
          destination: sanitized,
          pending: pendingFor(source),
        });
      } else {
        sanitized = source;
      }
      frame.destination[slot] = sanitized;
    }
  }

  return root;
}

module.exports = { stripNulBytes };
