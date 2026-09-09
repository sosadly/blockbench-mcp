/**
 * HTTP client that talks to the BlockbenchMCP bridge plugin running inside
 * Blockbench (see plugin/blockbench_mcp.js).
 */

const PORT = Number(process.env.BLOCKBENCH_MCP_PORT) || 8787;
const HOST = process.env.BLOCKBENCH_MCP_HOST || "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}`;

export interface CommandResponse {
  ok: boolean;
  id?: string;
  result?: unknown;
  error?: string;
  stack?: string;
}

let requestCounter = 0;

/**
 * The bridge refuses anything larger than this (MAX_BODY in the plugin), and a
 * body that big is always a mistake on this side — say so before spending a
 * round trip on it.
 */
const MAX_BODY_BYTES = 96 * 1024 * 1024;

/**
 * Commands that build geometry procedurally: the request can carry a dense
 * character matrix or hundreds of element specs, and the bridge then creates
 * every cube on Blockbench's renderer thread. Neither is slow enough to need
 * minutes, but the default 60s is too tight to be comfortable.
 */
const HEAVY_ACTIONS = new Set([
  "voxelize_matrix",
  "generate_array",
  "extrude_chain",
  "add_hollow_volume",
  "add_cubes",
  "add_groups",
  "audit_complexity",
  "detail_cubes",
  "paint_faces",
  "paint_texture",
  "pack_uv",
  "create_rig",
]);

/**
 * Send a command to the Blockbench bridge. Resolves with the command's
 * `result`, or throws an Error carrying the message reported by Blockbench.
 */
export async function callBlockbench(
  action: string,
  params: Record<string, unknown> = {},
  timeoutMs = 60_000
): Promise<unknown> {
  // Tools that park until a human answers carry their own budget; give the
  // request the user's whole waiting window plus a little slack.
  if (typeof params.timeout_seconds === "number" && params.timeout_seconds > 0) {
    timeoutMs = Math.max(timeoutMs, params.timeout_seconds * 1000 + 30_000);
  }
  const id = `req-${++requestCounter}`;
  const body = JSON.stringify({ id, action, params });
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > MAX_BODY_BYTES) {
    throw new Error(
      `Command "${action}" is ${(bytes / 1048576).toFixed(1)} MB, over the bridge's ` +
        `${MAX_BODY_BYTES / 1048576} MB limit. Split it into several calls.`
    );
  }
  // A big payload is big on both ends: it has to cross the socket, be parsed,
  // and turn into geometry. Scale the budget with it (~1s per 256 KB) instead
  // of aborting a call that was only ever going to be slow.
  if (HEAVY_ACTIONS.has(action)) timeoutMs = Math.max(timeoutMs, 180_000);
  timeoutMs = Math.max(timeoutMs, 60_000 + Math.ceil(bytes / 262_144) * 1000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timer);
    if (err?.name === "AbortError") {
      throw new Error(`Command "${action}" timed out after ${timeoutMs}ms.`);
    }
    throw new Error(
      `Cannot reach Blockbench on ${BASE_URL}. Is Blockbench open with the ` +
        `BlockbenchMCP plugin installed and its server started? (${err?.message ?? err})`
    );
  } finally {
    clearTimeout(timer);
  }

  const data = (await response.json()) as CommandResponse;
  if (!data.ok) {
    throw new Error(data.error || `Command "${action}" failed.`);
  }
  return data.result;
}

/** Quick connectivity check. Returns bridge info or throws. */
export async function ping(): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(`${BASE_URL}/ping`, { signal: controller.signal });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export { BASE_URL };
