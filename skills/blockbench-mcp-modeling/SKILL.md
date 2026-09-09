---
name: blockbench-mcp-modeling
description: Build high-quality Minecraft / GeckoLib / Bedrock models, textures and animations in Blockbench through the BlockbenchMCP server (the mcp__blockbench__* tools). Use whenever the user asks to create, model, texture, rig, retexture or animate a creature, character, mob, weapon, prop or item in Blockbench, wants to match a reference image, or mentions the blockbench MCP. Encodes the cube-budget and layering doctrine, the procedural generators (voxelize_matrix, add_hollow_volume, generate_array, extrude_chain) and ready-to-paste execute_script snippets, so models come out at 100-300 cubes of real detail instead of 15 flat boxes.
---

# Blockbench MCP Modeling Operator Guide

This skill makes you good at driving Blockbench through the **BlockbenchMCP** bridge
(`mcp__blockbench__*` tools). It encodes a modeling doctrine and a set of scripts verified live
against Blockbench 5.1.4 + GeckoLib.

**The failure this skill exists to prevent:** you cannot hold a 3D coordinate system in your
head, so when asked for a hooded warrior you emit one box for the torso, one for the cloak and
one for the head — 15 monoliths, no layers, no silhouette. That is a tooling problem, and the
tooling now exists. Your job is the SHAPE and the LAYERS; the generators do the arithmetic.

## Connection check (do this first)

The tools talk to a local server **inside** Blockbench. If a tool returns
`Cannot reach Blockbench on http://127.0.0.1:8787`:
- The desktop Blockbench app must be **open** and the **MCP server started**: in Blockbench,
  `Tools ▸ Start MCP Server`, or the **MCP Copilot** side panel's Start button. The server
  stops when Blockbench is closed.
- Then call `get_status` to confirm. Before building, read `get_guide {topic:"detailing"}`.
- The **MCP Copilot panel** is where the user drops a reference image, watches your activity
  log, and sees the live match score. If they mention a reference, call `get_reference`.

## 1. Cube budget — the non-negotiable floor

| What you are building | Cubes |
|---|---|
| Simple prop / small item (potion, key, dagger, crate) | **30–60** |
| Standard mob / NPC / creature | **100–180** |
| Hero model / boss / detailed character | **180–300+** |

**A humanoid built from fewer than 70 cubes is a draft, not a model.** It does not go to
texturing, it does not go to review, it gets more geometry. `audit_complexity` is the gate and
returns `too_primitive` / `acceptable` / `high_detail` — treat `too_primitive` as an
instruction, not an opinion.

Cube count is necessary, not sufficient: 200 cubes in one flat plane is still flat. The budget
buys you the four layers below.

## 2. The 4-layer doctrine — build outward

**Layer 0 — Core frame / void.** The skeleton (`create_rig`) and the *dark cavities* other
layers sit over: the void inside a hood, the gap between armour plates, the inside of a mouth,
an empty eye socket. Cavities are what read as depth. `add_hollow_volume` makes them.

**Layer 1 — Primary mass.** Torso in 2–3 blocks, **every limb in at least 3 segments**
(upper / lower / hand-or-foot), neck, head. Never one cube per limb.

**Layer 2 — Secondary volumes / outer shell.** Chest plate, pauldrons, bracers, belt, hood,
boots, collar, fur mantle. These are **separate cubes standing 0.3–0.8 units proud** of Layer 1
— not a recoloured part of it. Anything that *wraps* is `add_hollow_volume`.

**Layer 3 — Fringes & silhouette breakers.** Torn hems, shingles, scales, feathers, spikes,
teeth, plate rows, and cubes rotated 15–45° that break the square outline. One
`generate_array` call per row. A silhouette with no interruptions reads as a box no matter how
good the texture is.

**Layer 4 — Micro-voxels & props.** 1x1 and 1x2 details — studs, buckles, rivets, stitching,
gem settings, eyes — plus the held weapon or tool. `voxelize_matrix` draws blades, emblems and
flat detail from a character grid; `extrude_chain` builds horns, tails, tentacles and braids.

## 3. Banned shapes (each is an automatic rebuild)

- **One cube for a cloak, cape or skirt.** Segment it vertically (3–5 panels), then finish the
  bottom with a `generate_array` fringe row (`anchor:'top'`, `depth_stagger:0.05–0.2`).
- **One solid cube for a head that wears a hood, helmet or mask.** The head is Layer 1; the
  covering is `add_hollow_volume` with the face (`north`) and neck (`down`) open.
