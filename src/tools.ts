/**
 * Tool catalogue for the BlockbenchMCP server.
 *
 * Each tool maps (mostly 1:1) onto a command handled by the bridge plugin.
 * Handlers return MCP content blocks; screenshots and texture reads return
 * image blocks so the model can actually *see* the result.
 */
import { callBlockbench } from "./client.js";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, any>) => Promise<ContentBlock[]>;
}

// ---- schema helpers --------------------------------------------------------
const vec3 = (desc: string) => ({
  type: "array",
  items: { type: "number" },
  minItems: 3,
  maxItems: 3,
  description: desc,
});
const obj = (
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
});

export function text(value: unknown): ContentBlock[] {
  // JSON.stringify(undefined) returns undefined (not a string), which would
  // produce an invalid content block ({type:"text", text: undefined}). Coerce.
  const body = (typeof value === "string" ? value : JSON.stringify(value, null, 2)) ?? "(undefined)";
  return [{ type: "text", text: body }];
}

/** Tool whose result is just the JSON returned by the bridge. */
function forward(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  action = name
): ToolDef {
  return {
    name,
    description,
    inputSchema,
    handler: async (args) => text(await callBlockbench(action, args)),
  };
}

// ---------------------------------------------------------------------------
export const tools: ToolDef[] = [
  // ===== status & discovery ================================================
  forward(
    "get_status",
    "Get the current Blockbench state: open project, format, counts of cubes/groups/textures/animations, and edit mode. Call this first to understand the workspace. If you are about to BUILD or TEXTURE a model, call get_guide first.",
    obj({})
  ),
  forward(
    "get_guide",
    "Return a playbook. Pass `topic`: 'modeling' (default — proportions, detail, rotation), 'texturing' (the smooth @volmur/Hytale look, no dirty noise), 'vfx' (pixelated flames/energy/projectiles/trails/auras via planes + emissive textures + animation), 'animation' (rigging, gaits, easing), or 'reference' (how to ACTUALLY match a reference image instead of 'almost'). READ the relevant topic BEFORE building/texturing/animating — it dramatically improves results.",
    obj({
      topic: {
        type: "string",
        enum: ["modeling", "texturing", "vfx", "animation", "reference"],
        description: "Which playbook to return. Default 'modeling'.",
      },
    })
  ),
  forward(
    "list_formats",
    "List all model formats available in this Blockbench install (e.g. free, java_block, bedrock, and any added by plugins such as GeckoLib's animated_entity). Use the returned `id` with new_project.",
    obj({})
  ),

  // ===== project lifecycle =================================================
  forward(
    "new_project",
    "Create a new project from the start screen, choosing a format. This is the entry point for any new model.",
    obj(
      {
        format: {
          type: "string",
          description:
            "Format id or name (e.g. 'free', 'java_block', 'bedrock', 'geckolib_model' for GeckoLib). Use list_formats to discover ids. The matching plugin must be installed for plugin formats.",
        },
        name: { type: "string", description: "Project / model name." },
        geometry_name: { type: "string", description: "Optional geometry identifier (Bedrock/GeckoLib)." },
        texture_width: { type: "number", description: "UV/texture width (default 16)." },
        texture_height: { type: "number", description: "UV/texture height (default 16)." },
      },
      ["format"]
    )
  ),
  forward(
    "set_project_meta",
    "Update the open project's name, geometry name, or texture resolution.",
    obj({
      name: { type: "string" },
      geometry_name: { type: "string" },
      texture_width: { type: "number" },
      texture_height: { type: "number" },
    })
  ),
  forward("close_project", "Close the currently open project.", obj({})),
  forward(
    "save_project",
    "Save the open project as a .bbmodel. Provide `path` to save to a specific file (desktop), otherwise Blockbench's save flow is used.",
    obj({ path: { type: "string", description: "Absolute file path to save to (optional)." } })
  ),
  forward(
    "export_project",
    "Export the project through its format's codec (e.g. Java model JSON, Bedrock geometry, GeckoLib model). Provide `path` to write a file directly.",
    obj({ path: { type: "string", description: "Absolute output path (optional)." } })
  ),
  forward(
    "export_model",
    "Export the open project to a file via a named codec (default glTF). Compiles the model — awaiting async codecs such as Codecs.gltf — and writes the result to `path`. For glTF the output is a self-contained .gltf JSON with embedded buffers/textures, importable by Godot/Unity/etc. Prefer this over execute_script for exports.",
    obj(
      {
        path: { type: "string", description: "Absolute output file path (e.g. /abs/path/model.gltf)." },
        codec: { type: "string", description: "Codec id (default 'gltf'). Others include 'bedrock', 'java_block', 'optifine_entity', etc. — the keys of Blockbench's Codecs map." },
        format: { type: "string", description: "Format option passed to compile (e.g. 'gltf' or 'glb'). Defaults to the codec id." },
      },
      ["path"]
    )
  ),
  forward(
    "load_project",
    "Load a .bbmodel project file from disk (desktop only).",
    obj({ path: { type: "string", description: "Absolute path to a .bbmodel file." } }, ["path"])
  ),

  // ===== outliner / geometry ===============================================
  forward(
    "add_group",
    "Add a group / bone to the outliner. Groups are the bones used for animation AND the way to apply free 3-axis rotation: a cube alone rotates cleanly on only one axis, so to pose a part at a compound angle, put it in a rotated group (nest groups for multi-axis angles). Set `origin` to the real joint so rotation pivots correctly. Returns the created group with its uuid.",
    obj({
      name: { type: "string" },
      origin: vec3("Pivot point [x,y,z] — put this at the real joint (shoulder/hip/neck)."),
      rotation: vec3("Initial rotation in degrees [x,y,z]. Use it to pose limbs, snout, ears, tail."),
      parent: { type: "string", description: "uuid or name of the parent group (omit for root)." },
    })
  ),
  forward(
    "add_cube",
    "Add a cube to the model. Coordinates are in Blockbench units. Cubes support `rotation` (degrees) and `inflate` (round/shrink without moving) — use them; flat axis-aligned boxes look robotic. For compound multi-axis angles, parent the cube to a rotated group instead. Prefer add_cubes to build many cubes at once. Returns the created cube with uuid and resolved face UVs (paint onto those with paint_faces).",
    obj(
      {
        name: { type: "string" },
        from: vec3("Lower corner [x,y,z]."),
        to: vec3("Upper corner [x,y,z]."),
        origin: vec3("Rotation pivot [x,y,z] (defaults to `from`)."),
        rotation: vec3("Rotation in degrees [x,y,z]. Single-axis is most reliable per cube."),
        inflate: { type: "number", description: "Inflate (+) or shrink (-) all faces in place — use for rounding/taper." },
        autouv: { type: "number", enum: [0, 1, 2], description: "0 disabled, 1 auto, 2 relative auto." },
        box_uv: { type: "boolean", description: "Use box UV (default follows the format)." },
        uv_offset: { type: "array", items: { type: "number" }, description: "[u,v] offset for box UV." },
        parent: { type: "string", description: "uuid or name of the parent group." },
        faces: {
          type: "object",
          description:
            "Optional per-face setup, keyed by north/south/east/west/up/down. Each: {uv:[x1,y1,x2,y2], rotation, texture: name|uuid}.",
        },
      },
      ["from", "to"]
    )
  ),
  forward(
    "add_groups",
    "Create many bones/groups in one call — the fast way to lay out a whole skeleton. Pass `groups`: an array of {name, origin, rotation, parent}. A group's `parent` may reference another group created earlier in the SAME call by name, so you can build a nested, pre-posed bone hierarchy at once.",
    obj(
      {
        groups: {
          type: "array",
          description: "Array of group specs: {name, origin:[x,y,z], rotation:[x,y,z], parent:name|uuid}.",
          items: { type: "object" },
        },
      },
      ["groups"]
    )
  ),
  forward(
    "add_cubes",
    "Create many cubes in one call — the efficient way to author a detailed model (aim for 20-50+ cubes for a creature, not 6-8). Pass `cubes`: an array where each item takes the same fields as add_cube ({name, from, to, origin, rotation, inflate, parent, box_uv, uv_offset, faces}). Build symmetric parts by emitting both the left side and its mirror (negate X, flip Y/Z rotation signs) in the same array. AVOID Z-FIGHTING: when cubes overlap, make one clearly penetrate the other (by >=0.1) and never align two faces to the exact same coordinate; stagger decorative pieces' depths. Returns all created cubes with their face UVs.",
    obj(
      {
        cubes: {
          type: "array",
          description: "Array of cube specs (each like add_cube's args).",
          items: { type: "object" },
        },
      },
      ["cubes"]
    )
  ),
  forward(
    "check_model",
    "Audit the model for problems that make results look broken: untextured faces (the 'gaps'), zero-area or out-of-bounds UVs, degenerate cube sizes, cubes not parented to a bone in animated formats, and Z-FIGHTING (coplanar_overlap — two faces on the same plane that flicker/clip, the 'two squares inside one another'). Run this after building and before/after texturing, then fix what it reports (for coplanar_overlap, nudge one cube by >=0.1 so the faces aren't coplanar). Returns a grouped issue list.",
    obj({})
  ),
  forward(
    "pack_uv",
    "Shelf-pack the box UVs so every cube gets its own region of the texture. REQUIRED before texturing a box_uv model (GeckoLib/Bedrock): newly created cubes all sit at uv_offset [0,0] and otherwise paint onto the same pixels. Re-run after adding or resizing cubes. Auto-grows the texture (preserving paint) if the layout overflows.",
    obj({
      cubes: {
        oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        description: "'all' (default), or specific cube names/uuids.",
      },
      padding: { type: "number", description: "Pixels between UV islands (default 1)." },
      auto_resize: { type: "boolean", description: "Grow the texture if packing overflows (default true)." },
    })
  ),
  forward(
    "add_plane",
    "Create a flat 2-sided plane (billboard) — the building block of pixel VFX (flames, energy sheets, slashes, motion trails) and for thin details (fins, leaves, paper). It is a zero-depth cube whose two large faces carry the texture; pair it with a VFX texture set to render_sides 'double'. `crossed:true` makes an X of two perpendicular planes for a volumetric particle look. Parent it to a bone to animate it.",
    obj(
      {
        name: { type: "string" },
        from: vec3("Lower corner [x,y,z] (one corner of the plane)."),
        width: { type: "number", description: "Plane width in units (default 16)." },
        height: { type: "number", description: "Plane height in units (default 16)." },
        facing: { type: "string", enum: ["x", "y", "z"], description: "Axis the plane faces (default 'z' = faces ±Z; 'y' = flat horizontal)." },
        origin: vec3("Rotation pivot (defaults to plane centre)."),
        rotation: vec3("Rotation in degrees [x,y,z]."),
        crossed: { type: "boolean", description: "Add a second perpendicular plane (volumetric particle)." },
        texture: { type: "string", description: "Texture to apply (defaults to the project default)." },
        parent: { type: "string", description: "uuid or name of the parent bone/group." },
      },
      ["from"]
    )
  ),
  forward(
    "add_mesh",
    "Create a non-cuboid MESH primitive so models aren't limited to axis-aligned boxes — crystals/gems/shards, pyramids, wedges, cones, cylinders, planes. Great for crystal cores, blades, horns, teeth, gems and stylised VFX. NOTE: meshes need a mesh-capable format (free/generic/bedrock); GeckoLib & Java export cubes only — for those build crystals from cubes rotated 45° instead.",
    obj(
      {
        name: { type: "string" },
        shape: {
          type: "string",
          enum: ["crystal", "gem", "shard", "diamond", "octahedron", "pyramid", "wedge", "prism", "cone", "cylinder", "plane"],
          description: "Primitive shape (default 'crystal').",
        },
        size: vec3("Bounding size [w,h,d] (default [8,8,8]). For a shard make h large."),
        from: vec3("Lower-corner placement of the bounding box (defaults to centred on x/z at y=0)."),
        origin: vec3("Rotation pivot (defaults to the shape centre)."),
        rotation: vec3("Rotation in degrees [x,y,z]."),
        segments: { type: "number", description: "Radial segments for cone/cylinder (default 8)." },
        texture: { type: "string", description: "Texture to apply (defaults to the project default)." },
        uv: { type: "array", items: { type: "number" }, description: "UV rect [x1,y1,x2,y2] every face maps into (defaults to the whole texture)." },
        parent: { type: "string", description: "uuid or name of the parent bone/group." },
      }
    )
  ),
  forward(
    "mirror_element",
    "Mirror a cube or group (with its children) across an axis about a pivot — build one side of a symmetric model, then mirror it. Flips geometry and the off-axis rotation signs, and renames left<->right. Returns the created clones.",
    obj({
      element: { type: "string", description: "uuid or name of the cube/group to mirror (single form)." },
      elements: { type: "array", items: { type: "string" }, description: "Or a list of uuids/names to mirror." },
      axis: { type: "string", enum: ["x", "y", "z"], description: "Mirror axis (default 'x')." },
      pivot: { type: "number", description: "Coordinate on that axis to mirror about (default 0 = centre line)." },
    })
  ),
  forward(
    "edit_element",
    "Edit an existing cube or group (rename, move, rotate, reparent, resize, inflate, visibility).",
    obj(
      {
        element: { type: "string", description: "uuid or name of the cube/group to edit." },
        new_name: { type: "string" },
        from: vec3("New lower corner (cubes only)."),
        to: vec3("New upper corner (cubes only)."),
        origin: vec3("New pivot."),
        rotation: vec3("New rotation in degrees."),
        inflate: { type: "number" },
        visibility: { type: "boolean" },
        parent: { type: "string", description: "uuid/name of new parent group, or 'root'." },
      },
      ["element"]
    )
  ),
  forward(
    "delete_element",
    "Delete a cube or group (and its children) from the model.",
    obj({ element: { type: "string", description: "uuid or name." } }, ["element"])
  ),
  forward(
    "list_outliner",
    "Return the full outliner tree (groups/bones and their nested cubes) with uuids, origins and rotations.",
    obj({})
  ),
  forward(
    "get_element",
    "Get detailed info for one cube or group by uuid or name.",
    obj({ element: { type: "string" } }, ["element"])
  ),

  // ===== UV & textures on faces ============================================
  forward(
    "set_cube_uv",
    "Set UV mapping and/or per-face texture on a cube's faces.",
    obj(
      {
        cube: { type: "string", description: "uuid or name of the cube." },
        faces: {
          type: "object",
          description:
            "Keyed by face direction. Each: {uv:[x1,y1,x2,y2], rotation:0|90|180|270, texture: name|uuid}.",
        },
      },
      ["cube", "faces"]
    )
  ),
  forward(
    "apply_texture",
    "Apply a texture to all faces of an element (or all cubes if `element` omitted).",
    obj({ texture: { type: "string" }, element: { type: "string" } }, ["texture"])
  ),

  // ===== textures ==========================================================
  forward(
    "create_texture",
    "Create a new texture. Either fill it with a solid color, or supply a full PNG via `data_url`. Returns the texture uuid.",
    obj({
      name: { type: "string" },
      width: { type: "number", description: "Defaults to project texture width." },
      height: { type: "number", description: "Defaults to project texture height." },
      fill: { type: "string", description: "Solid fill color, e.g. '#a0703c' (CSS color)." },
      data_url: {
        type: "string",
        description: "Optional 'data:image/png;base64,...' to use as the texture image directly.",
      },
      particle: { type: "boolean", description: "Mark as particle texture (some formats)." },
    })
  ),
  forward(
    "create_vfx_texture",
    "Generate a pixelated VFX texture: a bright hot core fading to cool edges in quantized colour bands with jagged transparent edges — the look of pixel flames/energy/projectiles. With frames>1 it bakes a vertical FLIPBOOK and starts the animation player so the effect loops. Defaults to an additive/emissive render mode + 2-sided rendering so it glows on a plane. Apply it to add_plane planes (crossed/layered) and animate with bones. See get_guide topic 'vfx'.",
    obj({
      name: { type: "string" },
      style: {
        type: "string",
        enum: ["flame", "fire", "energy", "plasma", "orb", "glow", "spark", "star", "smoke", "cloud", "trail", "streak", "beam", "beam_v", "beam_h", "bolt", "lightning", "ring", "rune", "shockwave", "crystal", "gem"],
        description: "VFX shape (default 'energy').",
      },
      preset: {
        type: "string",
        enum: ["fire", "ember", "ice", "frost", "energy", "arcane", "poison", "shadow", "holy", "smoke", "blood", "nature"],
        description: "Colour palette preset (core->edge). Overridden by `palette`.",
      },
      palette: { type: "array", items: { type: "string" }, description: "Explicit colour ramp brightest->coolest, e.g. ['#ffffff','#5ff0ff','#22b6ff','#0a5fd6']." },
      width: { type: "number", description: "Frame width px (default 16)." },
      height: { type: "number", description: "Frame height px (default 16, or 24 for flame/beam)." },
      frames: { type: "number", description: "Flipbook frame count (default 1 = static). 4-8 for a looping animation." },
      frame_time: { type: "number", description: "Ticks per frame (default 2; lower = faster)." },
      frame_interpolate: { type: "boolean", description: "Blend between frames (default false for crisp pixels)." },
      render_mode: { type: "string", description: "'additive' (flames/energy, default) | 'emissive' (solid glow) | 'default' | ..." },
      render_sides: { type: "string", description: "'double' (default for planes) | 'front' | 'auto'." },
      seed: { type: "number", description: "Noise seed for repeatable shapes." },
      soft_edge: { type: "boolean", description: "Fade the coolest band's alpha (default true for orb/glow/smoke)." },
      particle: { type: "boolean" },
    })
  ),
  forward(
    "set_texture_render_mode",
    "Set how a texture renders: render_mode ('default' | 'emissive' = full-bright, ignores light | 'additive' = bright pixels add light & dark vanishes, best for fire/energy on planes | 'layered' | 'normal' | 'height' | 'mer'), render_sides ('auto' | 'front' | 'double' for 2-sided planes), flipbook frame timing, and particle flag. Use this to make VFX glow and to show planes from both sides.",
    obj({
      texture: { type: "string", description: "uuid or name of the texture." },
      render_mode: { type: "string", enum: ["default", "emissive", "additive", "layered", "normal", "height", "mer"] },
      render_sides: { type: "string", enum: ["auto", "front", "double"] },
      frame_time: { type: "number", description: "Ticks per flipbook frame (lower = faster)." },
      frame_interpolate: { type: "boolean" },
      frame_order_type: { type: "string", enum: ["loop", "backwards", "back_and_forth", "custom"] },
      particle: { type: "boolean" },
      animate: { type: "boolean", description: "Start the texture-animation player (for flipbooks)." },
    }, ["texture"])
  ),
  forward(
    "import_texture",
    "Import a texture from an image file on disk (desktop only).",
    obj({ path: { type: "string" }, name: { type: "string" } }, ["path"])
  ),
  forward("list_textures", "List all textures in the project.", obj({})),
  {
    name: "get_texture",
    description:
      "Read a texture back as an image so you can inspect what it currently looks like. Returns the PNG inline.",
    inputSchema: obj({ texture: { type: "string", description: "uuid or name." } }, ["texture"]),
    handler: async (args) => {
      const res: any = await callBlockbench("get_texture", args);
      const base64 = String(res.data_url || "").replace(/^data:image\/png;base64,/, "");
      return [
        { type: "text", text: JSON.stringify(res.texture, null, 2) },
        { type: "image", data: base64, mimeType: "image/png" },
      ];
    },
  },
  forward(
    "paint_texture",
    "Paint directly on a texture with absolute pixel coordinates. Use this for whole-sheet work; for painting onto a specific cube face, paint_faces (face-relative coords) is usually easier. Ops run in order on the canvas (origin top-left, y down).",
    obj(
      {
        texture: { type: "string", description: "uuid or name of the texture to paint." },
        edit_name: { type: "string", description: "Undo entry label." },
        ops: {
          type: "array",
          description:
            "Drawing operations. Each op has a `type` and (where relevant) a `color` (CSS color). Types: " +
            "pixel{x,y}; rect{x,y,width,height,fill?,line_width?}; line{x1,y1,x2,y2,line_width?}; " +
            "circle{x,y,radius,fill?,line_width?}; ellipse{x,y,width,height,fill?,line_width?}; " +
            "polygon{points:[[x,y],...],fill?,line_width?}; " +
            "gradient{x1,y1,x2,y2,x,y,width,height,stops:[[offset,color],...]}; " +
            "dither{x,y,width,height,color,color2?,density?} (pixel pattern — stripes/bandages); " +
            "noise{x,y,width,height,amount?,color?,mono?} (organic fur/skin texture); " +
            "fill_all{}; clear{x?,y?,width?,height?}.",
          items: { type: "object" },
        },
      },
      ["texture", "ops"]
    )
  ),
  forward(
    "detail_cubes",
    "SMOOTH base texturing — the @volmur/Hytale look. Assigns the texture to every chosen face (no untextured 'gaps'), then per face bakes a soft vertical gradient in the region colour + gentle directional shading (top lighter, underside darker) + a SUBTLE low-contrast mottle, and finally a 3x3 box blur per UV island (the 'smooth brush'). Run pack_uv FIRST, then this right after create_texture, then paint_faces for crisp features. Avoids the dirty/noisy/grid look (no hard edge outline, low noise by default). Cubes named *_core/*_glow are filled bright (emissive read).",
    obj({
      cubes: {
        oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        description: "'all' (default), a single cube name/uuid, or an array of names/uuids to texture.",
      },
      texture: { type: "string", description: "Texture to paint on (defaults to the project's default texture)." },
      base: { type: "string", description: "Default base color, e.g. '#6e4a2b'. Used where no `colors` rule matches." },
      colors: {
        type: "array",
        description: "Region colour map by cube name: [{match:'leg|paw', color:'#5a3d22'}, ...]. `match` is a regex tested case-insensitively against the cube name; first hit wins. The key to matching a reference palette and not making everything one colour.",
        items: { type: "object" },
      },
      noise: { type: "number", description: "Mottle amount 0..1 (default 0.06 — keep it LOW for the smooth look)." },
      blur: { type: "number", description: "Per-island smooth-brush blur 0..1 (default 0.55). 0 disables." },
      streaks: { type: "boolean", description: "Add fur/wood/stone grain streaks on top/back faces (default false)." },
      top_light: { type: "number", description: "How much brighter up-faces are (default 0.12)." },
      bottom_dark: { type: "number", description: "How much darker down-faces are (default 0.22)." },
      edge_darken: { type: "number", description: "Edge outline darkening (default 0 = OFF; raising it brings back the dirty-grid look)." },
      glow_regex: { type: "string", description: "Regex for emissive cube names (default '_core$|_glow$')." },
    })
  ),
  forward(
    "paint_faces",
    "Paint features onto specific cube faces using coordinates RELATIVE to each face (so [0,0] is that face's top-left corner) — no manual UV math, which is what usually causes misplaced/garbled texture. Use it for eyes, nostrils, mouths, claws, fur tufts, stripes, scars, bandages, armour trim, etc. Either pass one {cube, face, base?, ops?} or a `faces` array of them.",
    obj({
      cube: { type: "string", description: "Cube uuid/name (single-face form)." },
      face: {
        oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        description: "Face direction 'north'|'south'|'east'|'west'|'up'|'down', an array of them, or 'all' (single-face form).",
      },
      base: { type: "string", description: "Optional solid fill for the face before ops (CSS color)." },
      ops: { type: "array", description: "Paint ops (same types as paint_texture), coords relative to the face.", items: { type: "object" } },
      texture: { type: "string", description: "Texture to paint on / assign (defaults to the face's texture or the default)." },
      faces: {
        type: "array",
        description: "Batch form: array of {cube, face, base?, ops?, texture?} items.",
        items: { type: "object" },
      },
    })
  ),
  forward(
    "resize_texture",
    "Resize a texture's bitmap to new dimensions (nearest-neighbour).",
    obj({ texture: { type: "string" }, width: { type: "number" }, height: { type: "number" } }, [
      "texture",
      "width",
      "height",
    ])
  ),

  // ===== animations ========================================================
  forward(
    "create_animation",
    "Create an animation (requires a format that supports animation, e.g. GeckoLib animated_entity or Bedrock entity). Returns the animation uuid.",
    obj({
      name: { type: "string", description: "Animation name, e.g. 'animation.bear.walk'." },
      loop: { type: "string", enum: ["once", "hold", "loop"], description: "Loop mode (default 'loop')." },
      length: { type: "number", description: "Length in seconds." },
    })
  ),
  forward("list_animations", "List all animations and their animated bones.", obj({})),
  forward(
    "add_keyframe",
    "Add a single keyframe to an animation for a given bone and channel.",
    obj(
      {
        animation: { type: "string", description: "uuid or name of the animation." },
        bone: { type: "string", description: "uuid or name of the group/bone to animate." },
        channel: { type: "string", enum: ["rotation", "position", "scale"], description: "Default 'rotation'." },
        time: { type: "number", description: "Time in seconds." },
        value: vec3("Channel value [x,y,z] (degrees for rotation, units for position, factor for scale)."),
        interpolation: { type: "string", enum: ["linear", "catmullrom", "step", "bezier"] },
      },
      ["animation", "bone", "time", "value"]
    )
  ),
  forward(
    "add_keyframes",
    "Add many keyframes at once — the efficient way to author a full animation. Pass an array of {bone, channel, time, value, interpolation}.",
    obj(
      {
        animation: { type: "string" },
        keyframes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              bone: { type: "string" },
              channel: { type: "string", enum: ["rotation", "position", "scale"] },
              time: { type: "number" },
              value: vec3("[x,y,z]"),
              interpolation: { type: "string" },
            },
            required: ["bone", "time", "value"],
          },
        },
      },
      ["animation", "keyframes"]
    )
  ),
  forward(
    "remove_animation",
    "Delete an animation from the project.",
    obj({ animation: { type: "string" } }, ["animation"])
  ),

  // ===== view / camera / screenshot ========================================
  forward(
    "set_camera_angle",
    "Position the preview camera, by named preset and/or explicit camera position & target.",
    obj({
      preset: { type: "string", description: "A camera angle preset id (e.g. 'front', 'isometric_right_front')." },
      position: vec3("Explicit camera position [x,y,z]."),
      target: vec3("Look-at target [x,y,z]."),
      angle: { type: "string", description: "'ortho' to switch to orthographic projection." },
    })
  ),
  {
    name: "screenshot",
    description:
      "Capture the current 3D preview and return it as an image so you can visually inspect the model and iterate. Optionally specify width/height.",
    inputSchema: obj({
      width: { type: "number" },
      height: { type: "number" },
    }),
    handler: async (args) => {
      const res: any = await callBlockbench("screenshot", args);
      return [
        { type: "text", text: "Preview screenshot:" },
        { type: "image", data: res.base64, mimeType: "image/png" },
      ];
    },
  },
  {
    name: "screenshot_views",
    description:
      "Capture several camera angles in ONE call and return them all as images, so you can see the whole model and catch problems (gaps, wrong rotations, missing detail, asymmetry) from every side. Defaults to iso/front/left/back. This is the main way to review and iterate — do it after each modeling/texturing pass, not just once.",
    inputSchema: obj({
      views: {
        type: "array",
        description:
          "Camera views in order. Each item is a preset id string ('front','back','left','right','top','bottom','isometric_right_front','isometric_left_front') or a {position:[x,y,z], target:[x,y,z]} object. Omit for a sensible default set.",
        items: {},
      },
      width: { type: "number" },
      height: { type: "number" },
    }),
    handler: async (args) => {
      const res: any = await callBlockbench("screenshot_views", args);
      const blocks: ContentBlock[] = [
        { type: "text", text: `Captured ${res.count} view(s): ${res.shots.map((s: any) => s.view).join(", ")}` },
      ];
      for (const shot of res.shots) {
        blocks.push({ type: "text", text: `View: ${shot.view}` });
        blocks.push({ type: "image", data: shot.base64, mimeType: "image/png" });
      }
      return blocks;
    },
  },

  // ===== plugins ===========================================================
  forward(
    "list_plugins",
    "List Blockbench plugins (installed and available in the store). Filter with `query` or `installed_only`.",
    obj({
      query: { type: "string", description: "Search term matched against id/title/description." },
      installed_only: { type: "boolean" },
    })
  ),
  forward(
    "install_plugin",
    "Install a Blockbench plugin from the store (by `id`, e.g. 'geckolib' for GeckoLib Models & Animations), or from a `url`, or a local `path`. Needed before using plugin-specific formats like GeckoLib's 'geckolib_model'.",
    obj({
      id: { type: "string", description: "Store plugin id." },
      url: { type: "string", description: "Direct https URL to a plugin .js file." },
      path: { type: "string", description: "Local plugin .js file path (desktop)." },
    })
  ),
  forward(
    "uninstall_plugin",
    "Uninstall an installed Blockbench plugin by id.",
    obj({ id: { type: "string" } }, ["id"])
  ),

  // ===== escape hatch ======================================================
  forward(
    "execute_script",
    "Run arbitrary JavaScript inside Blockbench's renderer for anything not covered by a dedicated tool. The code has access to all Blockbench globals (Project, Cube, Group, Texture, Animation, Undo, Canvas, Outliner, Format, Formats, ...) and receives a `params` object. The code runs as a function body — use an explicit `return` statement to produce a result (the last expression is NOT auto-returned). Returned Promises are awaited, so `return Codecs.gltf.compile(...)` resolves to the compiled value. Return a JSON-serializable value. Use sparingly; prefer dedicated tools (e.g. export_model for glTF export).",
    obj(
      {
        code: {
          type: "string",
          description:
            "Function body — MUST use an explicit `return` to produce a result (a bare trailing expression is NOT returned). Example: \"return Cube.all.map(c => c.name)\". Promises are awaited: \"return Codecs.gltf.compile({format:'glb'})\". Wrap edits in Undo.initEdit/finishEdit and call Canvas.updateAll() after geometry changes.",
        },
        params: { type: "object", description: "Optional object passed in as `params`." },
      },
      ["code"]
    )
  ),
];
