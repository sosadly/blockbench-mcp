# BlockbenchMCP

![MCP](https://img.shields.io/badge/MCP-server-6f42c1)
![Blockbench](https://img.shields.io/badge/Blockbench-4.8%2B-1f8cff)
![Node](https://img.shields.io/badge/Node-18%2B-339933)
![License: MIT](https://img.shields.io/badge/License-MIT-green)

> Let an AI build Minecraft models, textures and animations directly inside [Blockbench](https://www.blockbench.net/) — through the [Model Context Protocol](https://modelcontextprotocol.io/).

BlockbenchMCP gives an AI assistant a live connection to a running Blockbench window. The model can start a project from the start screen, build geometry (bones + cubes), **paint textures procedurally**, author **keyframe animations** (including [GeckoLib](https://github.com/bernie-g/geckolib)), **install Blockbench plugins**, move the camera, and **take screenshots so it can look at its own work and refine it** — all without you touching the editor.

<!-- Tip: add a screenshot or gif of a generated model here, e.g. ![demo](assets/demo.gif) -->

It was used to model, texture and animate a full GeckoLib grizzly bear (walk / run / sleep / attack) end-to-end from a single prompt.

---

## Table of contents

- [How it works](#how-it-works)
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Connecting your AI client](#connecting-your-ai-client)
- [Tool reference](#tool-reference)
- [Example: an animated GeckoLib bear](#example-an-animated-geckolib-bear)
- [Example: procedural detail](#example-procedural-detail)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Limitations](#limitations)
- [Development](#development)
- [License](#license)

---

## How it works

There are two pieces:

| Piece | Runs where | Responsibility |
|-------|-----------|----------------|
| **Bridge plugin** — [`plugin/blockbench_mcp.js`](plugin/blockbench_mcp.js) | Inside Blockbench (desktop) | Hosts a local HTTP endpoint on `127.0.0.1:8787` (built on Node's `net` module) and runs each command against the Blockbench API on the renderer thread. |
| **MCP server** — [`src/`](src/) → `dist/` | A Node process your AI client launches | Exposes Blockbench as MCP tools (stdio transport) and forwards every call to the bridge. |

```
┌────────────┐   stdio (MCP)   ┌──────────────────┐   HTTP 127.0.0.1:8787   ┌─────────────────────┐
│  AI client │ ──────────────▶ │  blockbench-mcp  │ ──────────────────────▶ │  Blockbench + plugin │
│ (Claude…)  │ ◀────────────── │   (Node server)  │ ◀────────────────────── │   (live editor)      │
└────────────┘                 └──────────────────┘                         └─────────────────────┘
```

## Features

- 🧱 **Modeling** — create bones (groups) and cubes one at a time or **in bulk** (`add_groups` / `add_cubes` build a whole posed skeleton in one call), with full rotation and inflate; edit/move/reparent/delete, and read the outliner tree.
- 🏗️ **Procedural detail** — the fix for models that come out as 15 flat boxes, because an LLM cannot compute 200 sets of `[from,to]` in its head. `voxelize_matrix` extrudes a character matrix into cubes (draw a blade, an emblem or a horn profile as pixel art and get geometry); `add_hollow_volume` builds a shell with a real cavity instead of a solid box (hoods, helmets, pauldrons, cages); `generate_array` repeats an element along a line, ring or grid with jitter, taper, per-element rotation and an anti-z-fighting depth stagger (torn hems, scales, plates, teeth, rivets); `extrude_chain` builds a tapering, curving chain with one bone per segment (horns, tails, tentacles, braids). Each one enforces the model's own left/right and returns a compact report instead of 300 serialized cubes.
- 📏 **Density gate** — `audit_complexity` grades the model against a cube budget (prop 30-60, mob 100-180, hero 180-300+) and reports monolithic boxes (one cube holding >30% of the volume with nothing layered on it), how much geometry actually overlaps, micro-detail density, bare flat faces and bone-hierarchy depth. Verdict `too_primitive` / `acceptable` / `high_detail`, so a blockout never reaches the texturing pass.
- 🎨 **Texturing** — create textures, paint procedurally (pixels, rects, lines, circles, **ellipses, polygons, dither, noise**, gradients), **auto-shade every cube face** with `detail_cubes` (no flat or untextured gaps), and place features in **face-relative coordinates** with `paint_faces`.
- 🦴 **Rigging** — `create_rig` builds a properly segmented humanoid or quadruped skeleton (three bones per limb, so elbows and knees can actually bend), joints on the real pivots, correct `*_left` / `*_right` naming and an optional blocked-out body; `check_rig` refuses to call a two-bone-limb rig animation-ready.
- 🎬 **Animation** — `generate_animation` writes a complete, direction-correct base cycle (idle / walk / run / attack / cast / jump / hurt / death / fly) with proper gait phasing, bent elbows and knees, body counter-rotation, follow-through and seamless loops; `add_keyframes` refines it in bulk with interpolation control.
- 📐 **Measured animation** — `analyze_animation` *evaluates* the rig and reports how far each hand, foot and head really travels forward / back / left / right in the model's own axes, whether the loop closes and whether the lower limb segments move at all. It is what catches an attack that swings into the model's back instead of at its target.
- 🧭 **Left/right that can't get flipped** — the model faces `-Z`, so its own right is `+X` (verified against Blockbench's vanilla data). `get_orientation`, `which_side` and `check_sides` answer the question from coordinates; `add_cube`/`add_group` take `side:"left"|"right"` and **refuse** a call whose coordinate contradicts it; and every screenshot is stamped with which image edge is the model's right — because a front view is mirrored.
- 🙋 **Human review gate** — `request_review` renders labelled views (or animation poses), shows them in the MCP Copilot panel and **blocks until the user presses a button**, returning their verdict and comment inside the same tool call. `ask_user` does the same for a question. The AI stops grading its own homework without interrupting the conversation.
- 🎯 **Reference matching** — drag a reference image into the **MCP Copilot panel**; the AI reads it (`get_reference`) and **scores its silhouette match** with `compare_reference` (an IoU `match_percent` + a `[reference | model | overlay]` composite and concrete "add/trim mass here" advice) plus numeric proportions via `measure_model`. Turns "does it match?" from an opinion into a number, so models actually resemble the reference instead of "almost".
- 📸 **Vision** — `screenshot`, **`screenshot_views`** (several angles at once, named from the *model's* point of view and captioned) and `get_texture` return images inline so the model can *see* and iterate; `check_model` audits for problems.
- 🧠 **Guidance** — `get_guide` returns playbooks for modeling, **detailing** (the cube budget and the 4-layer doctrine), orientation, rigging, texturing, VFX, animation, review and reference-matching, so the AI builds detailed, rotated models instead of a few flat boxes.
- 🪟 **In-app panel** — the **MCP Copilot** side panel shows server status, the reference drop zone, a live activity log of the AI's commands, model stats, the last match score — and any review the AI is currently waiting on, with thumbnails, a comment box and approve / needs-changes buttons.
- 🧩 **Plugins** — search, install (by store id, URL, or file) and uninstall Blockbench plugins, so the AI can set up formats like GeckoLib itself.
- 📦 **Export** — `export_project` uses the format's own codec; `export_model` writes through any named codec (default glTF: a self-contained `.gltf` that imports straight into Godot / Unity / Blender).
- 🔧 **Escape hatch** — `execute_script` runs arbitrary Blockbench JS for anything not covered by a dedicated tool.
- 🟢 **70 tools** total, all over a single local connection.

## Requirements

- **Blockbench desktop app**, version **4.8+** (the web app cannot host the bridge — see [Limitations](#limitations)).
- **Node.js 18+** (for global `fetch`).
- An MCP-capable client (Claude Code, Claude Desktop, Cursor, etc.).

## Installation

### 1. Install the bridge plugin in Blockbench

1. Open the **desktop** Blockbench app.
2. **File ▸ Plugins ▸ Load Plugin from File** and select [`plugin/blockbench_mcp.js`](plugin/blockbench_mcp.js).
   *(Alternatively copy it into your Blockbench `plugins` folder.)*
3. On first start the plugin asks for **network permission** (it needs the `net` module to host the local server). Choose **“Always allow for this plugin.”**
4. A toast confirms **“MCP server started on port 8787.”**
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

## Connecting your AI client

Point your client at `dist/index.js` over stdio. Use an **absolute path**.

**Claude Code** — `.mcp.json` in your project (or `claude mcp add`):

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

**Claude Desktop** — `claude_desktop_config.json`:

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
| **Reference matching** | `get_reference`, `load_reference`, `compare_reference`, `measure_model`, `list_references`, `clear_references` |
| **Project** | `new_project`, `set_project_meta`, `save_project`, `export_project`, `export_model`, `load_project`, `close_project` |
| **Geometry** | `add_group`, `add_cube`, `add_groups`, `add_cubes`, `add_plane`, `add_mesh`, `mirror_element`, `edit_element`, `delete_element`, `list_outliner`, `get_element`, `pack_uv` |
| **Procedural detail** | `voxelize_matrix`, `add_hollow_volume`, `generate_array`, `extrude_chain`, `add_wing` |
| **Quality gates** | `audit_complexity`, `check_model`, `check_sides`, `check_rig` |
| **Rigging** | `create_rig`, `check_rig`, `get_rig` |
| **UV & textures** | `create_texture`, `create_vfx_texture`, `paint_texture`, `detail_cubes`, `paint_faces`, `apply_texture`, `set_cube_uv`, `set_texture_render_mode`, `import_texture`, `resize_texture`, `list_textures`, `get_texture` |
| **Animation** | `generate_animation`, `analyze_animation`, `preview_animation`, `create_animation`, `add_keyframe`, `add_keyframes`, `list_animations`, `remove_animation` |
| **View** | `set_camera_angle`, `screenshot`, `screenshot_views` |
| **Plugins** | `list_plugins`, `install_plugin`, `uninstall_plugin` |
| **Escape hatch** | `execute_script` |

Conventions: coordinates are **Blockbench units**; rotations are **degrees**; texture pixel ops use a **top-left origin with y pointing down**. `add_cube` returns each face's resolved UV rect; `detail_cubes` then base-coats every face and `paint_faces` lets you paint features (eyes, nose, claws) in coordinates relative to a face, so you don't compute absolute UVs by hand.

**Orientation.** A model faces `-Z`, so **its own right is `+X`** and its left is `-X`. This is verified against Blockbench's bundled vanilla data: Bedrock's `rightArm`, stored at `x = -5`, is loaded by Blockbench at `x = +5` (the Bedrock/Java codecs mirror X on import and export). Camera views are named from the model's point of view — `front` shows its face — and every capture is captioned with which image edge is the model's right, because a front view is mirrored just like facing a person.

**Rotation signs.** `+X` rotation lifts a bone's front, so a **down-pointing** bone (arm, leg) swings its tip **forward** while an **up-pointing** bone (torso, neck) tips **backward**. Elbows bend `+X`, knees bend `-X`, and `+Y` turns the model toward its own left. `generate_animation` applies these for you and `analyze_animation` verifies the result by measurement.

## Example: an animated GeckoLib bear

The sequence an AI follows for *“make a textured GeckoLib bear that can walk, run, sleep and attack”*:

```jsonc
// 0. Read the playbook so the model comes out detailed and rotated, not boxy
get_guide {}

// 1. Install GeckoLib (adds the `geckolib_model` format)
install_plugin { "id": "geckolib" }

// 2. New project, straight from the start screen
new_project { "format": "geckolib_model", "name": "bear",
              "texture_width": 64, "texture_height": 64 }

// 3. Lay out the whole posed skeleton in one call — note the rotated bones
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

## Example: procedural detail

The same few calls turn a 20-cube blockout into a 150-cube model. None of the tools knows what
a hood or a scale is — they are extrusion, shells, arrays and chains.

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

## Troubleshooting

**Blockbench shows “server stopped” and Start does nothing.**
The plugin needs the `net` module. When you click **Start MCP Server**, Blockbench shows a permission dialog — choose **“Always allow for this plugin.”** If you previously denied it, revoke and retry from the plugin's context menu, or restart Blockbench.

**MCP tools fail with “Cannot reach Blockbench on 127.0.0.1:8787”.**
Make sure Blockbench is open, the plugin is loaded, and the server is running (green toast / `curl .../ping` works). Confirm the port in the plugin settings matches `BLOCKBENCH_MCP_PORT`.

**“Unknown format … the matching plugin must be installed.”**
Plugin formats like GeckoLib's `geckolib_model` require `install_plugin { "id": "geckolib" }` first. Run `list_formats` to confirm the id appeared.

**Console 404s about `about.md` / the plugin store.**
Harmless — Blockbench tries to fetch store metadata for the side-loaded plugin and gets a 404. It does not affect the bridge.

## Security

- The bridge binds to **`127.0.0.1` only** — it is not reachable from your network.
- Binding to localhost does not stop web pages in your browser from sending requests to it, so the bridge also refuses:
  - any request with an `Origin` header (browsers always send one on cross-origin requests; the MCP server does not);
  - any `Host` other than `127.0.0.1` / `localhost` / `[::1]` (blocks DNS rebinding);
  - `POST` bodies without `Content-Type: application/json`.

  It sends no CORS headers, so a page cannot read its responses either.
- **Trust boundary: the MCP client.** Anything that controls the connected client — including a model steered by prompt injection from a file, web page or image it reads — can drive every tool.
- `execute_script` runs **unsandboxed JavaScript** with Blockbench's full privileges. Only connect MCP clients you trust, and prefer the dedicated tools where possible. If you don't need it, turn off **Settings ▸ General ▸ Allow execute_script**. The command is then rejected inside Blockbench and every other tool keeps working.

## Limitations

- **Desktop only.** The bridge relies on Node modules (`net`), which the Blockbench web app does not expose to plugins.
- **One Blockbench window.** The bridge talks to whichever project is currently active.
- Box-UV packing is up to the caller; `add_cube` returns resolved face UVs to make this manageable.

## Development

```bash
npm run dev     # tsc --watch
npm run build   # one-off compile to dist/
npm test        # build, then run the tool-catalogue tests against dist/
```

- MCP tool definitions live in [`src/tools.ts`](src/tools.ts); the HTTP client in [`src/client.ts`](src/client.ts); the server entry in [`src/index.ts`](src/index.ts); tests in [`test/tools.test.js`](test/tools.test.js) (Node's built-in runner, no extra dependencies).
- Bridge command handlers live in [`plugin/blockbench_mcp.js`](plugin/blockbench_mcp.js) under the `commands` object — add a handler there and a matching tool in `tools.ts` to extend the surface.
- The Blockbench API used by the bridge is documented in the [official type definitions](https://github.com/JannisX11/blockbench/tree/master/types).

## License

[MIT](LICENSE) © [sosadly](https://github.com/sosadly)

Built with the [Model Context Protocol](https://modelcontextprotocol.io/). Not affiliated with Blockbench or GeckoLib.
