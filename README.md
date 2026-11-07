<div align="center">

# Blockbench MCP

**An MCP server for Blockbench: an AI models, textures, rigs and animates Minecraft models inside the editor.**

[![MCP](https://img.shields.io/badge/MCP-server-6f42c1)](https://modelcontextprotocol.io/)
[![Blockbench](https://img.shields.io/badge/Blockbench-4.8%2B-1f8cff)](https://www.blockbench.net/)
[![Node](https://img.shields.io/badge/Node-18%2B-339933)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green)](LICENSE)
[![Stars](https://img.shields.io/github/stars/sosadly/blockbench-mcp?style=flat&color=yellow)](https://github.com/sosadly/blockbench-mcp/stargazers)

<img src="assets/3.png" alt="Blockbench MCP examples: a minecart creature, a skeleton with daggers and a stone golem, AI-generated Minecraft models made in Blockbench" width="820">

[Quick start](#quick-start) · [Gallery](#gallery) · [Features](#features) · [Tools](#tool-reference) · [FAQ](#faq)

</div>

---

**Blockbench MCP** is an open-source [Model Context Protocol](https://modelcontextprotocol.io/) server that connects AI assistants such as **Claude Code, Claude Desktop and Cursor** to the live [Blockbench](https://www.blockbench.net/) desktop editor. The AI can create **Minecraft Java, Bedrock and [GeckoLib](https://github.com/bernie-g/geckolib) models**, paint textures pixel by pixel, build rigs, write keyframe animations, install Blockbench plugins and take screenshots to check its own work. You don't have to touch the editor.

It has **86 MCP tools** over one local connection. They cover blockout, detailing, texturing, rigging, animation and export, with quality gates between the stages so a model ends up with real detail instead of 15 flat boxes.

## Gallery

All three models were built, textured and posed by an AI through Blockbench MCP.

<table>
  <tr>
    <td align="center" width="33%">
      <img src="assets/rail_gnawer.png" alt="Rail Gnawer: a minecart creature Minecraft model made with Blockbench MCP" height="260"><br>
      <b>Rail Gnawer</b><br><sub></sub>
    </td>
    <td align="center" width="33%">
      <img src="assets/skeleton_daggers.png" alt="Skeleton with daggers: a rigged Minecraft mob model made with Blockbench MCP" height="260"><br>
      <b>Skeleton with daggers</b><br><sub></sub>
    </td>
    <td align="center" width="33%">
      <img src="assets/golem_nadr.png" alt="Stone golem with a banner: a Minecraft boss model made with Blockbench MCP" height="260"><br>
      <b>Stone Golem</b><br><sub></sub>
    </td>
  </tr>
</table>

## Quick start

```bash
git clone https://github.com/sosadly/blockbench-mcp.git
cd blockbench-mcp
npm install && npm run build
```

1. In **Blockbench desktop**, open **File ▸ Plugins ▸ Load Plugin from File** and pick [`plugin/blockbench_mcp.js`](plugin/blockbench_mcp.js). Allow network access when asked.
2. Add the server to your AI client. Here is Claude Code as an example:

   ```bash
   claude mcp add blockbench -- node /absolute/path/to/blockbench-mcp/dist/index.js
   ```

3. Ask for something, for example: *"Make a textured GeckoLib bear that can walk, run, sleep and attack."*

The full setup is under [Installation](#installation).

## How it works

There are two pieces:

| Piece | Runs where | Responsibility |
|-------|-----------|----------------|
| **Bridge plugin** ([`plugin/blockbench_mcp.js`](plugin/blockbench_mcp.js)) | Inside Blockbench (desktop) | Hosts a local HTTP endpoint on `127.0.0.1:8787` (built on Node's `net` module) and runs each command against the Blockbench API on the renderer thread. |
| **MCP server** ([`src/`](src/) → `dist/`) | A Node process your AI client launches | Exposes Blockbench as MCP tools (stdio transport) and forwards every call to the bridge. |

```
┌────────────┐   stdio (MCP)   ┌──────────────────┐   HTTP 127.0.0.1:8787   ┌──────────────────────┐
│  AI client │ ──────────────▶ │  blockbench-mcp  │ ──────────────────────▶ │  Blockbench + plugin │
│ (Claude…)  │ ◀────────────── │   (Node server)  │ ◀────────────────────── │   (live editor)      │
└────────────┘                 └──────────────────┘                         └──────────────────────┘
```

## Features

- 🔎 **References from the web.** For a known character, creature, item, vehicle or product, `find_references` searches the web (safe search always on) and returns one numbered **contact sheet** plus a short description; `load_reference {result:N}` / `{url}` loads the chosen ones into Blockbench, and `zoom_reference` enlarges details like a face or a buckle.
- 🎨 **Palettes.** `make_palette` reads a reference or concept image into named colour families, each with a 5-step hue-shifted ramp (or builds a harmony from a text brief), stores it on the project and lets texturing use `color:"$hair"` / `"$hair.shadow"`.
- 🧱 **Modeling.** Create bones (groups) and cubes one at a time or **in bulk** (`add_groups` / `add_cubes` build a whole posed skeleton in one call), with full rotation and inflate. Place cubes by `center`+`size`, **`attach`** them to a face of another cube (they land on the surface and follow its rotation and bone, so nothing floats), or build both sides at once with **`mirror`**. Edit, move, reparent and delete elements, and read the outliner tree.
- ⚙️ **Round shapes, mechanisms, cloth and hair.** `add_cylinder` (solid or tube, an exact regular polygon), `add_gear` (teeth, spokes, hub, axle; `mesh_with` places the next gear so the teeth interleave), `add_pipe`, `add_flare` (pleated skirts, capes, lampshades, roofs), `add_hair` (bangs, side locks, back strands, tails on bone chains with ribbons), and `animate_mechanism` (spinning gear trains with the right ratios and directions, pistons, levers, pulsing lights, seamless loops).
- ✨ **No z-fighting.** Coplanar faces are detected in world space (rotations, bones and inflate included) and **fixed automatically** for everything a tool creates; `fix_z_fighting` cleans up after manual edits.
- 🏗️ **Procedural detail.** An LLM cannot compute 200 sets of `[from,to]` in its head, so these tools do the math. `voxelize_matrix` extrudes a character matrix into cubes (draw a blade, an emblem or a horn profile as pixel art). `add_hollow_volume` builds a shell with a real cavity (hoods, helmets, pauldrons, cages). `generate_array` repeats an element along a line, ring or grid with jitter, taper, rotation and an anti-z-fighting depth stagger (torn hems, scales, plates, teeth, rivets). `extrude_chain` builds a tapering, curving chain with one bone per segment (horns, tails, tentacles, braids). `add_wing` builds a jointed wing with a membrane.
- 📏 **Density gate.** `audit_complexity` grades the model against a cube budget (prop 30-60, mob 100-180, hero 180-300+) and reports monolithic boxes, overlap, micro-detail density, bare flat faces and bone depth. The verdict (`too_primitive` / `acceptable` / `high_detail`) stops a blockout from reaching texturing.
- 🖌️ **Texturing engine.** `detail_cubes` shades every pixel from its 3D point: hue-shifted light (cool shadows, warm lights), ambient occlusion, edge bevels and per-**material** detail (skin, cloth folds, hair strands with a shine band, metal sheen and scratches, wood grain, stone, leather stitching, scales, glowing emissive), plus world-space **patterns** that run across neighbouring cubes (plaid, stripes, panels with rivets, lace and trim borders, hazard, bricks…). `paint_face` draws eyes, brows, mouth and blush as pixel art in the face's own grid. `pack_uv` gives thin cubes per-face UV so every face gets real pixels. Low-level paint ops (pixels, rects, ellipses, polygons, dither, noise, gradients) and face-relative `paint_faces` are still there.
- 🦴 **Rigging.** `create_rig` builds a segmented humanoid or quadruped skeleton with three bones per limb (so elbows and knees bend), joints on the real pivots and correct `*_left` / `*_right` naming. `check_rig` won't call a two-bone-limb rig animation-ready.
- 🎬 **Animation.** `generate_animation` writes a complete base cycle (idle / walk / run / attack / cast / jump / hurt / death / fly) with correct gait phasing, bent joints, counter-rotation, follow-through and seamless loops. `add_keyframes` refines it in bulk with interpolation control.
- 📐 **Measured animation.** `analyze_animation` evaluates the rig and reports how far each hand, foot and head travels in the model's own axes, whether the loop closes and whether lower limb segments move at all. This is how it catches an attack that swings into the model's back instead of at the target.
- 🧭 **Left and right stay correct.** The model faces `-Z`, so its own right is `+X`. `get_orientation`, `which_side` and `check_sides` answer from coordinates. `add_cube` / `add_group` take `side:"left"|"right"` and **refuse** a call whose coordinate contradicts it, and every screenshot is labelled with which image edge is the model's right.
- 🙋 **Human review gate.** `request_review` renders labelled views, shows them in the MCP Copilot panel and **blocks until you press a button**, then returns your verdict and comment inside the same tool call. `ask_user` does the same for a question.
- 🎯 **Reference matching.** Drop a reference image into the **MCP Copilot panel**. `compare_reference` **scores the silhouette match** (IoU `match_percent` plus a `[reference | model | overlay]` composite and "add/trim mass here" advice), and `measure_model` gives numeric proportions.
- 📸 **Vision and close-up inspection.** `screenshot`, `screenshot_views` and `get_texture` return images inline. `check_model` audits for z-fighting, floating parts, hidden (buried) cubes, stretched UVs and side mistakes; `inspect_model` (and the close-ups `screenshot_views` appends) frames each problem spot, x-rays away what stands in front, outlines the cubes involved and captions the fix — then checks the face, hands, feet, joints and gear contacts, which four full-body views never show.
- 🧠 **Guidance.** `get_guide` returns playbooks for modeling, characters, mechanisms, detailing, inspection, orientation, rigging, texturing, VFX, animation, review and reference matching, and the server sends its workflow (references first, palette, build, inspect) to the client on connect.
- 🪟 **In-app panel.** The **MCP Copilot** side panel shows server status, the reference drop zone, a live log of the AI's commands, model stats, the last match score and any pending review.
- 🧩 **Plugins.** Search, install (by store id, URL or file) and uninstall Blockbench plugins, so the AI can set up formats like GeckoLib itself.
- 📦 **Export.** `export_project` uses the format's own codec. `export_model` writes through any named codec; the default is glTF, a self-contained `.gltf` that imports into Godot, Unity or Blender.
- 🔧 **Escape hatch.** `execute_script` runs arbitrary Blockbench JS for anything the dedicated tools don't cover.

## Requirements

- **Blockbench desktop app 4.8+.** The web app cannot host the bridge; see [Limitations](#limitations).
- **Node.js 18+** (for global `fetch`).
- An MCP-capable client: Claude Code, Claude Desktop, Cursor, or any other client that speaks MCP over stdio.

## Installation

### 1. Install the bridge plugin in Blockbench

1. Open the **desktop** Blockbench app.
2. **File ▸ Plugins ▸ Load Plugin from File** and select [`plugin/blockbench_mcp.js`](plugin/blockbench_mcp.js). You can also copy it into your Blockbench `plugins` folder.
3. On first start the plugin asks for **network permission** because it needs the `net` module to host the local server. Choose **"Always allow for this plugin."**
4. A toast confirms **"MCP server started on port 8787."**
   - Toggle the server any time: **Tools ▸ Start / Stop MCP Server**
   - Change the port: **Settings ▸ General ▸ MCP Server Port** (default `8787`)

Verify it's up:

```bash
curl http://127.0.0.1:8787/ping
# {"ok":true,"protocol":1,"blockbench_version":"5.x.x","is_app":true,"has_project":false}
```

### 2. Build the MCP server

```bash
git clone https://github.com/sosadly/blockbench-mcp.git
cd blockbench-mcp
npm install
npm run build
```

### 3. Connect your AI client

Point your client at `dist/index.js` over stdio, using an **absolute path**.

**Claude Code**: add a `.mcp.json` to your project, or use `claude mcp add`:

```json
{
  "mcpServers": {
    "blockbench": {
      "command": "node",
      "args": ["/absolute/path/to/blockbench-mcp/dist/index.js"],
      "env": { "BLOCKBENCH_MCP_PORT": "8787" }
    }
  }
}
```

**Claude Desktop**: `claude_desktop_config.json`. **Cursor**: `.cursor/mcp.json`. Both use the same shape:

```json
{
  "mcpServers": {
    "blockbench": {
      "command": "node",
      "args": ["C:\\path\\to\\blockbench-mcp\\dist\\index.js"]
    }
  }
}
```

| Env var | Default | Purpose |
|---------|---------|---------|
| `BLOCKBENCH_MCP_PORT` | `8787` | Must match the plugin's port setting. |
| `BLOCKBENCH_MCP_HOST` | `127.0.0.1` | Bridge host. |

## Tool reference

| Group | Tools |
|-------|-------|
| **Status & guidance** | `get_status`, `get_guide`, `list_formats` |
| **Orientation (left/right)** | `get_orientation`, `which_side`, `check_sides` |
| **Human review** | `request_review`, `ask_user` |
| **References & colour** | `find_references`, `get_reference`, `load_reference`, `zoom_reference`, `make_palette`, `get_palette`, `compare_reference`, `measure_model`, `list_references`, `clear_references` |
| **Project** | `new_project`, `set_project_meta`, `save_project`, `export_project`, `export_model`, `load_project`, `close_project` |
| **Geometry** | `add_group`, `add_cube`, `add_groups`, `add_cubes`, `add_plane`, `add_mesh`, `add_meshes`, `mirror_element`, `edit_element`, `delete_element`, `list_outliner`, `get_element`, `pack_uv` |
| **Procedural detail** | `voxelize_matrix`, `add_hollow_volume`, `generate_array`, `extrude_chain`, `add_wing`, `add_flare`, `add_hair`, `add_cylinder`, `add_gear`, `add_pipe` |
| **Quality gates** | `audit_complexity`, `check_model`, `fix_z_fighting`, `inspect_model`, `check_sides`, `check_rig` |
| **Rigging** | `create_rig`, `check_rig`, `get_rig` |
| **UV & textures** | `create_texture`, `create_textures`, `create_vfx_texture`, `paint_texture`, `detail_cubes`, `paint_face`, `paint_faces`, `apply_texture`, `set_cube_uv`, `set_texture_render_mode`, `import_texture`, `resize_texture`, `list_textures`, `get_texture` |
| **Animation** | `animate_mechanism`, `generate_animation`, `analyze_animation`, `preview_animation`, `create_animation`, `add_keyframe`, `add_keyframes`, `list_animations`, `remove_animation` |
| **View** | `set_camera_angle`, `screenshot`, `screenshot_views` |
| **Plugins** | `list_plugins`, `install_plugin`, `uninstall_plugin` |
| **Escape hatch** | `execute_script` |

**Conventions.** Coordinates are **Blockbench units**, rotations are **degrees**, and texture pixel ops use a **top-left origin with y pointing down**. `add_cube` returns each face's resolved UV rect; `detail_cubes` then base-coats every face and `paint_faces` paints features (eyes, nose, claws) in coordinates relative to a face, so you never compute absolute UVs by hand.

**Orientation.** A model faces `-Z`, so **its own right is `+X`** and its left is `-X`. This is verified against Blockbench's bundled vanilla data: Bedrock's `rightArm`, stored at `x = -5`, is loaded by Blockbench at `x = +5` (the Bedrock/Java codecs mirror X on import and export). Camera views are named from the model's point of view (`front` shows its face), and every capture is captioned with which image edge is the model's right, because a front view is mirrored just like facing a person.

**Rotation signs.** `+X` rotation lifts a bone's front, so a **down-pointing** bone (arm, leg) swings its tip **forward** while an **up-pointing** bone (torso, neck) tips **backward**. Elbows bend `+X`, knees bend `-X`, and `+Y` turns the model toward its own left. `generate_animation` applies these for you and `analyze_animation` verifies the result by measurement.

## Examples

<details>
<summary><b>An animated GeckoLib bear from one prompt</b></summary>

The sequence an AI follows for *"make a textured GeckoLib bear that can walk, run, sleep and attack"*:

```jsonc
// 0. Read the playbook so the model comes out detailed and rotated, not boxy
get_guide {}

// 1. Install GeckoLib (adds the `geckolib_model` format)
install_plugin { "id": "geckolib" }

// 2. New project, straight from the start screen
new_project { "format": "geckolib_model", "name": "bear",
              "texture_width": 64, "texture_height": 64 }

// 3. Lay out the whole posed skeleton in one call; note the rotated bones
add_groups { "groups": [
  { "name": "body",   "origin": [0, 12, 0] },
  { "name": "head",   "origin": [0, 14, -7], "parent": "body", "rotation": [10, 0, 0] }, // nose down
  { "name": "leg_fl", "origin": [3, 8, -5],  "parent": "body", "rotation": [-6, 0, 0] },
  { "name": "leg_fr", "origin": [-3, 8, -5], "parent": "body", "rotation": [-6, 0, 0] }
  // ...hind legs, ears, muzzle, tail...
] }

// 4. Build many cubes at once (segment limbs, taper with inflate, mirror left/right)
add_cubes { "cubes": [
  { "name": "torso",   "from": [-5, 8, -7], "to": [5, 16, 7], "parent": "body" },
  { "name": "head",    "from": [-3.5, 10, -13], "to": [3.5, 16, -7], "parent": "head" },
  { "name": "muzzle",  "from": [-2, 10, -16], "to": [2, 13, -13], "parent": "head", "inflate": -0.5 }
  // ...
] }

// 5. Texture: shaded base coat on EVERY face (no gaps), then features face-relative
create_texture { "name": "bear", "width": 64, "height": 64, "fill": "#6e4a2b" }
detail_cubes   { "base": "#6e4a2b", "noise": 0.12, "bottom_dark": 0.3 }
paint_faces    { "faces": [
  { "cube": "head",   "face": "north", "ops": [
    { "type": "rect",    "x": 2, "y": 2, "width": 1, "height": 1, "color": "#0f0a05" }, // eye
    { "type": "ellipse", "x": 3, "y": 4, "width": 2, "height": 2, "color": "#140e08" }  // nose
  ] }
] }

// 6. Animate (bulk keyframes, smooth interpolation)
create_animation { "name": "animation.bear.walk", "loop": "loop", "length": 1.2 }
add_keyframes {
  "animation": "animation.bear.walk",
  "keyframes": [
    { "bone": "leg_fl", "channel": "rotation", "time": 0.0, "value": [28, 0, 0], "interpolation": "catmullrom" },
    { "bone": "leg_fl", "channel": "rotation", "time": 0.6, "value": [-28, 0, 0], "interpolation": "catmullrom" },
    { "bone": "leg_fl", "channel": "rotation", "time": 1.2, "value": [28, 0, 0], "interpolation": "catmullrom" }
  ]
}

// 7. Review from every side + audit, fix what you see, then repeat 4–7
screenshot_views { "views": ["isometric_right_front", "front", "left", "back"] }
check_model {}

// 8. Save / export
save_project   { "path": "D:/models/bear.bbmodel" }
export_project { "path": "D:/models/bear.geo.json" }
```

</details>

<details>
<summary><b>Procedural detail: from a 20-cube blockout to a 150-cube model</b></summary>

None of these tools knows what a hood or a scale is. They are extrusion, shells, arrays and chains.

```jsonc
// A hood: a shell with a real cavity, open at the face (north = -Z) and the neck (down)
add_hollow_volume {
  "bounds": { "from": [-5.5, 23, -5.5], "to": [5.5, 34, 5.5] },
  "wall_thickness": 1.5, "open_faces": ["north", "down"],
  "name": "hood", "parent": "head"
}

// A torn hem: 11 panels hanging off the cloak, tapering, jittered, staggered in depth so
// neighbours cannot z-fight
generate_array {
  "mode": "linear", "count": 11, "element_size": [2.2, 5, 1.2],
  "start": [-6, 7, 3.2], "end": [6, 7, 3.2],
  "anchor": "top", "jitter": [0.15, 0.4, 0], "size_decay": [0, -0.15, 0],
  "depth_stagger": 0.12, "rotation_range": { "min": [-4, 0, -9], "max": [4, 0, 9] },
  "seed": 12, "name_prefix": "hem", "parent": "body"
}

// A horn: 6 tapering segments, each bone bending 14° more than the last, animatable
extrude_chain {
  "segments": 6, "base_origin": [3.5, 32, -1], "segment_length": 2.4,
  "initial_size": [2.4, 2.4], "taper": 0.8, "curvature": [14, 0, -6],
  "direction": "up", "name": "horn", "side": "right", "parent": "head"
}

// A dragon wing: arm, forearm, 4 finger bones and a continuous membrane back to the body.
// Repeat with "side": "left" and base_origin x = -3 for the other wing.
add_wing {
  "side": "right", "base_origin": [3, 22, 2], "plane": "horizontal",
  "fingers": 4, "arm_length": 8, "forearm_length": 10, "finger_length": 18,
  "finger_spread": [0, 85], "parent": "chest"
}

// A blade: drawn as pixel art in the side plane, extruded into cubes
voxelize_matrix {
  "matrix": ["......####", ".....#####", "...#######", "..######..",
             ".#####....", "######....", "#####.....", "####......"],
  "palette": { "#": { "name": "blade", "depth": 1 } },
  "plane": "yz", "origin": [0, 18, -4], "merge_adjacent": true, "parent": "hand_right"
}

// The gate: is this actually a model yet?
audit_complexity { "target": "hero" }
// -> { "verdict": "acceptable", "ready_for_texturing": true, "cubes": 152,
//      "metrics": { "micro_pct": 34, "overlapping_pct": 61, "bone_depth": 6 }, "issues": [] }
```

</details>

## FAQ

**What is Blockbench MCP?**
It is a Model Context Protocol server plus a Blockbench plugin. Together they let an AI assistant control the Blockbench 3D editor: create and edit cubes, bones, textures and animations, and see the result through screenshots.

**Which AI clients work with it?**
Any MCP client that supports stdio servers: Claude Code, Claude Desktop, Cursor, and others.

**Which model formats are supported?**
Anything your Blockbench install supports: Minecraft Java Edition block/item models, Bedrock entities, GeckoLib animated models, generic models, and formats added by plugins (the AI can install those itself). `list_formats` shows what is available.

**Can I use it to make Minecraft mobs and mod assets?**
Yes. The examples above are Minecraft-style mobs, and the GeckoLib workflow produces model, texture and animation files ready for a Forge / Fabric / NeoForge mod. `export_model` also writes glTF for Godot, Unity and Blender.

**Does it work with the Blockbench web app?**
No. The bridge needs Node's `net` module, which only the desktop app exposes to plugins.

## Troubleshooting

**Blockbench shows "server stopped" and Start does nothing.**
The plugin needs the `net` module. When you click **Start MCP Server**, Blockbench shows a permission dialog; choose **"Always allow for this plugin."** If you denied it before, revoke and retry from the plugin's context menu, or restart Blockbench.

**MCP tools fail with "Cannot reach Blockbench on 127.0.0.1:8787".**
Make sure Blockbench is open, the plugin is loaded and the server is running (green toast, or `curl .../ping` works). Confirm the port in the plugin settings matches `BLOCKBENCH_MCP_PORT`.

**"Unknown format … the matching plugin must be installed."**
Plugin formats like GeckoLib's `geckolib_model` require `install_plugin { "id": "geckolib" }` first. Run `list_formats` to confirm the id appeared.

**Console 404s about `about.md` / the plugin store.**
Harmless. Blockbench tries to fetch store metadata for the side-loaded plugin and gets a 404. It does not affect the bridge.

## Security

- The bridge binds to **`127.0.0.1` only**, so it is not reachable from your network.
- Binding to localhost does not stop web pages in your browser from sending requests to it, so the bridge also refuses:
  - any request with an `Origin` header (browsers always send one on cross-origin requests; the MCP server does not);
  - any `Host` other than `127.0.0.1` / `localhost` / `[::1]` (blocks DNS rebinding);
  - `POST` bodies without `Content-Type: application/json`.

  It sends no CORS headers, so a page cannot read its responses either.
- **Trust boundary: the MCP client.** Anything that controls the connected client, including a model steered by prompt injection from a file, web page or image it reads, can drive every tool.
- **Web access is limited to images.** `find_references` / `load_reference {url}` run in the MCP server (not in Blockbench), force safe search, only fetch public `http(s)` addresses (localhost, LAN and link-local addresses are refused, including hostnames that resolve to them and every redirect hop), cap downloads at 15 MB and accept a file only if its bytes are a real PNG/JPEG/GIF/WebP/AVIF/BMP image.
- `execute_script` runs **unsandboxed JavaScript** with Blockbench's full privileges. Only connect MCP clients you trust, and prefer the dedicated tools where possible. If you don't need it, turn off **Settings ▸ General ▸ Allow execute_script**. The command is then rejected inside Blockbench and every other tool keeps working.

## Limitations

- **Desktop only.** The bridge relies on Node modules (`net`), which the Blockbench web app does not expose to plugins.
- **One Blockbench window.** The bridge talks to whichever project is currently active.
- Formats with box UV only (e.g. Java entity / OptiFine) cannot give thin cubes their own pixels; `pack_uv` warns about them. Java block models only rotate one axis in 22.5° steps, so use 8 or 16 sides for round parts there.
- `find_references` scrapes public image search pages; if an engine changes its markup it falls back to the next one.

## Development

```bash
npm run dev     # tsc --watch
npm run build   # one-off compile to dist/
npm test        # build, then run the tool-catalogue tests against dist/
```

- MCP tool definitions live in [`src/tools.ts`](src/tools.ts), the HTTP client in [`src/client.ts`](src/client.ts), the server entry in [`src/index.ts`](src/index.ts), and tests in [`test/tools.test.js`](test/tools.test.js) (Node's built-in runner, no extra dependencies).
- Bridge command handlers live in [`plugin/blockbench_mcp.js`](plugin/blockbench_mcp.js) under the `commands` object. Add a handler there and a matching tool in `tools.ts` to extend the surface.
- The Blockbench API used by the bridge is documented in the [official type definitions](https://github.com/JannisX11/blockbench/tree/master/types).

Issues and pull requests are welcome.

---

<div align="center">

<img src="assets/golem_nadr.png" alt="Stone golem Minecraft model built by AI with Blockbench MCP" width="220">

**If Blockbench MCP saved you some modeling time, a ⭐ helps other people find it.**

[MIT](LICENSE) © [sosadly](https://github.com/sosadly) · Built on the [Model Context Protocol](https://modelcontextprotocol.io/) · Not affiliated with Blockbench or GeckoLib.

</div>
