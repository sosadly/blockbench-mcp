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
const vec2 = (desc: string) => ({
  type: "array",
  items: { type: "number" },
  minItems: 2,
  maxItems: 2,
  description: desc,
});
const numArr = (desc: string) => ({
  type: "array",
  items: { type: "number" },
  description: desc,
});
const strArr = (desc: string) => ({
  type: "array",
  items: { type: "string" },
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

// ---- argument coercion -----------------------------------------------------
/**
 * MCP clients do not agree on how to serialize structured arguments: some send
 * a real array/object, some send the JSON *text* of one, and some send a bare
 * comma- or newline-separated string. A 32x32 character matrix or a `palette`
 * object arriving as a string would otherwise fail with a useless "matrix is
 * required", so normalise every argument against the tool's own schema before
 * it reaches the bridge.
 */
export function coerceArgs(
  schema: Record<string, any>,
  args: Record<string, any>
): Record<string, any> {
  const props = schema?.properties as Record<string, any> | undefined;
  if (!props || !args || typeof args !== "object") return args ?? {};
  const out: Record<string, any> = { ...args };
  for (const key of Object.keys(props)) {
    if (!(key in out)) continue;
    out[key] = coerceValue(props[key], out[key]);
  }
  return out;
}

function schemaTypes(spec: any): string[] {
  if (!spec) return [];
  const types: string[] = [];
  const push = (t: unknown) => {
    if (typeof t === "string") types.push(t);
    else if (Array.isArray(t)) t.forEach((x) => typeof x === "string" && types.push(x));
  };
  push(spec.type);
  for (const branch of spec.oneOf ?? spec.anyOf ?? []) push(branch?.type);
  return types;
}

function coerceValue(spec: any, value: any): any {
  const types = schemaTypes(spec);
  const wantsArray = types.includes("array");
  const wantsObject = types.includes("object");

  if (typeof value === "string") {
    const trimmed = value.trim();
    const looksJSON =
      (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
      (trimmed.startsWith("{") && trimmed.endsWith("}"));
    if ((wantsArray || wantsObject) && looksJSON) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed) ? wantsArray : wantsObject) return parsed;
      } catch {
        /* not JSON after all — fall through to the split/wrap rules */
      }
    }
    if (wantsArray && !types.includes("string")) {
      // A plain string standing in for a list. Newlines win over commas so a
      // pixel matrix pasted as one blob still splits into rows.
      const parts = value.includes("\n")
        ? value.split(/\r?\n/)
        : value.includes(",")
        ? value.split(",").map((s) => s.trim())
        : [value];
      const itemType = spec?.items?.type;
      return itemType === "number" ? parts.map((s: string) => Number(s)) : parts;
    }
    if (types.includes("number") && !types.includes("string") && trimmed !== "") {
      const n = Number(trimmed);
      if (Number.isFinite(n)) return n;
    }
    if (types.includes("boolean") && !types.includes("string")) {
      if (/^(true|yes|1)$/i.test(trimmed)) return true;
      if (/^(false|no|0)$/i.test(trimmed)) return false;
    }
    return value;
  }

  // A single item where a list is expected (one cube, one view, one face).
  if (wantsArray && value != null && !Array.isArray(value)) {
    return [value];
  }
  return value;
}

export function text(value: unknown): ContentBlock[] {
  // JSON.stringify(undefined) returns undefined (the value, not the string), which
  // would emit an invalid content block. Coerce it so a handler that returns
  // nothing still produces a well-formed result.
  const body =
    (typeof value === "string" ? value : JSON.stringify(value, null, 2)) ?? "(undefined)";
  return [{ type: "text", text: body }];
}

