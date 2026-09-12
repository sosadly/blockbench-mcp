/**
 * Tests for the MCP tool catalogue, run against the compiled dist/ output —
 * the code that actually ships. No dependencies beyond Node's built-in runner.
 *
 *   npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { tools, text, coerceArgs } from "../dist/tools.js";

const byName = (name) => tools.find((t) => t.name === name);
const props = (name) => byName(name).inputSchema.properties;
const required = (name) => byName(name).inputSchema.required ?? [];

// --- text() -----------------------------------------------------------------

test("text() coerces undefined into a valid content block", () => {
  // JSON.stringify(undefined) is undefined, which would emit {type:"text", text: undefined}
  // and fail MCP's union validation on the client.
  const blocks = text(undefined);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "text");
  assert.equal(typeof blocks[0].text, "string");
  assert.equal(blocks[0].text, "(undefined)");
});

test("text() passes strings through and pretty-prints objects", () => {
  assert.equal(text("hello")[0].text, "hello");
  assert.equal(text(null)[0].text, "null");
  assert.equal(text({ a: 1 })[0].text, JSON.stringify({ a: 1 }, null, 2));
});

test("every tool has a name, a description and an object schema", () => {
  assert.ok(tools.length > 0);
  const names = new Set();
  for (const t of tools) {
    assert.match(t.name, /^[a-z][a-z0-9_]*$/, `bad tool name: ${t.name}`);
    assert.ok(!names.has(t.name), `duplicate tool name: ${t.name}`);
    names.add(t.name);
    assert.ok(t.description.length > 20, `${t.name} needs a real description`);
    assert.equal(t.inputSchema.type, "object");
    assert.equal(typeof t.handler, "function");
  }
});

// --- orientation: the left/right fix ---------------------------------------

test("orientation tools are registered", () => {
  for (const name of ["get_orientation", "which_side", "check_sides"]) {
    assert.ok(byName(name), `${name} should be registered`);
  }
  assert.deepEqual(required("which_side"), ["element"]);
});

test("cube and bone creation accept a validated `side`", () => {
  for (const name of ["add_cube", "add_group"]) {
    const side = props(name).side;
    assert.ok(side, `${name} should take a side`);
    assert.deepEqual(side.enum, ["left", "right"]);
  }
});

test("side-sensitive tools state the convention in their description", () => {
  // The model faces -Z, so its own right is +X. Anything that can get this
  // wrong should say so where the model will actually read it.
  for (const name of ["get_orientation", "add_cube", "add_cubes"]) {
    assert.match(byName(name).description, /\+X|\+x/, `${name} should name the right axis`);
  }
  // Renders are mirrored from the front; the capture tools must warn about it.
  for (const name of ["screenshot", "screenshot_views"]) {
    assert.match(byName(name).description, /mirror/i, `${name} should warn about mirroring`);
  }
});

// --- review gate ------------------------------------------------------------

test("request_review and ask_user are registered and blocking-capable", () => {
  for (const name of ["request_review", "ask_user"]) {
    const tool = byName(name);
    assert.ok(tool, `${name} should be registered`);
    assert.deepEqual(required(name), ["question"]);
    assert.equal(props(name).timeout_seconds.type, "number");
  }
  assert.match(byName("request_review").description, /wait/i);
});

// --- rigging & animation quality -------------------------------------------

test("rigging tools are registered with segment controls", () => {
  assert.ok(byName("create_rig"));
  assert.ok(byName("check_rig"));
  assert.ok(byName("get_rig"));
  const p = props("create_rig");
  assert.deepEqual(p.type.enum, ["humanoid", "quadruped"]);
  for (const key of ["arm_segments", "leg_segments", "spine_segments", "tail_segments"]) {
    assert.equal(p[key].type, "number", `create_rig should expose ${key}`);
  }
});

test("generate_animation covers the standard cycle set", () => {
  const types = props("generate_animation").type.enum;
  for (const t of ["idle", "walk", "run", "attack", "cast", "jump", "hurt", "death", "fly"]) {
    assert.ok(types.includes(t), `generate_animation should support ${t}`);
  }
  assert.deepEqual(required("generate_animation"), ["type"]);
  assert.deepEqual(props("generate_animation").hand.enum, ["right", "left"]);
});

test("animation inspection tools are registered", () => {
  assert.ok(byName("analyze_animation"));
  assert.ok(byName("preview_animation"));
  assert.deepEqual(required("analyze_animation"), ["animation"]);
});

test("add_keyframes documents the rotation signs and offers close_loop", () => {
  const tool = byName("add_keyframes");
  assert.equal(props("add_keyframes").close_loop.type, "boolean");
  assert.match(tool.description, /\+X/);
  assert.match(tool.description, /elbow/i);
});

test("get_guide exposes the orientation, rigging and review playbooks", () => {
  const topics = props("get_guide").topic.enum;
  for (const t of ["modeling", "detailing", "orientation", "rigging", "texturing", "vfx", "animation", "review", "reference"]) {
    assert.ok(topics.includes(t), `get_guide should offer ${t}`);
  }
});

// --- export & escape hatch (regressions) ------------------------------------

test("export_model is registered and requires a path", () => {
  const tool = byName("export_model");
  assert.ok(tool);
  assert.deepEqual(required("export_model"), ["path"]);
  assert.equal(props("export_model").codec.type, "string");
  assert.equal(props("export_model").format.type, "string");
  assert.match(tool.description, /gltf/i);
});

test("execute_script documents that an explicit return is required", () => {
  const tool = byName("execute_script");
  assert.match(tool.description, /return/);
  assert.match(tool.inputSchema.properties.code.description, /explicit `return`/);
  assert.match(tool.inputSchema.properties.code.description, /trailing expression is NOT returned/i);
  assert.match(tool.inputSchema.properties.code.description, /Promise/);
});

// --- procedural generators (detail density) ---------------------------------

test("every procedural generator is registered with its required inputs", () => {
  const expected = {
    voxelize_matrix: ["matrix"],
    add_hollow_volume: ["bounds"],
    generate_array: ["element_size"],
    extrude_chain: ["base_origin"],
    add_wing: ["side", "base_origin"],
    audit_complexity: [],
  };
  for (const [name, req] of Object.entries(expected)) {
    assert.ok(byName(name), `${name} should be registered`);
    assert.deepEqual(required(name), req, `${name} required fields`);
  }
});

test("voxelize_matrix takes a string matrix, a palette and the three planes", () => {
  const p = props("voxelize_matrix");
  assert.equal(p.matrix.type, "array");
  assert.equal(p.matrix.items.type, "string");
  assert.equal(p.palette.type, "object");
  assert.deepEqual(p.plane.enum, ["xy", "xz", "yz"]);
  assert.equal(p.merge_adjacent.type, "boolean");
  assert.equal(p.pixel_size.type, "number");
  assert.equal(p.default_depth.type, "number");
  assert.deepEqual(p.origin.items, { type: "number" });
  assert.deepEqual(p.side.enum, ["left", "right"]);
  // The description has to teach the plane mapping, or the model guesses axes.
  assert.match(byName("voxelize_matrix").description, /rows are top-to-bottom/i);
  assert.match(byName("voxelize_matrix").description, /offset_z/);
});

test("add_hollow_volume documents the face names and takes bounds + thickness", () => {
  const p = props("add_hollow_volume");
  assert.equal(p.bounds.type, "object");
  assert.deepEqual(p.bounds.required, ["from", "to"]);
  assert.equal(p.wall_thickness.type, "number");
  assert.equal(p.open_faces.type, "array");
  for (const face of ["north", "south", "east", "west", "up", "down"]) {
    assert.ok(p.open_faces.items.enum.includes(face), `open_faces should accept ${face}`);
  }
  // north = -Z is the single fact that makes a hood open at the face.
  assert.match(byName("add_hollow_volume").description, /north=-Z/);
});

test("generate_array covers all three modes and the anti-z-fighting control", () => {
  const p = props("generate_array");
  assert.deepEqual(p.mode.enum, ["linear", "radial", "grid"]);
  assert.deepEqual(p.anchor.enum, ["center", "top", "bottom", "min"]);
  assert.deepEqual(p.distribution.enum, ["span", "cells"]);
  assert.deepEqual(p.depth_axis.enum, ["auto", "x", "y", "z", "radial", "none"]);
  for (const key of ["count", "depth_stagger", "seed", "arc_degrees"]) {
    assert.equal(p[key].type, "number", `generate_array should expose ${key}`);
  }
  assert.equal(p.rotation_range.type, "object");
  assert.equal(p.jitter.maxItems, 3);
  assert.equal(p.radii.maxItems, 2);
  assert.match(byName("generate_array").description, /z-fight/i);
});

test("extrude_chain defaults to bones and explains the curvature", () => {
  const p = props("extrude_chain");
  assert.equal(p.create_bones.type, "boolean");
  assert.deepEqual(p.direction.enum, ["up", "down", "forward", "back", "left", "right"]);
  assert.equal(p.initial_size.maxItems, 2);
  assert.equal(p.curvature.maxItems, 3);
  for (const key of ["segments", "segment_length", "taper", "length_taper"]) {
    assert.equal(p[key].type, "number", `extrude_chain should expose ${key}`);
  }
  assert.match(byName("extrude_chain").description, /bone/i);
  assert.match(byName("extrude_chain").description, /tip/);
});

test("add_wing exposes the wing layout and steers away from hand-built membranes", () => {
  const p = props("add_wing");
  assert.deepEqual(p.side.enum, ["left", "right"]);
  assert.deepEqual(p.plane.enum, ["horizontal", "vertical"]);
  assert.deepEqual(p.membrane.enum, ["auto", "cubes", "mesh", "none"]);
  for (const key of ["fingers", "arm_length", "forearm_length", "arm_angle", "forearm_angle", "membrane_sag", "membrane_step"]) {
    assert.equal(p[key].type, "number", `add_wing should expose ${key}`);
  }
  assert.equal(p.finger_spread.maxItems, 2);
  assert.deepEqual(coerceArgs(byName("add_wing").inputSchema, { finger_length: "[18,16,14]" }).finger_length, [18, 16, 14]);
  const d = byName("add_wing").description;
  assert.match(d, /membrane/i);
  assert.match(d, /fly/);
  assert.match(d, /gaps/);
});

test("audit_complexity states the cube budgets and its three verdicts", () => {
  const d = byName("audit_complexity").description;
  assert.deepEqual(props("audit_complexity").target.enum, ["auto", "prop", "character", "creature", "hero"]);
  for (const verdict of ["too_primitive", "acceptable", "high_detail"]) {
    assert.ok(d.includes(verdict), `the description should name the ${verdict} verdict`);
  }
  assert.match(d, /30-60/);
  assert.match(d, /100-180/);
  assert.match(d, /180-300/);
});

test("add_cubes points at the budget and the generators instead of 6-8 boxes", () => {
  const d = byName("add_cubes").description;
  assert.match(d, /BUDGET/);
  for (const tool of ["add_hollow_volume", "generate_array", "extrude_chain", "add_wing", "voxelize_matrix"]) {
    assert.ok(d.includes(tool), `add_cubes should hand off to ${tool}`);
  }
});

// --- argument coercion (clients serialize arrays differently) ---------------

test("coerceArgs parses JSON text into the arrays and objects a schema wants", () => {
  const schema = byName("voxelize_matrix").inputSchema;
  const out = coerceArgs(schema, {
    matrix: '["##","##"]',
    palette: '{"#":{"depth":2}}',
    pixel_size: "2",
    merge_adjacent: "true",
  });
  assert.deepEqual(out.matrix, ["##", "##"]);
  assert.deepEqual(out.palette, { "#": { depth: 2 } });
  assert.equal(out.pixel_size, 2);
  assert.equal(out.merge_adjacent, true);
});

test("coerceArgs splits a matrix blob on newlines and a list on commas", () => {
  const matrix = coerceArgs(byName("voxelize_matrix").inputSchema, { matrix: "..#..\n.###." });
  assert.deepEqual(matrix.matrix, ["..#..", ".###."]);

  const faces = coerceArgs(byName("add_hollow_volume").inputSchema, { open_faces: "north, down" });
  assert.deepEqual(faces.open_faces, ["north", "down"]);

  const nums = coerceArgs(byName("generate_array").inputSchema, { start: "0,12,3" });
  assert.deepEqual(nums.start, [0, 12, 3]);
});

test("coerceArgs wraps a single value where a list is expected, and leaves the rest alone", () => {
  const one = coerceArgs(byName("add_cubes").inputSchema, { cubes: { name: "a", from: [0, 0, 0], to: [1, 1, 1] } });
  assert.ok(Array.isArray(one.cubes));
  assert.equal(one.cubes.length, 1);

  const untouched = { matrix: ["#"], name: "blade", origin: [1, 2, 3] };
  assert.deepEqual(coerceArgs(byName("voxelize_matrix").inputSchema, untouched), untouched);
  // A free-form string property must never be split.
  const q = coerceArgs(byName("ask_user").inputSchema, { question: "left, or right?" });
  assert.equal(q.question, "left, or right?");
  // Unknown keys pass through untouched rather than being dropped.
  assert.equal(coerceArgs(byName("get_status").inputSchema, { odd: 1 }).odd, 1);
});