- **One cube per limb.** Three segments minimum, or every animation looks like cardboard.
- **A large flat face with nothing on it.** Overlay trim, a 45° bevel cube, or a fringe row.
  `audit_complexity` reports these as `undetailed_slab`, naming the offending face.
- **A weapon or emblem hand-placed cube by cube.** Draw it as a matrix and voxelize it.

## 4. The generators (universal — none of them knows what a hood or a scale is)

| Tool | What it does | Use it for |
|---|---|---|
| **`voxelize_matrix`** | Extrudes a character matrix into cubes | Blades, axe heads, bows, horn profiles, shield emblems, fins, wings, chevrons, gears, plate patterns, tattered banners |
| **`add_hollow_volume`** | A shell with a cavity instead of a solid box | Hoods, helmets, masks, visors, eye sockets, breastplates, pauldrons, bracers, collars, cages, pipes, wheels, crates |
| **`generate_array`** | Repeats an element along a line / ring / grid | Hems, shingles, scales, feathers, armour plates, teeth, spinal spikes, rivets, fence posts, chain links, ribs |
| **`extrude_chain`** | A tapering, curving chain, one bone per segment | Horns, antlers, tails, tentacles, claws, tusks, branches, snake bodies, braids, cables, antennae |
| **`audit_complexity`** | Measures budget, monoliths, layering, micro-detail, bare faces | The gate before texturing |

Key parameters worth remembering:

- `voxelize_matrix {matrix, palette, plane, origin, pixel_size, merge_adjacent}` — rows run
  top-to-bottom, `' '` and `'.'` are empty. `plane:'xy'` front view, `'xz'` top view,
  `'yz'` side view (column 0 at the model's FRONT). Per character, `palette` sets
  `{name, depth, offset_z, inflate}` — `name` is what `detail_cubes` colour rules match on, and
  `offset_z` layers a rim in front of a core. `merge_adjacent:true` for anything over ~60 cells.
- `add_hollow_volume {bounds:{from,to}, wall_thickness, open_faces}` — faces are world names:
  **north = -Z = the model's front**, south = +Z, east = +X, west = -X, up, down (the words
  front/back/left/right/top/bottom are accepted too). The walls tile the shell exactly, so they
  never z-fight each other. It returns the `cavity` bounds — fill them.
- `generate_array {mode, count, element_size, ...}` — `anchor:'top'` hangs elements from their
  point (fringes), `'bottom'` stands them on it (spikes). `jitter` breaks the stamped look,
  `size_decay` tapers the run, `rotation_range` gives each element its own tilt, and
  **`depth_stagger` is the anti-z-fighting control — always pass 0.05–0.2 for overlapping rows.**
  `seed` makes the randomness reproducible.
- `extrude_chain {segments, base_origin, segment_length, initial_size, taper, curvature}` —
  `create_bones:true` (the default) nests one bone per segment, which is what gives a tail its
  follow-through. Each bone adds `curvature` on top of its parent, so segment *i* sits at
  `base_rotation + i × curvature`. Returns `tip` — the world position where the chain ends.

Use the generators for repetitive mass and `add_cubes` for the shapes only you can judge.

## 5. Depth discipline (this is what makes layers read as layers)

