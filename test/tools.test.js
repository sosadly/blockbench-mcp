// Lightweight tests using only Node's built-in test runner (no deps).
// Run with: npm test  (== npm run build && node --test)
//
// These cover the two fixes in this PR:
//   1. text() must never produce an invalid content block ({type:"text",
//      text: undefined}) — which happens when execute_script user code has
//      no explicit `return` (new Function does not auto-return the last
//      expression) and JSON.stringify(undefined) yields the value undefined.
//   2. The new export_model tool is registered with a required `path`.
//
// Tests import the COMPILED dist/ output (the repo's actual runtime), so
// `npm test` builds first.

import { test } from "node:test";
import assert from "node:assert/strict";
import { text, tools } from "../dist/tools.js";

// ---- fix #1: text() undefined coercion -------------------------------------

test("text(undefined) returns a valid string content block, not {text: undefined}", () => {
  const block = text(undefined);
  assert.equal(block.length, 1);
  assert.equal(block[0].type, "text");
  // The MCP schema requires `text` to be a string. The pre-fix bug was that
  // JSON.stringify(undefined) returns the value `undefined`, so text was
  // undefined and the whole tools/call result failed validation.
  assert.equal(typeof block[0].text, "string");
  assert.equal(block[0].text, "(undefined)");
});

test("text(null) is a valid string block (JSON.stringify(null) === 'null')", () => {
  const block = text(null);
  assert.equal(typeof block[0].text, "string");
  assert.equal(block[0].text, "null");
});

test("text(string) passes the string through unchanged", () => {
  assert.deepEqual(text("hello"), [{ type: "text", text: "hello" }]);
});

test("text(object) JSON-serializes the object", () => {
  const block = text({ a: 1 });
  assert.equal(block[0].text, '{\n  "a": 1\n}');
});

// ---- fix #2: export_model tool registration --------------------------------

test("export_model tool is registered", () => {
  const t = tools.find((x) => x.name === "export_model");
  assert.ok(t, "export_model tool not found in tools array");
});

test("export_model requires `path` and offers optional codec/format", () => {
  const t = tools.find((x) => x.name === "export_model");
  assert.ok(t);
  assert.deepEqual(t.inputSchema.required, ["path"]);
  const props = t.inputSchema.properties;
  assert.equal(props.path.type, "string");
  assert.equal(props.codec.type, "string");
  assert.equal(props.format.type, "string");
});

// ---- companion docs fix: execute_script must document return + await -------

test("execute_script docs tell callers to use an explicit return and that Promises are awaited", () => {
  const t = tools.find((x) => x.name === "execute_script");
  assert.ok(t);
  assert.match(t.description, /explicit .return./i);
  assert.match(t.description, /awaited/i);
  const codeDesc = t.inputSchema.properties.code.description;
  assert.match(codeDesc, /return/i);
  assert.match(codeDesc, /awaited|Promise/i);
});