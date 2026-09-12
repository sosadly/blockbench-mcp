/**
 * Request-filtering tests for the bridge's HTTP layer.
 *
 * The bridge listens on localhost, which a web page in the user's browser can
 * still reach. These tests feed raw HTTP requests into the plugin's REAL
 * connection handler (through a fake socket) and check that browser-shaped
 * requests are refused while the MCP server's own requests go through.
 *
 *   npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(here, "..", "plugin", "blockbench_mcp.js");
const source = fs.readFileSync(PLUGIN, "utf8");

const REGISTER = "Plugin.register(PLUGIN_ID, {";
assert.ok(source.includes(REGISTER), "plugin registration call moved — update this harness");
const instrumented = source.replace(
  REGISTER,
  "globalThis.__MCP_BRIDGE__ = { commands, handleConnection };\n" + REGISTER
);

function loadPlugin(extra = {}) {
  const sandbox = {
    console: { ...console, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Buffer,
    isApp: true,
    Plugin: { register() {} },
    Blockbench: { version: "5.1.4", showQuickMessage() {} },
    ...extra,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(instrumented, sandbox, { filename: "blockbench_mcp.js" });
  return { bridge: sandbox.__MCP_BRIDGE__, sandbox };
}

/** Push one raw request through handleConnection and resolve with the response. */
function send(bridge, { method = "POST", path: p = "/command", headers = {}, body = "" }) {
  return new Promise((resolve) => {
    const socket = new EventEmitter();
    let out = "";
    socket.destroyed = false;
    socket.setTimeout = () => {};
    socket.write = (chunk) => { out += chunk.toString(); };
    socket.destroy = () => { socket.destroyed = true; };
    socket.end = () => {
      const [head, ...rest] = out.split("\r\n\r\n");
      const lines = head.split("\r\n");
      resolve({
        status: Number(lines[0].split(" ")[1]),
        head,
        json: rest.join("\r\n\r\n") ? JSON.parse(rest.join("\r\n\r\n")) : undefined,
      });
    };
    bridge.handleConnection(socket);
    const all = { "Content-Length": String(Buffer.byteLength(body)), ...headers };
    const raw =
      `${method} ${p} HTTP/1.1\r\n` +
      Object.entries(all).map(([k, v]) => `${k}: ${v}`).join("\r\n") +
      "\r\n\r\n" + body;
    socket.emit("data", Buffer.from(raw));
  });
}

const MCP_HEADERS = { Host: "127.0.0.1:8787", "Content-Type": "application/json" };
const scriptBody = (code) => JSON.stringify({ id: "1", action: "execute_script", params: { code } });

test("requests shaped like the MCP server's fetch are accepted", async () => {
  const { bridge } = loadPlugin();
  const res = await send(bridge, { headers: MCP_HEADERS, body: scriptBody("return 1 + 1") });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.result, 2);
});

test("localhost and a Content-Type with charset are accepted", async () => {
  const { bridge } = loadPlugin();
  const res = await send(bridge, {
    headers: { Host: "localhost:8787", "Content-Type": "application/json; charset=utf-8" },
    body: scriptBody("return 'ok'"),
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.result, "ok");
});

test("any request carrying an Origin header is refused before dispatch", async () => {
  const { bridge, sandbox } = loadPlugin();
  for (const origin of ["https://evil.example", "null", "http://127.0.0.1:8787"]) {
    const res = await send(bridge, {
      headers: { ...MCP_HEADERS, Origin: origin },
      body: scriptBody("globalThis.__ran = true; return 1"),
    });
    assert.equal(res.status, 403, origin);
    assert.equal(res.json.ok, false);
  }
  assert.equal(sandbox.__ran, undefined, "script must not run");
});

test("a no-cors text/plain POST (no preflight) is refused", async () => {
  const { bridge, sandbox } = loadPlugin();
  const res = await send(bridge, {
    headers: { Host: "127.0.0.1:8787", "Content-Type": "text/plain;charset=UTF-8" },
    body: scriptBody("globalThis.__ran = true; return 1"),
  });
  assert.equal(res.status, 415);
  assert.equal(sandbox.__ran, undefined);
});

test("a foreign Host (DNS rebinding) or a missing Host is refused", async () => {
  const { bridge } = loadPlugin();
  for (const host of ["attacker.example:8787", "127.0.0.1.nip.io:8787", undefined]) {
    const headers = { "Content-Type": "application/json" };
    if (host) headers.Host = host;
    const res = await send(bridge, { headers, body: scriptBody("return 1") });
    assert.equal(res.status, 403, String(host));
  }
  const ping = await send(bridge, { method: "GET", path: "/ping", headers: { Host: "attacker.example" } });
  assert.equal(ping.status, 403);
});

test("responses carry no CORS headers and OPTIONS is not answered with CORS", async () => {
  const { bridge } = loadPlugin();
  const ok = await send(bridge, { headers: MCP_HEADERS, body: scriptBody("return 1") });
  assert.equal(ok.status, 200);
  assert.doesNotMatch(ok.head, /access-control/i);
  const pre = await send(bridge, { method: "OPTIONS", headers: { Host: "127.0.0.1:8787" } });
  assert.notEqual(pre.status, 204);
  assert.doesNotMatch(pre.head, /access-control/i);
});

test("execute_script is rejected when the 'Allow execute_script' setting is off", async () => {
  const { bridge, sandbox } = loadPlugin({
    settings: { blockbench_mcp_allow_scripts: { value: false } },
  });
  const res = await send(bridge, {
    headers: MCP_HEADERS,
    body: scriptBody("globalThis.__ran = true; return 1"),
  });
  assert.equal(res.json.ok, false);
  assert.match(res.json.error, /disabled/);
  assert.equal(sandbox.__ran, undefined);
});
