/**
 * Server-side tests for the web-reference helpers and the new tool entries,
 * against the compiled dist/ output. No network: only the offline parts.
 *
 *   npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { assertPublicUrl } from "../dist/references.js";
import { tools } from "../dist/tools.js";

const byName = (name) => tools.find((t) => t.name === name);

test("assertPublicUrl refuses local, private and non-http addresses", () => {
  for (const bad of [
    "http://localhost:8787/command",
    "http://127.0.0.1:8787/ping",
    "http://10.0.0.5/a.png",
    "http://192.168.1.10/a.png",
    "http://172.20.0.1/a.png",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/a.png",
    "http://0.0.0.0/a.png",
    "http://intranet/a.png",
    "http://printer.local/a.png",
    "file:///C:/Windows/win.ini",
    "ftp://example.com/a.png",
    "not a url",
  ]) {
    assert.throws(() => assertPublicUrl(bad), `${bad} should be refused`);
  }
  assert.equal(assertPublicUrl("https://upload.wikimedia.org/a.png").hostname, "upload.wikimedia.org");
});

test("the new modelling, reference and inspection tools are registered", () => {
  for (const name of [
    "find_references", "load_reference", "zoom_reference", "make_palette", "get_palette",
    "inspect_model", "add_cylinder", "add_gear", "add_pipe", "add_flare", "add_hair",
    "paint_face", "fix_z_fighting", "animate_mechanism",
  ]) {
    assert.ok(byName(name), `${name} should be registered`);
  }
  assert.deepEqual(byName("find_references").inputSchema.required, ["query"]);
  assert.ok(byName("load_reference").inputSchema.properties.url, "load_reference takes a url");
  assert.ok(byName("load_reference").inputSchema.properties.result, "load_reference takes a search result number");
});

test("tool descriptions push references-first and close-up inspection", () => {
  assert.match(byName("get_status").description, /find_references/);
  assert.match(byName("find_references").description, /even when the user already gave one image/);
  assert.match(byName("screenshot_views").description, /close-ups/);
  for (const name of ["add_cube", "add_cubes", "generate_array", "add_flare", "add_hair"]) {
    assert.ok(byName(name).inputSchema.properties.fix_z_fighting, `${name} takes fix_z_fighting`);
  }
  assert.ok(byName("add_cube").inputSchema.properties.attach, "add_cube takes attach");
  assert.equal((byName("add_cube").inputSchema.required || []).length, 0, "add_cube no longer requires from/to");
});

test("load_reference refuses a result number before any search", async () => {
  await assert.rejects(() => byName("load_reference").handler({ result: 3 }), /run find_references first/);
});