/** Turn a bridge response's `shots` array into text + image blocks. */
function shotBlocks(shots: any[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const shot of shots || []) {
    const caption = [
      shot.time != null ? `t=${shot.time}s` : null,
      `View: ${shot.view}`,
      shot.looking_at ? `(${shot.looking_at})` : null,
      shot.note ? `— ${shot.note}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    blocks.push({ type: "text", text: caption });
    if (shot.base64) blocks.push({ type: "image", data: shot.base64, mimeType: "image/png" });
  }
  return blocks;
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
const catalogue: ToolDef[] = [
  // ===== status & discovery ================================================
  forward(
    "get_status",
    "Get the current Blockbench state: open project, format, counts of cubes/groups/textures/animations, and edit mode. Call this first to understand the workspace. If you are about to BUILD or TEXTURE a model, call get_guide first. If the user is matching a REFERENCE image (they may have dropped one into the MCP Copilot panel), call get_reference to see it, build, then call compare_reference every pass until match_percent is high — do not judge the match by eye.",
    obj({})
  ),
  forward(
    "get_guide",
    "Return a playbook. Pass `topic`: 'modeling' (default — proportions, detail, rotation), 'detailing' (the cube budgets and the 4-layer doctrine that stop models coming out as 15 boxes — read it before building anything with a costume, armour or cloth), 'orientation' (which side is the model's LEFT — read before anything with a left and a right), 'rigging' (bone hierarchy, joint origins, why 2-bone limbs animate like cardboard), 'texturing' (the smooth @volmur/Hytale look), 'vfx' (pixelated flames/energy/projectiles), 'animation' (axis signs, gaits, easing, the measure-then-review loop), 'review' (how to get the user to confirm work instead of declaring it good yourself), or 'reference' (how to ACTUALLY match a reference image). READ the relevant topic BEFORE building/rigging/texturing/animating — it dramatically improves results.",
    obj({
      topic: {
        type: "string",
        enum: ["modeling", "detailing", "orientation", "rigging", "texturing", "vfx", "animation", "review", "reference"],
        description: "Which playbook to return. Default 'modeling'.",
      },
    })
  ),

  // ===== orientation: which side is left? ==================================
  forward(
    "get_orientation",
    "THE left/right authority for this model — call it before rigging, mirroring, attaching an item to a hand, or interpreting any render. Returns which way the model faces and which world axis is the model's OWN right and left (Minecraft models face -Z, so the model's right is +X), plus the trap that causes most mistakes: a front-view render shows the model MIRRORED (its right hand appears on the LEFT of the image), exactly like facing a person. Also returns the rotation-sign cheat sheet (+X swings a hanging limb FORWARD, tips an upright torso BACKWARD; +Y turns the model to its own left).",
    obj({})
  ),
  forward(
    "which_side",
    "Answer 'is this bone the model's left or right?' for one element, from its coordinates rather than from a picture. Use it before parenting a sword/shield/prop to a hand, or whenever the user says left/right. Returns the side, the signed coordinate, and whether the element's NAME agrees with where it actually is.",
    obj({ element: { type: "string", description: "uuid or name of the cube/bone." } }, ["element"])
  ),
  forward(
    "check_sides",
    "Audit every left/right NAME in the model against the actual geometry. Catches the classic failures: a bone called arm_right sitting on the model's left, a mirrored pair that ended up on the same side, and limbs with no counterpart. Run it after building or mirroring anything symmetric, and again before you tell the user a left/right request is done.",
    obj({})
  ),

  // ===== human review gate =================================================
  {
    name: "request_review",
    description:
      "SHOW THE USER and WAIT for their verdict — the honest alternative to looking at your own screenshot and declaring it good. Renders labelled views (or animation poses) and posts them as a card in the MCP Copilot panel inside Blockbench, then waits a SHORT window for the user to press 'Looks right' / 'Needs changes' and optionally type a comment. If they haven't answered yet it returns `pending: true` with a `review_id` — the card stays open, so call wait_review with that id to keep waiting (that loop is how a minutes-long human review fits inside an MCP client's per-request timeout). Call it after every user-visible milestone: the blockout, the texture pass, EACH animation, anything the user asked for specifically, and before you claim a task is finished. Run the objective checks (check_model / check_sides / check_rig / analyze_animation) FIRST — don't spend the user's attention on something a tool would have caught. If the answer is 'needs changes', fix exactly what they said and ask again. `pending` and a timeout are NOT approval.",
    inputSchema: obj(
      {
        question: {
          type: "string",
          description:
            "One concrete question, naming what to look at. e.g. 'Walk cycle: is the stride right and do the knees bend enough?'",
        },
        title: { type: "string", description: "Short header for the panel card." },
        details: { type: "string", description: "What you changed since the last review, and anything you are unsure about." },
        views: {
          type: "array",
          description:
            "Camera views to render, named from the MODEL's point of view: 'front' (its face), 'back', 'left'/'right' (the side its left/right arm is on), 'front_right', 'top'. Default front_right/front/left/back.",
          items: { type: "string" },
        },
        animation: { type: "string", description: "Animation name/uuid to review — renders poses from it instead of the rest pose." },
        times: { type: "array", items: { type: "number" }, description: "Times (seconds) to sample when `animation` is set. Default 0/25/50/75%." },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Custom answer buttons instead of approve/reject (e.g. ['Left hand','Right hand']).",
        },
        wait_seconds: {
          type: "number",
          description:
            "How long THIS call waits before returning `pending` (default 25). Keep it under your client's request timeout; use wait_review to keep waiting.",
        },
        timeout_seconds: { type: "number", description: "How long the card stays open in Blockbench (default 900, max 3600)." },
      },
      ["question"]
    ),
    handler: async (args) => {
      const res: any = await callBlockbench("request_review", args, 180_000);
      const { shots, ...summary } = res;
      return [{ type: "text", text: JSON.stringify(summary, null, 2) }, ...shotBlocks(shots)];
    },
  },
  forward(
    "wait_review",
    "Keep waiting for a review the user hasn't answered yet — call this in a loop after request_review/ask_user returns `pending: true`, passing the `review_id` it gave you. Each call waits a short window and then returns either the verdict or `pending` again, so a review that takes the user minutes never trips your client's request timeout. Between polls, say in chat that you are waiting for their check; never continue as though `pending` meant approval.",
    obj({
      review_id: { type: "string", description: "The id returned by request_review / ask_user. Omit to wait on the newest open card." },
      wait_seconds: { type: "number", description: "How long this poll waits (default 25, max 120)." },
    })
  ),
  {
    name: "ask_user",
    description:
      "Ask the user a question and wait for the answer, without ending your turn — use it instead of guessing when a decision is genuinely theirs (which hand holds the shield, which of two silhouettes, which palette). The question appears as a card in the MCP Copilot panel inside Blockbench; pass `options` for one-click choices, and optionally `views` to show renders alongside it. Like request_review it waits a short window and may return `pending: true` with a `review_id` — then keep polling with wait_review.",
    inputSchema: obj(
      {
        question: { type: "string", description: "The question, phrased so it can be answered in one click or one line." },
        title: { type: "string" },
        details: { type: "string", description: "Extra context or the trade-offs between the options." },
        options: { type: "array", items: { type: "string" }, description: "Answer buttons." },
        views: { type: "array", items: { type: "string" }, description: "Optional model views to show with the question." },
        wait_seconds: { type: "number", description: "How long THIS call waits before returning `pending` (default 25)." },
        timeout_seconds: { type: "number", description: "How long the card stays open in Blockbench (default 900)." },
      },
      ["question"]
    ),
    handler: async (args) => {
      const res: any = await callBlockbench("ask_user", args, 180_000);
      const { shots, ...summary } = res;
      return [{ type: "text", text: JSON.stringify(summary, null, 2) }, ...shotBlocks(shots)];
    },
  },
  forward(
    "list_formats",
    "List all model formats available in this Blockbench install (e.g. free, java_block, bedrock, and any added by plugins such as GeckoLib's animated_entity). Use the returned `id` with new_project.",
    obj({})
  ),

  // ===== reference matching (the grounded-modeling engine) =================
  {
    name: "get_reference",
    description:
      "Return the REFERENCE image(s) the user is trying to match — the ones they dropped into the MCP Copilot panel in Blockbench, or that you loaded with load_reference — as inline images so you can actually SEE what to build. Call this FIRST whenever a reference is involved, and re-look during the build. Optionally pass `name`/`id` for a specific one.",
    inputSchema: obj({
      name: { type: "string", description: "Reference name to fetch (omit for all)." },
      id: { type: "string", description: "Reference id to fetch (omit for all)." },
    }),
    handler: async (args) => {
      const res: any = await callBlockbench("get_reference", args);
      const blocks: ContentBlock[] = [];
      const refs = res.references || [];
      blocks.push({
        type: "text",
        text: refs.length
          ? `${res.count} reference(s): ${refs.map((r: any) => `${r.name} (${r.width}x${r.height})`).join(", ")}`
          : res.note || "No reference loaded.",
      });
      for (const r of refs) {
        const base64 = String(r.data_url || "").replace(/^data:image\/\w+;base64,/, "");
        if (base64) blocks.push({ type: "image", data: base64, mimeType: "image/png" });
      }
      return blocks;
    },
  },
  forward(
    "load_reference",
    "Load a reference image you want the model to match, from a disk `path` (desktop) or a `data_url`. It is stored so compare_reference can score against it, and best-effort pinned behind the model in the viewport. Usually the user drops the reference into the MCP Copilot panel instead (then just use get_reference) — use this when you have a file path or image data yourself.",
    obj({
      path: { type: "string", description: "Absolute image path (desktop)." },
      data_url: { type: "string", description: "'data:image/png;base64,...' image data." },
      name: { type: "string", description: "Optional label." },
      overlay: { type: "boolean", description: "Pin it in the viewport (default true; non-fatal if unsupported)." },
      opacity: { type: "number", description: "Viewport overlay opacity 0..1 (default 0.45)." },
    })
  ),
  forward(
    "list_references",
    "List the reference images currently loaded (id, name, size, source). Use to see what the user has provided.",
    obj({})
  ),
  forward(
    "clear_references",
    "Remove all loaded reference images and their viewport overlays.",
    obj({})
  ),
  {
    name: "compare_reference",
    description:
      "THE reference-matching tool — turns 'does it match?' into a measured number so you stop building blind. Renders your model from the chosen angle on a transparent background, extracts the model + reference SILHOUETTES, normalises them (so scale/position in the viewport don't matter) and returns: match_percent (silhouette IoU 0-100), aspect_delta_pct (model too wide/narrow), ref_only_pct (reference area with NO model under it = MISSING mass), model_only_pct (model beyond the reference = EXTRA mass), a verdict + concrete advice, AND a composite image [reference | your model | overlay]. In the overlay RED = reference-only (add mass there), BLUE = model-only (trim), WHITE = match. Aim the camera to the reference angle first (set_camera_angle/screenshot_views) or pass `view`. Call this EVERY modeling pass and iterate until match_percent >= 85 — do not declare a match by eye.",
    inputSchema: obj({
      reference: { type: "string", description: "Reference id/name/index to compare against (default: the most recent)." },
      view: { type: "string", description: "Camera preset to render from ('front','back','left','right','isometric_right_front',...). Omit to use the current view (aim it first). Models usually face -Z, so 'back' shows the creature's face." },
      position: vec3("Explicit camera position [x,y,z] (overrides view)."),
      target: vec3("Explicit look-at target [x,y,z]."),
      threshold: { type: "number", description: "Alpha cutoff 0..1 for the model silhouette (default 0.45)." },
    }),
    handler: async (args) => {
      const res: any = await callBlockbench("compare_reference", args);
      const { composite_base64, composite_data_url, ...summary } = res;
      const blocks: ContentBlock[] = [
        { type: "text", text: JSON.stringify(summary, null, 2) },
      ];
      const base64 = String(composite_base64 || composite_data_url || "").replace(/^data:image\/png;base64,/, "");
      if (base64) blocks.push({ type: "image", data: base64, mimeType: "image/png" });
      return blocks;
    },
  },
  forward(
    "measure_model",
    "Return the model's measurable proportions: total bounding box (width/height/depth in units), each top-level bone's size, and key ratios (width:height, depth:height, head_height_fraction). Use it to match a reference NUMERICALLY (e.g. 'head should be ~1/4 of total height') — complements compare_reference's silhouette score. Bounds are axis-aligned (rotation ignored), which is fine for proportion checks.",
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
    "Export the open model to a FILE through a named codec — use this when you need a real asset on disk rather than Blockbench's own save format. Defaults to `gltf`, which writes a self-contained .gltf (geometry, animations, embedded buffers and textures) that imports directly into Godot/Unity/Blender. Pass `codec` for others ('bedrock', 'java_block', 'obj', 'gltf', …); unlike export_project this is not limited to the current format's codec. Async codecs are awaited.",
    obj(
      {
        path: { type: "string", description: "Absolute output path, e.g. 'D:/out/golem.gltf'." },
        codec: { type: "string", description: "Codec id (default 'gltf'). An unknown id returns the list of available codecs." },
        format: { type: "string", description: "Optional format hint passed to the codec." },
        options: { type: "object", description: "Extra codec options." },
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
      side: {
        type: "string",
        enum: ["left", "right"],
        description:
          "The MODEL's own side this bone belongs to. Appends the _left/_right suffix and REJECTS the call if the origin sits on the other side — the guard against building a 'right arm' on the left. The model faces -Z, so its right is +X.",
      },
    })
  ),
  forward(
    "add_cube",
    "Add a cube to the model. Coordinates are in Blockbench units. Cubes support `rotation` (degrees) and `inflate` (round/shrink without moving) — use them; flat axis-aligned boxes look robotic. For compound multi-axis angles, parent the cube to a rotated group instead. For anything with a left and a right: the model faces -Z, so its OWN right is +X — pass `side` and the tool will enforce it. Prefer add_cubes to build many cubes at once. Returns the created cube with uuid and resolved face UVs (paint onto those with paint_faces).",
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
        side: {
          type: "string",
          enum: ["left", "right"],
          description:
            "The MODEL's own side. Appends the _left/_right suffix and REJECTS the call if the cube is on the other side. The model faces -Z, so its right is +X (a front-view render shows this mirrored).",
        },
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
    "Create many cubes in one call — the efficient way to author a detailed model. BUDGET: a simple prop is 30-60 cubes, a standard mob/NPC 100-180, a hero model 180-300+; a humanoid built from under ~70 cubes is a draft, not a model (audit_complexity enforces this). Hand-computing [from,to] is what you are worst at, so use this for the primary masses and reach for the generators for the rest: add_hollow_volume (hoods/helmets/armour shells), generate_array (hems, scales, plates, teeth, rivets), extrude_chain (horns, tails, tentacles), voxelize_matrix (blades, emblems, flat detail). Pass `cubes`: an array where each item takes the same fields as add_cube ({name, from, to, origin, rotation, inflate, parent, side, box_uv, uv_offset, faces}). Build symmetric parts by emitting both the left side and its mirror (negate X, flip Y/Z rotation signs) in the same array, and tag each with side:'left'/'right' — the model faces -Z so its OWN right is +X, and the whole batch is validated before anything is created, so a mirrored limb fails loudly instead of silently. AVOID Z-FIGHTING: when cubes overlap, make one clearly penetrate the other (by >=0.1) and never align two faces to the exact same coordinate; stagger decorative pieces' depths. Returns all created cubes with their face UVs.",
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
  // ===== procedural generators =============================================
  forward(
    "voxelize_matrix",
    "DRAW a shape as a character matrix and get 3D cubes back — the fix for parts you cannot compute [from,to] for by hand. You are excellent at 2D pixel art and bad at 3D arithmetic, so describe the SILHOUETTE in rows of characters and this extrudes it. Universal: sword/scythe/axe blades, bows, horns, shield emblems, fins, flat wings, chevrons, keys, gears, plate patterns, tattered banner edges. `matrix` rows are top-to-bottom, ' ' and '.' are empty; every other character becomes cubes. Per character, `palette` sets {name (drives detail_cubes colour rules), depth (thickness in units), offset_z (shift along the depth axis — layer a rim in front of a core), inflate}. `plane` picks the projection: 'xy' front view (columns->+X, rows descend -Y, depth along +Z), 'xz' top view (columns->+X, rows go back-to-front, depth along +Y), 'yz' side view (columns->+Z with column 0 at the model's FRONT, rows descend -Y, depth along +X). `origin` is the grid's minimum corner. `merge_adjacent:true` merges runs of the same character across a row into one cube (far fewer cubes, same shape). Then pack_uv.",
    obj(
      {
        matrix: strArr(
          "Rows of characters, top row first, e.g. ['..##..','.####.','######']. All rows should be the same length; short rows are padded with blanks."
        ),
        palette: {
          type: "object",
          description:
            "Per-character settings, keyed by the single character: {'#': {name:'blade', depth:2, offset_z:0, inflate:0}, '=': {name:'guard', depth:3, offset_z:-0.5}}. Any character missing here uses default_depth.",
        },
        pixel_size: { type: "number", description: "Size of one matrix cell in Blockbench units (default 1)." },
        default_depth: { type: "number", description: "Extrusion thickness for characters with no palette depth (default 1)." },
        plane: {
          type: "string",
          enum: ["xy", "xz", "yz"],
          description: "Projection plane (default 'xy' = front view).",
        },
        origin: vec3("Minimum corner of the grid [x,y,z]: the matrix grows +u and +v from here, and extrudes along the depth axis."),
        parent: { type: "string", description: "uuid or name of the bone to build into." },
        merge_adjacent: {
          type: "boolean",
          description: "Merge horizontally adjacent identical cells into single cubes (default false). Use it for anything over ~60 cells.",
        },
        name: { type: "string", description: "Base name for cubes with no palette name (default 'vox')." },
        blank: { type: "string", description: "Characters that mean 'empty' (default ' .')." },
        side: {
          type: "string",
          enum: ["left", "right"],
          description: "The MODEL's own side this part belongs to. Adds the suffix and REFUSES the call if the geometry lands on the other side. The model faces -Z, so its right is +X.",
        },
        max_cubes: { type: "number", description: "Safety cap on how many cubes this call may create (default 1500)." },
      },
      ["matrix"]
    )
  ),
  forward(
    "add_hollow_volume",
    "Build a SHELL instead of a solid box — the fix for the single biggest 'AI model' tell, a monolithic cube where a hollow form belongs. Creates up to six walls of `wall_thickness` around an empty cavity, skipping every direction in `open_faces`. Universal: hoods (open 'north'+'down' so the face and neck show), helmets, masks, visors, eye sockets, breastplates, pauldrons, bracers, collars, cages, wheels, pipes, chimneys, crates, troughs. Faces are WORLD-relative — north=-Z (the model's front), south=+Z, east=+X, west=-X, up, down — and the model-relative words front/back/left/right/top/bottom are accepted too. The walls tile the shell exactly, so they never overlap or z-fight each other; anything you place INSIDE the cavity should still keep >=0.1 clearance from them. Returns the cavity bounds so you can fill it.",
    obj(
      {
        bounds: {
          type: "object",
          description: "OUTER box of the shell: {from:[x,y,z], to:[x,y,z]}.",
          properties: { from: vec3("Lower corner."), to: vec3("Upper corner.") },
          required: ["from", "to"],
        },
        wall_thickness: { type: "number", description: "Wall thickness in units (default 1; 1.5-2 reads as heavy armour). Clamped per axis if it would not fit." },
        open_faces: {
          type: "array",
          items: { type: "string", enum: ["north", "south", "east", "west", "up", "down", "front", "back", "left", "right", "top", "bottom"] },
          description: "Directions left open, e.g. ['north','down'] for a hood or ['up'] for an open crate.",
        },
        name: { type: "string", description: "Base name; walls are named <name>_north, <name>_up, ... (default 'shell')." },
        inflate: { type: "number", description: "Inflate every wall (rounds the shell without moving it)." },
        parent: { type: "string", description: "uuid or name of the bone to build into." },
        side: { type: "string", enum: ["left", "right"], description: "The model's own side, enforced against the geometry (e.g. a single pauldron)." },
      },
      ["bounds"]
    )
  ),
  forward(
    "generate_array",
    "Repeat one element along a line, around a ring, or over a grid — the fix for parts you would otherwise collapse into one flat box. Universal: torn/shingled hems on cloaks and skirts, scales, feathers, overlapping armour plates, teeth in a jaw, spikes along a spine, rivets, fence posts, chain links, ribs, tassels. `mode:'linear'` needs start+end, `'radial'` needs center+radii (an ellipse in XZ, elements turned to face outward by default), `'grid'` needs start+end plus counts (or count). `anchor` decides how each element sits on its point: 'center' (default), 'top' (element HANGS from the point — use for fringes), 'bottom' (stands on it — spikes), 'min'. `jitter` breaks the machine-regular look, `size_decay` grows/shrinks elements along the run (per-step delta in units, negative to taper), `rotation_range` {min,max} gives each element its own tilt, and `depth_stagger` alternates neighbours in depth so overlapping rows CANNOT z-fight — always pass 0.05-0.2 for shingled rows. `seed` makes the randomness repeatable. The result reports `z_fight_pairs`: elements whose faces ended up on the same plane anyway (a row where each element overlaps two others still lines up), with the fix to apply — act on it rather than leaving it for check_model.",
    obj(
      {
        mode: { type: "string", enum: ["linear", "radial", "grid"], description: "Distribution (default 'linear')." },
        count: { type: "number", description: "How many elements (linear/radial; in grid mode it caps the total)." },
        element_size: vec3("Size of one element [width, height, depth] in units."),
        start: vec3("Linear: first point. Grid: one corner of the area."),
        end: vec3("Linear: last point. Grid: the opposite corner."),
        center: vec3("Radial: centre of the ring."),
        radii: vec2("Radial: [radius_x, radius_z] — different values give an ellipse."),
        arc_degrees: { type: "number", description: "Radial: how much of the circle to cover (default 360; use 180 for a half ring of teeth)." },
        start_degrees: { type: "number", description: "Radial: angle of the first element, 0 = +X (default 0)." },
        align_to_center: { type: "boolean", description: "Radial: turn each element so its FRONT face points away from the centre (default true in radial mode)." },
        counts: numArr("Grid: elements per axis [nx, ny, nz]. Omit to derive a near-square layout from `count`."),
        distribution: {
          type: "string",
          enum: ["span", "cells"],
          description: "'span' (default): the first and last element land exactly on start/end. 'cells': elements are evenly tiled with none hanging off the ends — what a continuous fringe or shingle row wants.",
        },
        anchor: { type: "string", enum: ["center", "top", "bottom", "min"], description: "Where the element sits relative to its point (default 'center'). Also the rotation pivot." },
        jitter: vec3("Random offset range per axis [jx,jy,jz] — 0.1-0.4 makes a row look hand-made instead of stamped."),
        size_decay: vec3("Per-step size change [dw,dh,dd] in units, added cumulatively. Negative tapers the run (teeth, spikes, a narrowing fringe)."),
        depth_stagger: { type: "number", description: "Alternating offset along the depth axis (default 0). ANTI Z-FIGHTING: pass 0.05-0.2 whenever elements overlap." },
        depth_axis: { type: "string", enum: ["auto", "x", "y", "z", "radial", "none"], description: "Which axis depth_stagger pushes along (default 'auto': perpendicular to a linear run, outward for a radial one)." },
        rotation: vec3("Base rotation in degrees applied to every element."),
        rotation_range: {
          type: "object",
          description: "Random rotation per element, e.g. {min:[-8,-4,-8], max:[8,4,8]}. Added on top of `rotation`.",
          properties: { min: vec3("Lowest rotation [x,y,z] in degrees."), max: vec3("Highest rotation [x,y,z] in degrees.") },
        },
        seed: { type: "number", description: "Seed for jitter/rotation randomness — same seed, same result." },
        name_prefix: { type: "string", description: "Name prefix; elements are <prefix>_1..N (default 'element'). detail_cubes colour rules match on this." },
        parent: { type: "string", description: "uuid or name of the bone to build into." },
        inflate: { type: "number", description: "Inflate every element." },
        side: { type: "string", enum: ["left", "right"], description: "The model's own side, enforced against the geometry." },
        max_cubes: { type: "number", description: "Safety cap on how many cubes this call may create (default 1500)." },
      },
      ["element_size"]
    )
  ),
  forward(
    "extrude_chain",
    "Build a tapering, curving chain of segments — optionally one BONE per segment, so it can be animated. Universal: tentacles, horns, antlers, claws, curved tails, tusks, branches, snake bodies, hair braids, cables, antennae, whip links. The chain grows along `direction` from `base_origin`; each segment is `taper`-thinner than the last and each bone adds `curvature` degrees on top of its parent, so segment i sits at base_rotation + i x curvature and the whole thing sweeps into a curve. With `create_bones:true` (default) the segments nest as a bone chain — that is what gives a tail follow-through and a tentacle its whip; the rest pose is laid out straight and the bone rotations produce the curve. With `create_bones:false` the rotations are baked into the cubes and it cannot be animated (and single-axis-rotation formats such as java_block will not honour compound angles). Returns `tip`, the world position where the chain ends, so you can attach something there.",
    obj(
      {
        segments: { type: "number", description: "Number of segments (default 4, max 64). 5-8 reads as a smooth curve." },
        base_origin: vec3("Where the chain starts [x,y,z] — the first joint."),
        segment_length: { type: "number", description: "Length of the first segment in units (default 4)." },
        initial_size: vec2("Cross-section of the first segment [width, depth] (default [4,4])."),
        taper: { type: "number", description: "How much thinner the last segment is, 0..1 (default 0.35 = 65% of the base). 0.8 is a sharp horn." },
        length_taper: { type: "number", description: "Same idea for segment LENGTH, 0..1 (default 0 = every segment the same length)." },
        curvature: vec3("Degrees added per segment [x,y,z]. +X bends a down-pointing chain forward; 10-25 per segment gives a natural sweep."),
        base_rotation: vec3("Rotation of the first segment, i.e. which way the chain aims out of its base."),
        direction: {
          type: "string",
          enum: ["up", "down", "forward", "back", "left", "right"],
          description: "Growth direction, in the MODEL's own axes (default 'up'; 'forward' is the way it faces).",
        },
        create_bones: { type: "boolean", description: "One nested bone per segment so the chain can be animated (default true). Turn it off only for rigid decor." },
        name: { type: "string", description: "Base name: bones <name>1..N, cubes <name>1..N_seg (default 'chain'). Name a tail 'tail' so the rig tools pick it up." },
        inflate: { type: "number", description: "Inflate every segment." },
        parent: { type: "string", description: "uuid or name of the bone the chain hangs off." },
        side: { type: "string", enum: ["left", "right"], description: "The model's own side, enforced against base_origin (horns, tusks, arms)." },
      },
      ["base_origin"]
    )
  ),

  forward(
    "check_model",
    "Audit the model for problems that make results look broken: untextured faces (the 'gaps'), zero-area or out-of-bounds UVs, degenerate cube sizes, cubes not parented to a bone in animated formats, and Z-FIGHTING (coplanar_overlap — two faces on the same plane that flicker/clip, the 'two squares inside one another'). Run this after building and before/after texturing, then fix what it reports (for coplanar_overlap, nudge one cube by >=0.1 so the faces aren't coplanar). Returns a grouped issue list.",
    obj({})
  ),
  forward(
    "audit_complexity",
    "THE detail gate — run it before you texture anything, and act on the verdict. It measures whether the model is actually built or is still a blockout wearing a costume: total cube count against a budget (simple prop 30-60, standard mob/NPC 100-180, hero/boss 180-300+), MONOLITHIC boxes (one cube holding >30% of the model's volume with nothing layered on it — the classic 'one cube per torso, one cube per cloak'), layering (how much geometry overlaps other geometry at all), micro-detail density (cubes <=2 units), bare slabs (a large face with nothing on or near it), bone-hierarchy depth, and how much is rotated. Returns `verdict`: 'too_primitive' (under budget — a humanoid under ~80 cubes is a draft, not a model), 'acceptable' or 'high_detail', plus `ready_for_texturing` and a concrete fix per issue. A high cube count with no layering still looks flat, so pair this with compare_reference (silhouette) and check_model (z-fighting, untextured faces).",
    obj({
      target: {
        type: "string",
        enum: ["auto", "prop", "character", "creature", "hero"],
        description:
          "Which budget to judge against (default 'auto': a detected rig means 'character', otherwise 'prop'). 'prop' 30/80, 'character'/'creature' 80/180, 'hero' 120/300 (minimum / high-detail).",
      },
      min_cubes: { type: "number", description: "Override the minimum cube count for this model." },
      monolith_share: { type: "number", description: "Volume share above which one cube counts as monolithic, 0.05-0.9 (default 0.3)." },
      min_overlays: { type: "number", description: "How many neighbouring detail pieces a big mass needs before it stops counting as monolithic (default 4)." },
      flat_face_area: { type: "number", description: "Face area (units^2) above which an untouched face counts as a bare slab (default 48)." },
    })
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
    "Add many keyframes at once — the way to author or refine a full animation. Pass an array of {bone, channel, time, value, interpolation}. SIGNS (model faces -Z): +X rotation swings a DOWN-pointing bone (arm/leg) FORWARD and tips an UP-pointing bone (torso/neck/head) BACKWARD; elbows bend +X, knees bend -X; +Y turns the model toward its own LEFT. Aim for 6-9 keyframes per moving bone and animate the LOWER limb segments too, or it reads as cardboard. Use interpolation 'catmullrom' for swings/settles and 'linear' only for impact snaps. Set close_loop:true on a cycle so the end pose exactly matches t=0. Nothing is written unless every bone name resolves. After this, ALWAYS run analyze_animation.",
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
        close_loop: { type: "boolean", description: "Repeat each bone/channel's t=0 pose at the end so the loop does not pop." },
        length: { type: "number", description: "Force the animation length (otherwise the latest keyframe wins)." },
      },
      ["animation", "keyframes"]
    )
  ),
  forward(
    "remove_animation",
    "Delete an animation from the project.",
    obj({ animation: { type: "string" } }, ["animation"])
  ),

  // ===== rigging ===========================================================
  forward(
    "create_rig",
    "Build a proper animation skeleton in one call — the fix for stiff, cardboard animation. Creates a full bone hierarchy with THREE segments per limb (upper / lower / hand-or-foot) so elbows and knees can actually bend, joint origins exactly on the pivots, a segmented spine + neck + head (+ optional jaw and tail chain), and correct *_left / *_right naming for the model's OWN sides. By default it also drops in a blocked-out placeholder body you reshape with edit_element and then add detail cubes into. Do this BEFORE modelling if the creature will be animated — retro-fitting an elbow into a finished 2-bone arm is far more work.",
    obj({
      type: { type: "string", enum: ["humanoid", "quadruped"], description: "Skeleton template (default 'humanoid')." },
      height: { type: "number", description: "Total height in units for a humanoid / shoulder height for a quadruped (humanoid default 32 = a Minecraft player)." },
      scale: { type: "number", description: "Extra uniform scale on top of `height`." },
      offset: vec3("Move the whole rig by [x,y,z] (e.g. to stand it on a different origin)."),
      arm_segments: { type: "number", description: "2 = upper+lower, 3 = +hand (default 3). Fewer than 3 means no wrist." },
      leg_segments: { type: "number", description: "2 = thigh+shin, 3 = +foot (default 3)." },
      spine_segments: { type: "number", description: "1-3 torso bones between hips and chest (default 2)." },
      tail_segments: { type: "number", description: "Tail chain length (humanoid default 0, quadruped 3). Tails carry follow-through." },
      jaw: { type: "boolean", description: "Add a jaw bone (and a snout cube on quadrupeds) for bites and speech." },
      placeholder_cubes: { type: "boolean", description: "Also create a blocked-out body in each bone (default true)." },
      name_prefix: { type: "string", description: "Prefix for every bone/cube name, e.g. 'golem_'." },
      parent: { type: "string", description: "Existing group to build the rig under." },
    })
  ),
  forward(
    "check_rig",
    "Audit the skeleton BEFORE animating and fix what it reports. Catches exactly what makes AI animation look bad: limbs with fewer than 3 segments (no elbow/knee — the cardboard look), bone origins sitting in the middle of a limb instead of on the joint (the part spins instead of swinging), cubes not parented to a bone, missing root/spine/head, left-right naming that contradicts the geometry, and suspiciously low bone counts. Returns ready_to_animate plus a concrete fix for every issue.",
    obj({})
  ),
  forward(
    "get_rig",
    "Return the skeleton as the animation tools understand it: which bones are the spine/neck/head/tail, and each limb's segment chain with its detected side. Use it to see whether your naming is being picked up before you generate or hand-write an animation.",
    obj({})
  ),

  // ===== animation generation & measurement ================================
  forward(
    "generate_animation",
    "Generate a complete, direction-correct base animation from the rig — then refine it. It reads the skeleton, applies the correct rotation SIGNS for the way the model faces (so an attack swings forward, not into its own back), bends elbows forward and knees backward, offsets phases for a proper gait, counter-rotates hips against chest, adds body bob, head stabilisation and tail follow-through, and closes loops seamlessly. Types: 'idle' (breathing + weight shift), 'walk', 'run', 'attack' (anticipation → strike → contact hold → recovery; pick the `hand`), 'cast', 'jump', 'hurt', 'death', 'fly'. Handles humanoid and quadruped rigs. Treat the result as a strong first pass: run analyze_animation, refine with add_keyframes, preview_animation, then request_review.",
    obj(
      {
        type: {
          type: "string",
          enum: ["idle", "walk", "run", "attack", "cast", "jump", "hurt", "death", "fly"],
          description: "Which cycle to build.",
        },
        name: { type: "string", description: "Animation name (default 'animation.<project>.<type>')." },
        length: { type: "number", description: "Length in seconds (sensible default per type: idle 4, walk 1, run 0.62, attack 0.85)." },
        loop: { type: "string", enum: ["once", "hold", "loop"], description: "Override the default loop mode." },
        intensity: { type: "number", description: "Amplitude multiplier 0.2-2.5 (default 1). Raise for exaggerated/heavy creatures." },
        hand: { type: "string", enum: ["right", "left"], description: "Which hand attacks (default 'right' — the model's OWN right)." },
        direction: { type: "string", enum: ["backward", "forward"], description: "Which way a death fall goes (default backward)." },
        replace: { type: "boolean", description: "Replace an existing animation of the same name (default true)." },
      },
      ["type"]
    )
  ),
  {
    name: "analyze_animation",
    description:
      "MEASURE an animation instead of eyeballing it — this is what catches 'the attack swings backwards'. It evaluates the rig at sampled times and reports, for every hand/foot/head/tail tip, how far it actually travels FORWARD / BACK / LEFT / RIGHT / UP in the model's own axes and when, plus: whether a loop closes, keyframe counts per bone, all-linear interpolation, and limbs whose lower segment never moves while the upper one swings (the cardboard tell). For strike-like animations it explicitly verdicts the direction. Run it after every generate_animation and after hand-writing keyframes, fix what it reports, then re-run.",
    inputSchema: obj(
      {
        animation: { type: "string", description: "uuid or name of the animation." },
        samples: { type: "number", description: "How many times to sample across the animation (default 16)." },
        expect: { type: "string", description: "What the animation is meant to be ('attack', 'walk', …) when the name doesn't say so." },
      },
      ["animation"]
    ),
    handler: async (args) => text(await callBlockbench("analyze_animation", args, 120_000)),
  },
  {
    name: "preview_animation",
    description:
      "Render an animation's poses at several times as labelled images, so you (and the user) can actually SEE it instead of trusting the keyframe numbers. Each image is stamped with the time, the view, and which edge of the image is the model's right. Pair it with analyze_animation (the numbers) and request_review (the human verdict).",
    inputSchema: obj(
      {
        animation: { type: "string", description: "uuid or name of the animation." },
        times: { type: "array", items: { type: "number" }, description: "Times in seconds (default 0/25/50/75% of the length)." },
        views: { type: "array", items: { type: "string" }, description: "Model-relative views per pose (default ['front_right']). 'left' is a good second view for gaits." },
        width: { type: "number" },
        height: { type: "number" },
      },
      ["animation"]
    ),
    handler: async (args) => {
      const res: any = await callBlockbench("preview_animation", args, 120_000);
      return [
        { type: "text", text: `${res.animation} (${res.length}s) — ${res.count} pose(s)` },
        ...shotBlocks(res.shots),
      ];
    },
  },

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
      "Capture the 3D preview as an image. Pass `view` to aim the camera in one step (model-relative: 'front' looks at its FACE, 'back', 'left'/'right' = the side its left/right arm is on, 'front_right', 'top'). Every capture is stamped with what it shows and WHICH EDGE OF THE IMAGE is the model's own right — a front view is mirrored, so its right hand appears on the image's left. Read that stamp instead of guessing sides. A screenshot is for YOUR iteration; it is not verification — use request_review for that.",
    inputSchema: obj({
      view: { type: "string", description: "Model-relative view to aim at first. Omit to use the current camera." },
      width: { type: "number" },
      height: { type: "number" },
      annotate: { type: "boolean", description: "Stamp the view/side labels onto the image (default true)." },
    }),
    handler: async (args) => {
      const res: any = await callBlockbench("screenshot", args);
      return [
        { type: "text", text: `${res.view} — looking at ${res.looking_at}. ${res.note || ""}` },
        { type: "image", data: res.base64, mimeType: "image/png" },
      ];
    },
  },
  {
    name: "screenshot_views",
    description:
      "Capture several camera angles in ONE call so you can see the whole model and catch problems (gaps, wrong rotations, missing detail, asymmetry) from every side. Views are named from the MODEL's point of view — 'front' shows its FACE (not the +Z side), 'left' is the side its left arm is on — and each image is stamped with which edge is the model's right, because front views are mirrored. Defaults to front_right/front/left/back. Do this after each modeling/texturing pass, then request_review so the USER confirms it rather than you.",
    inputSchema: obj({
      views: {
        type: "array",
        description:
          "Views in order. Each item is a model-relative name ('front','back','left','right','top','bottom','front_right','front_left','back_right','back_left'), a world axis ('+x','-z','north','east'), or a {position:[x,y,z], target:[x,y,z]} object. Omit for a sensible default set.",
        items: {},
      },
      width: { type: "number" },
      height: { type: "number" },
      annotate: { type: "boolean", description: "Stamp view/side labels onto each image (default true)." },
    }),
    handler: async (args) => {
      const res: any = await callBlockbench("screenshot_views", args);
      return [
        { type: "text", text: `Captured ${res.count} view(s). ${res.orientation}` },
        ...shotBlocks(res.shots),
      ];
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
    "Run arbitrary JavaScript inside Blockbench's renderer for anything not covered by a dedicated tool. The code has access to all Blockbench globals (Project, Cube, Group, Texture, Animation, Codecs, Undo, Canvas, Outliner, Format, Formats, ...) and receives a `params` object. It runs as a FUNCTION BODY, so you must `return` explicitly — a bare trailing expression is NOT returned. A returned Promise is awaited. Use sparingly; prefer dedicated tools.",
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

/**
 * The exported catalogue. Every handler is wrapped so arguments are normalised
 * against its own schema first (see coerceArgs) — that is what lets a client
 * send `matrix` as one newline-separated blob, `palette` as JSON text or
 * `open_faces` as "north,down" and still get the same result.
 */
export const tools: ToolDef[] = catalogue.map((tool) => ({
  ...tool,
  handler: (args: Record<string, any>) => tool.handler(coerceArgs(tool.inputSchema, args ?? {})),
}));