- Layer 2 stands **0.3–0.8** proud of Layer 1. Less reads as a texture; more detaches.
- Overlapping decorative pieces must **never share a plane**: stagger neighbours by **0.05–0.2**
  (`generate_array`'s `depth_stagger` does it for you). Two coplanar faces z-fight — the
  flickering "two squares inside each other".
- When two cubes overlap, let one clearly **penetrate** the other by ≥0.1 (ideally ~0.5).
- `check_model` reports `coplanar_overlap` pairs. Fix every one.
- **The generators grade their own output.** Each returns `z_fight_pairs` when cubes it just
  made share a face plane (a row where each element overlaps *two* neighbours still lines up,
  and elements at the same height share their top/bottom planes) plus the fix to apply — more
  `jitter`, wider spacing, or a small `rotation_range`. Act on it in the same pass.

## The pipeline (loop it; the first pass is never good enough)

```
1  get_reference        SEE the target; split the silhouette into the four layers
2  get_status / get_guide {topic:"detailing"}
3  create_rig           anatomy, joints on pivots, 3-segment limbs, correct L/R
4  add_cubes            Layer 1 primary mass
5  add_hollow_volume    Layer 0 cavities + Layer 2 shells (hood, helmet, armour)
6  generate_array       Layer 3 fringes, plates, scales, teeth, rivets
7  voxelize_matrix / extrude_chain   Layer 4 weapons, emblems, horns, micro-detail
8  audit_complexity     verdict must not be too_primitive
   compare_reference    silhouette match_percent >= 85
   check_model          zero coplanar_overlap / untextured faces / unparented cubes
   -> FIX the biggest problem, then repeat from 4
9  pack_uv -> create_texture -> detail_cubes (gradient bake) -> paint_faces (features)
10 check_rig -> generate_animation -> analyze_animation -> refine -> preview_animation
11 request_review       the USER decides it is done, per milestone
12 save_project + export
```

## Two rules that override your own judgement

**1. You cannot tell left from right in a render.** A front view is mirrored — the model's
right hand appears on the LEFT of the image, exactly like facing a person. The model faces
`-Z`, so its OWN right is `+X` (verified against Blockbench's vanilla data: Bedrock `rightArm`
pivot `x=-5` loads at Blockbench `x=+5`). Never infer a side from a picture:

- `get_orientation` — the axis rules for this project.
- `which_side {element}` — "hand_left sits on the model's LEFT".
- `check_sides` — audits every left/right NAME against the geometry.
- Pass `side:'left'|'right'` to `add_cube`/`add_cubes`/`add_group` **and to every generator**
  (`voxelize_matrix`, `add_hollow_volume`, `generate_array`, `extrude_chain`); the call is
  REFUSED if the coordinate contradicts it, so a mirrored horn cannot be created by accident.
- Screenshots are stamped with which image edge is the model's right — read the stamp.

**2. You cannot sign off your own work.** Looking at your own screenshot and saying "looks
good" is the failure users complain about most. After every user-visible milestone call
**`request_review`**: it renders labelled views (or animation poses), shows them in the MCP
Copilot panel and BLOCKS until the user presses a button, returning their verdict and comment
inside the same tool call. Use `ask_user` when a decision is genuinely theirs (which hand, which
palette) instead of guessing. A timeout is NOT approval. Run the objective checks
(`audit_complexity`, `check_model`, `check_sides`, `check_rig`, `analyze_animation`,
`compare_reference`) first so you don't spend their attention on something a tool would catch.

## Reference matching (do not build blind)

The most common failure is building from a fuzzy memory of the reference and then rationalising
the result ("close enough"). Use the reference engine so the match is a measured number:

- **`get_reference`** — returns the image(s) the user dropped into the **MCP Copilot panel**
  (or that you `load_reference`-d). Look at it before and during the build.
- **`compare_reference {view?}`** — renders your model from the reference angle on a
  transparent background and returns **`match_percent`** (silhouette IoU 0-100),
  `aspect_delta_pct`, `ref_only_pct` (reference area with NO model = you're **missing mass**),
  `model_only_pct` (**extra mass**), a verdict + advice, and a **composite image**
  `[reference | your model | overlay]`. In the overlay: **RED = reference-only (add mass),
  BLUE = model-only (trim), WHITE = match.** Call it EVERY pass; iterate to `match_percent >= 85`
  (90+ for hero assets).
- **`measure_model`** — bounding box + per-bone sizes + ratios (e.g. `head_height_fraction`).

**Rule:** never declare a match by eye when a compare score exists. 72% is not "great".

## Hard rules (the difference between good and bad)

1. **Density before texture.** `audit_complexity` must not say `too_primitive`, and
   `compare_reference` must be ≥85, BEFORE you spend a texturing pass. Texturing a blockout
   wastes the whole pass and hides the real problem.

2. **Box UV does NOT auto-pack.** Newly created cubes all get `uv_offset [0,0]` and overlap.
   Run **`pack_uv`** (or the shelf-packer script) after the LAST geometry call and before
   texturing, and re-pack whenever you add or resize cubes.

3. **Texture SMOOTH, not noisy.** Per face: a soft vertical gradient in the base colour +
   directional shading (up lighter, down darker) + *subtle* low-contrast mottle, then a **3x3
   box blur per UV island**. No harsh per-pixel noise, no dark 1px outline on every face — that
   reads as a dirty grid. Paint crisp features (eyes/claws) AFTER the blur. `detail_cubes` does
   the base coat; its `colors` regex list matches on **cube names**, which is exactly why the
   generators let you name what they produce.

4. **Use rotation.** A single cube rotates cleanly on one axis; for compound angles put it in a
   GROUP and rotate the group, or nest groups. A bone's `+X` rotation tilts its front (`-Z`) up,
   so a DOWN-pointing bone (arm/leg) swings its tip FORWARD and an UP-pointing bone (torso/neck)
   tips BACKWARD. See references/rigging-and-animation.md.

5. **Limbs need THREE bones** (upper / lower / hand-or-foot) or there is no elbow or knee.
   `create_rig` builds this; `check_rig` must say `ready_to_animate` before you animate. Elbows
   bend `+X`, knees bend `-X`.

6. **Measure animations, never eyeball them.** `analyze_animation` reports how far each
   hand/foot/head really travels FORWARD/BACK/LEFT/RIGHT, whether the loop closes and whether
   the lower limb segments move at all. Start from `generate_animation` and refine with
   `add_keyframes {close_loop:true}` — 6-9 keyframes per moving bone, whole body moving.

7. **Glow / emissive** (lanterns, eyes, gems): name those cubes `*_core`; the bake fills them
   BRIGHT with no dark shading and no blur. Generators accept the name, so
   `palette:{'o':{name:'eye_core'}}` is enough to make a voxelized eye glow.

8. **REVIEW CRITICALLY.** When a screenshot looks off, FIX it — never write "good enough" about
   a flaw you can see. Compare against the reference, not your own lowered bar.

## Tool cheat-sheet

- Discover/plan: `get_status`, `get_guide` (topics: **detailing**, modeling, orientation,
  rigging, texturing, vfx, animation, review, reference), `list_outliner`, `get_element`,
  `list_formats`.
- Sides: `get_orientation`, `which_side`, `check_sides`.
- Reference-match: `get_reference`, `load_reference`, `compare_reference`, `measure_model`,
  `list/clear_references`.
- Build: `add_groups`, `add_cubes` (bulk), **`voxelize_matrix`**, **`add_hollow_volume`**,
  **`generate_array`**, **`extrude_chain`**, `add_plane`, `add_mesh`, `edit_element`,
  `delete_element`, `mirror_element`.
- Rig: `create_rig` (humanoid/quadruped, segmented), `check_rig`, `get_rig`.
- Quality gates: **`audit_complexity`** (density + monoliths + layering), `check_model`
  (z-fighting, untextured faces, UVs), `check_sides`, `check_rig`.
- Texture: `pack_uv`, `create_texture`, `detail_cubes`, `paint_faces`, `paint_texture`,
  `get_texture`, `apply_texture`, `create_vfx_texture`, `set_texture_render_mode`.
- Review: `screenshot`, `screenshot_views`, **`request_review`**, **`ask_user`**.
- Animate: `generate_animation`, `analyze_animation`, `preview_animation`, `create_animation`,
  `add_keyframes`, `list_animations`.
- Export: `save_project`, `export_project`, `export_model` (glTF/other codecs to a path).
- Escape hatch: `execute_script` — full Blockbench API. An explicit `return` is required;
  returned Promises are awaited.

## Reference files (read the one you need before acting)

- **references/workflow-and-scripts.md** — paste-ready `execute_script` snippets: matrix
  voxelizer, array/shingle generator, hollow shell, UV shelf-packer, the parameterised smooth
  bake, feature painting, pose preview, exports.
- **references/proportions-and-review.md** — sizing animals & humanoids, the per-pass review
  checklist (flat surfaces, z-fighting, layering), and worked lessons.
- **references/rigging-and-animation.md** — humanoid & quadruped rigs, rotation-sign facts, and
  keyframe recipes for idle / walk / run / attack / sleep.

## Gotchas (verified)

- **`require` is NOT available inside `execute_script`.** To write files use
  `Blockbench.writeFile(path, { content, savetype })` — `savetype:'image'` with a dataURL for
  PNG, `savetype:'text'` for JSON.
- **Views are model-relative.** `screenshot_views {views:['front']}` shows the creature's FACE.
  For an exact reference angle pass `{position,target}`.
- **Array arguments may arrive as a string.** The server now coerces JSON text, comma lists and
  newline blobs against each tool's schema, and the bridge parses them again — so
  `matrix: "..#..\n.###."` and `open_faces: "north,down"` both work. If a bulk tool still
  errors, do the work in `execute_script`.
- **Animation export**: `Animator.buildFile(undefined, false)` returns the bedrock/GeckoLib
  animation object — stringify and `Blockbench.writeFile` it. Geometry exports via
  `export_project`.
- **Reset before saving**: `Modes.options.edit.select()` + `Timeline.setTime(0)` so the saved
  file shows the rest pose.
- **GeckoLib**: store plugin id `geckolib`, format id `geckolib_model` (box_uv, animation_mode).
  `install_plugin {id:'geckolib'}` is idempotent.
- **Generator budget**: each generator refuses to create more than 1500 cubes in one call
  (`max_cubes` raises or lowers it). If you hit that, you are describing the whole model in one
  call — split it per part.
