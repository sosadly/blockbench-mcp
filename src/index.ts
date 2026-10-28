#!/usr/bin/env node
/**
 * BlockbenchMCP — Model Context Protocol server.
 *
 * Exposes Blockbench (3D model / texture / animation editor) to an AI client.
 * It forwards each tool call to the companion bridge plugin running inside
 * Blockbench over local HTTP. Start Blockbench, make sure the BlockbenchMCP
 * plugin is installed and its server is running, then point your MCP client
 * at this process (stdio transport).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { tools } from "./tools.js";
import { BASE_URL } from "./client.js";

/** Sent to the client on connect: the workflow that turns tool calls into good models. */
const INSTRUCTIONS = [
  "BlockbenchMCP drives a live Blockbench. How to get a good model, not a pile of boxes:",
  "1. REFERENCES FIRST. If the subject exists outside this chat (a named character, creature, franchise item, vehicle, building, real product), call find_references before building — even when the user gave one image, you need the other angles and the small parts. Load the best 2-4 (full-body / turnaround / side views) and study them with get_reference and zoom_reference.",
  "2. PALETTE. make_palette from the reference (point `regions` at hair, skin, clothes...) or from the text brief; then texture with color:'$key'.",
  "3. READ the guide for the job: get_guide {topic: modeling | character | mechanism | texturing | inspection ...}.",
  "4. BUILD with the shape tools instead of hand-computing corners: add_cubes with center/size, attach (stick a part onto another cube's face) and mirror; add_flare (skirts, capes), add_hair, add_cylinder, add_gear (+ mesh_with), add_pipe, extrude_chain, generate_array, add_hollow_volume. Details are welcome — spend cubes on what is visible, never on what is buried (check_model flags hidden cubes).",
  "5. CHECK what you built: check_model, then inspect_model / screenshot_views — the close-ups show z-fighting, floating parts, gaps at joints and the face. Fix, repeat. compare_reference scores the silhouette.",
  "6. TEXTURE: pack_uv -> create_texture -> detail_cubes (materials + patterns) -> paint_face -> inspect again.",
  "7. Animate mechanisms with animate_mechanism; characters with create_rig / generate_animation. Ask the user with request_review — a screenshot is not approval.",
].join("\n");

const server = new Server(
  { name: "blockbench-mcp", version: "0.4.0" },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
);

const toolMap = new Map(tools.map((t) => [t.name, t]));

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = toolMap.get(request.params.name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
    };
  }
  try {
    const content = await tool.handler((request.params.arguments ?? {}) as Record<string, any>);
    return { content };
  } catch (err: any) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error: ${err?.message ?? String(err)}` }],
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Logs go to stderr so they never corrupt the stdio protocol on stdout.
  console.error(`BlockbenchMCP server ready. Bridging to Blockbench at ${BASE_URL}`);
}

main().catch((err) => {
  console.error("Fatal error starting BlockbenchMCP server:", err);
  process.exit(1);
});
