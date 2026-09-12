/**
 * Behaviour tests for the procedural generators in the bridge plugin.
 *
 * The plugin is a Blockbench-renderer script, not a module, so it is loaded
 * into a vm context with stubbed Blockbench globals (Cube, Group, Undo, ...)
 * and its `commands` object is captured. That means these tests exercise the
 * REAL geometry maths that ships — matrix extrusion, shell partitioning, array
 * distribution, chain curvature — rather than a copy of it.
 *
 *   npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(here, "..", "plugin", "blockbench_mcp.js");
const source = fs.readFileSync(PLUGIN, "utf8");

// Expose the command table without changing the plugin's own shape.
const REGISTER = "Plugin.register(PLUGIN_ID, {";
assert.ok(source.includes(REGISTER), "plugin registration call moved — update this harness");
const instrumented = source.replace(
  REGISTER,
  "globalThis.__MCP_COMMANDS__ = commands;\n" +
    "globalThis.__MCP_INTERNALS__ = { detectRig, genFly, rigFrame };\n" + REGISTER
);

/** A fresh, empty Blockbench-ish world plus the plugin's command table. */
function loadPlugin(overrides = {}) {
  let seq = 0;
  const uuid = (p) => `${p}-${++seq}`;

  class Group {
    static all = [];
    constructor(data = {}) {
      this.name = data.name || "group";
      this.origin = (data.origin || [0, 0, 0]).slice();
      this.rotation = (data.rotation || [0, 0, 0]).slice();
      this.children = [];
      this.parent = "root";
      this.uuid = uuid("g");
    }
    init() { Group.all.push(this); return this; }
    addTo(parent) {
      if (parent && parent !== "root") { this.parent = parent; parent.children.push(this); }
      else this.parent = "root";
      return this;
    }
  }

  class Cube {
    static all = [];
    constructor(data = {}) {
      this.name = data.name || "cube";
      this.from = (data.from || [0, 0, 0]).slice();
      this.to = (data.to || [1, 1, 1]).slice();
      this.origin = (data.origin || this.from).slice();
      this.rotation = (data.rotation || [0, 0, 0]).slice();
      this.inflate = data.inflate || 0;
      this.autouv = data.autouv;
      this.box_uv = data.box_uv;
      this.uv_offset = data.uv_offset;
      this.faces = {};
      this.parent = "root";
      this.uuid = uuid("c");
    }
    init() { Cube.all.push(this); return this; }
    addTo(parent) {
      if (parent && parent !== "root") { this.parent = parent; parent.children.push(this); }
      else this.parent = "root";
      return this;
    }
    applyTexture() {}
  }

  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Buffer,
    isApp: true,
    Plugin: { register() {} },
    Blockbench: { version: "5.1.4", showQuickMessage() {} },
    Project: { name: "test", geometry_name: "test", texture_width: 64, texture_height: 64 },
    Format: { id: "free", box_uv: false, animation_mode: false },
    Formats: {},
    Mode: { selected: { id: "edit" } },
    Texture: Object.assign([], { all: [], getDefault: () => null }),
    Animation: { all: [] },
    Undo: { initEdit() {}, finishEdit() {} },
    Canvas: { updateAll() {} },
    Outliner: { root: [] },
    Group,
    Cube,
    ...overrides,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(instrumented, sandbox, { filename: "blockbench_mcp.js" });
  return { commands: sandbox.__MCP_COMMANDS__, internals: sandbox.__MCP_INTERNALS__, Cube, Group, sandbox };
}

/**
 * Values produced inside the vm have that realm's Array/Object prototypes, so
 * deepStrictEqual would reject them for identity reasons alone. Round-trip
 * through JSON to compare them by value.
 */
const plain = (v) => JSON.parse(JSON.stringify(v));
const size = (c) => [c.to[0] - c.from[0], c.to[1] - c.from[1], c.to[2] - c.from[2]];
const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const closeVec = (a, b, eps = 1e-4) =>
  a.length === b.length && a.every((v, i) => close(v, b[i], eps));
/** Do two axis-aligned boxes share real volume? */
function intersects(a, b) {
  for (let i = 0; i < 3; i++) {
    if (Math.min(a.to[i], b.to[i]) - Math.max(a.from[i], b.from[i]) > 1e-9) continue;
    return false;
  }
  return true;
}

test("the harness loads the plugin and exposes every generator", () => {
  const { commands } = loadPlugin();
  for (const name of [
    "voxelize_matrix", "add_hollow_volume", "generate_array", "extrude_chain", "add_wing", "audit_complexity",
  ]) {
    assert.equal(typeof commands[name], "function", `${name} should be a command`);
  }
});

// --- voxelize_matrix --------------------------------------------------------

test("voxelize_matrix extrudes a matrix with the first row at the TOP", () => {
  const { commands, Cube } = loadPlugin();
  const res = commands.voxelize_matrix({
    matrix: [".#.", "###", ".#."],
    origin: [0, 0, 0],
  });
  assert.equal(res.created, 5);
  assert.equal(Cube.all.length, 5);
  assert.deepEqual(plain(res.grid), { columns: 3, rows: 3 });

  // Row 0 is the highest cell: y 2..3. Row 2 is the lowest: y 0..1.
  const top = Cube.all[0];
  assert.ok(closeVec(top.from, [1, 2, 0]), `top cell at ${top.from}`);
  assert.ok(closeVec(top.to, [2, 3, 1]), `top cell to ${top.to}`);
  const bottom = Cube.all[Cube.all.length - 1];
  assert.ok(closeVec(bottom.from, [1, 0, 0]), `bottom cell at ${bottom.from}`);
  // Default depth 1 along +Z for the xy plane.
  assert.ok(Cube.all.every((c) => close(size(c)[2], 1)));
});

test("voxelize_matrix honours pixel_size, palette depth/offset and names", () => {
  const { commands, Cube } = loadPlugin();
  const res = commands.voxelize_matrix({
    matrix: ["#=", "#="],
    pixel_size: 2,
    default_depth: 1,
    origin: [10, 4, -2],
    palette: { "#": { name: "blade", depth: 3 }, "=": { name: "rim", depth: 1, offset_z: -0.5 } },
  });
  assert.equal(res.created, 4);
  const blade = Cube.all.find((c) => c.name.startsWith("blade"));
  const rim = Cube.all.find((c) => c.name.startsWith("rim"));
  assert.ok(closeVec(size(blade), [2, 2, 3]), `blade size ${size(blade)}`);
  assert.ok(closeVec(size(rim), [2, 2, 1]), `rim size ${size(rim)}`);
  assert.equal(blade.from[2], -2, "depth starts at the origin's z");
  assert.equal(rim.from[2], -2.5, "offset_z shifts along the depth axis");
  assert.equal(blade.from[1], 6, "second row sits one pixel_size above the first");
  assert.deepEqual(plain(res.symbols), { "#": 2, "=": 2 });
});

test("voxelize_matrix merges runs when asked, without changing the shape", () => {
  const perCell = loadPlugin();
  const perCellRes = perCell.commands.voxelize_matrix({ matrix: ["####"] });
  const merged = loadPlugin();
  const mergedRes = merged.commands.voxelize_matrix({ matrix: ["####"], merge_adjacent: true });

  assert.equal(perCellRes.created, 4);
  assert.equal(mergedRes.created, 1);
  assert.deepEqual(plain(mergedRes.bounds.size), plain(perCellRes.bounds.size), "merging must not move any surface");
  assert.ok(closeVec(merged.Cube.all[0].from, [0, 0, 0]));
  assert.ok(closeVec(merged.Cube.all[0].to, [4, 1, 1]));
});

test("voxelize_matrix maps every plane onto the documented axes", () => {
  for (const [plane, expected] of [
    ["xy", [1, 1, 2]], // columns->X, rows->Y, depth->Z
    ["xz", [1, 2, 1]], // columns->X, rows->Z, depth->Y
    ["yz", [2, 1, 1]], // columns->Z, rows->Y, depth->X
  ]) {
    const { commands, Cube } = loadPlugin();
    commands.voxelize_matrix({ matrix: ["#"], plane, default_depth: 2 });
    assert.ok(
      closeVec(size(Cube.all[0]), expected),
      `plane ${plane} produced ${size(Cube.all[0])}, expected ${expected}`
    );
  }
});

test("voxelize_matrix skips blanks, reports unmapped characters and refuses nonsense", () => {
  const { commands } = loadPlugin();
  const res = commands.voxelize_matrix({ matrix: ["#. x", "    "], palette: { "#": {} } });
  assert.equal(res.created, 2, "'.' and ' ' are blank, '#' and 'x' are not");
  assert.deepEqual(plain(res.unmapped_chars), { x: 1 });

  assert.throws(() => commands.voxelize_matrix({}), /matrix is required/);
  assert.throws(() => commands.voxelize_matrix({ matrix: ["..."] }), /every cell was blank/);
  assert.throws(() => commands.voxelize_matrix({ matrix: ["#"], plane: "ab" }), /Unknown plane/);
  assert.throws(() => commands.voxelize_matrix({ matrix: ["#"], pixel_size: 0 }), /pixel_size/);
  assert.throws(
    () => commands.voxelize_matrix({ matrix: ["####"], max_cubes: 2 }),
    /safety cap/,
    "the budget guard should fire before any geometry exists"
  );
});

test("voxelize_matrix accepts a newline blob and a JSON string (client serialization)", () => {
  const { commands } = loadPlugin();
  assert.equal(commands.voxelize_matrix({ matrix: "##\n##" }).created, 4);
  assert.equal(commands.voxelize_matrix({ matrix: '["#","#"]' }).created, 2);
  const res = commands.voxelize_matrix({ matrix: ["#"], palette: '{"#":{"name":"edge","depth":4}}' });
  assert.equal(res.sample[0].name.startsWith("edge"), true);
});

// --- add_hollow_volume ------------------------------------------------------

test("add_hollow_volume builds six non-overlapping walls around a cavity", () => {
  const { commands, Cube } = loadPlugin();
  const res = commands.add_hollow_volume({
    bounds: { from: [-4, 0, -4], to: [4, 8, 4] },
    wall_thickness: 1,
    name: "helm",
  });
  assert.equal(res.created, 6);
  assert.deepEqual(plain(res.walls).sort(), ["down", "east", "north", "south", "up", "west"]);
  assert.deepEqual(plain(res.cavity.from), [-3, 1, -3]);
  assert.deepEqual(plain(res.cavity.to), [3, 7, 3]);
  assert.deepEqual(plain(res.cavity_size), [6, 6, 6]);

  for (let i = 0; i < Cube.all.length; i++) {
    for (let j = i + 1; j < Cube.all.length; j++) {
      assert.ok(
        !intersects(Cube.all[i], Cube.all[j]),
        `${Cube.all[i].name} overlaps ${Cube.all[j].name} — overlapping walls z-fight`
      );
    }
  }
  assert.ok(Cube.all.every((c) => c.name.startsWith("helm_")));
});

test("add_hollow_volume opens the faces it is told to, by any accepted name", () => {
  const { commands } = loadPlugin();
  const hood = commands.add_hollow_volume({
    bounds: { from: [-5, 20, -5], to: [5, 30, 5] },
    wall_thickness: 1.5,
    open_faces: ["north", "down"],
    name: "hood",
  });
  assert.equal(hood.created, 4);
  assert.ok(!hood.walls.includes("north") && !hood.walls.includes("down"));
  // With the front open the side walls reach the front plane.
  assert.equal(hood.cavity.from[2], -5);
  assert.equal(hood.cavity.from[1], 20);

  const aliased = loadPlugin().commands.add_hollow_volume({
    bounds: { from: [0, 0, 0], to: [4, 4, 4] },
    open_faces: ["front", "bottom"],
  });
  assert.deepEqual(plain(aliased.walls).sort(), plain(hood.walls).sort(), "front/bottom must mean north/down");

  // A comma-separated string is what some clients send.
  const asString = loadPlugin().commands.add_hollow_volume({
    bounds: { from: [0, 0, 0], to: [4, 4, 4] },
    open_faces: "north,down",
  });
  assert.equal(asString.created, 4);
});

test("add_hollow_volume clamps an impossible wall thickness and says so", () => {
  const { commands } = loadPlugin();
  const res = commands.add_hollow_volume({
    bounds: { from: [0, 0, 0], to: [4, 4, 4] },
    wall_thickness: 6,
  });
  assert.equal(res.wall_thickness.x, 2);
  assert.ok(res.warnings.some((w) => /clamped/.test(w)));
  assert.ok(res.warnings.some((w) => /solid box/.test(w)));
});

test("add_hollow_volume rejects bad input with actionable messages", () => {
  const { commands } = loadPlugin();
  assert.throws(() => commands.add_hollow_volume({}), /bounds/);
  assert.throws(
    () => commands.add_hollow_volume({ bounds: { from: [0, 0, 0], to: [0, 5, 5] } }),
    /positive size on every axis/
  );
  assert.throws(
    () => commands.add_hollow_volume({ bounds: { from: [0, 0, 0], to: [4, 4, 4] }, wall_thickness: 0 }),
    /wall_thickness/
  );
  assert.throws(
    () => commands.add_hollow_volume({
      bounds: { from: [0, 0, 0], to: [4, 4, 4] },
      open_faces: ["north", "south", "east", "west", "up", "down"],
    }),
    /nothing to build/
  );
  assert.throws(
    () => commands.add_hollow_volume({ bounds: { from: [0, 0, 0], to: [4, 4, 4] }, open_faces: ["sideways"] }),
    /Unknown face/
  );
});

// --- generate_array ---------------------------------------------------------

test("generate_array spans a line and centres each element on its point", () => {
  const { commands, Cube } = loadPlugin();
  const res = commands.generate_array({
    mode: "linear",
    count: 5,
    element_size: [2, 4, 1],
    start: [-8, 10, 3],
    end: [8, 10, 3],
    name_prefix: "shingle",
  });
  assert.equal(res.created, 5);
  assert.equal(Cube.all[0].name, "shingle_1");
  // anchor 'center' -> the first element is centred on `start`.
  assert.ok(closeVec(Cube.all[0].origin, [-8, 10, 3]));
  assert.ok(closeVec(Cube.all[0].from, [-9, 8, 2.5]));
  assert.ok(closeVec(Cube.all[4].origin, [8, 10, 3]), "the last element lands on `end`");
  assert.ok(Cube.all.every((c) => closeVec(size(c), [2, 4, 1])));
});

test("generate_array 'cells' distribution tiles without hanging off the ends", () => {
  const { commands, Cube } = loadPlugin();
  commands.generate_array({
    mode: "linear", count: 4, element_size: [2, 2, 2],
    start: [0, 0, 0], end: [8, 0, 0], distribution: "cells",
  });
  assert.ok(closeVec(Cube.all[0].origin, [1, 0, 0]));
  assert.ok(closeVec(Cube.all[3].origin, [7, 0, 0]));
});

test("generate_array anchors, tapers and staggers depth", () => {
  const { commands, Cube } = loadPlugin();
  commands.generate_array({
    mode: "linear", count: 4, element_size: [2, 6, 2],
    start: [0, 12, 0], end: [6, 12, 0],
    anchor: "top", size_decay: [0, -1, 0], depth_stagger: 0.15,
  });
  // 'top' hangs the element below its point, and the pivot stays at the point.
  assert.ok(closeVec(Cube.all[0].origin, [0, 12, 0]));
  assert.equal(Cube.all[0].to[1], 12);
  assert.equal(Cube.all[0].from[1], 6);
  // size_decay shortens each successive element.
  assert.equal(size(Cube.all[3])[1], 3);
  // depth_stagger alternates along Z (perpendicular to a run along X).
  assert.equal(Cube.all[0].origin[2], 0);
  assert.ok(close(Cube.all[1].origin[2], 0.15), `staggered z was ${Cube.all[1].origin[2]}`);
  assert.equal(Cube.all[2].origin[2], 0);
});

test("generate_array warns about a missing depth stagger only when elements overlap", () => {
  const overlapping = loadPlugin().commands.generate_array({
    mode: "linear", count: 6, element_size: [3, 3, 1], start: [0, 0, 0], end: [10, 0, 0],
  });
  assert.match(overlapping.hint, /depth_stagger/);

  // Spaced out (fence posts, ribs): no overlap, so no nagging.
  const spaced = loadPlugin().commands.generate_array({
    mode: "linear", count: 6, element_size: [1, 3, 1], start: [0, 0, 0], end: [30, 0, 0],
  });
  assert.equal(spaced.hint, undefined);
});

test("generate_array distributes a radial ring and turns elements outward", () => {
  const { commands, Cube } = loadPlugin();
  const res = commands.generate_array({
    mode: "radial", count: 8, element_size: [1, 3, 1],
    center: [0, 6, 0], radii: [5, 5], name_prefix: "tooth",
  });
  assert.equal(res.created, 8);
  Cube.all.forEach((c) => {
    const r = Math.hypot(c.origin[0], c.origin[2]);
    assert.ok(close(r, 5, 1e-6), `element off the ring at radius ${r}`);
    assert.equal(c.origin[1], 6);
  });
  // start_degrees 0 puts the first element on +X, facing away from the centre.
  assert.ok(closeVec(Cube.all[0].origin, [5, 6, 0]));
  assert.ok(close(Cube.all[0].rotation[1], -90), `outward rotation was ${Cube.all[0].rotation[1]}`);
  assert.ok(close(Math.abs(Cube.all[2].rotation[1]), 180), `quarter-turn rotation was ${Cube.all[2].rotation[1]}, expected +-180 (facing +Z)`);
});

test("generate_array halves a ring on request and lays out a grid", () => {
  const half = loadPlugin();
  half.commands.generate_array({
    mode: "radial", count: 3, element_size: [1, 1, 1],
    center: [0, 0, 0], radii: [4, 4], arc_degrees: 180, start_degrees: 0,
  });
  assert.ok(closeVec(half.Cube.all[0].origin, [4, 0, 0]));
  assert.ok(closeVec(half.Cube.all[2].origin, [-4, 0, 0], 1e-6));

  const grid = loadPlugin();
  const res = grid.commands.generate_array({
    mode: "grid", element_size: [1, 1, 1], counts: [3, 1, 2],
    start: [0, 0, 0], end: [4, 0, 2],
  });
  assert.equal(res.created, 6);
  assert.ok(closeVec(grid.Cube.all[0].origin, [0, 0, 0]));
  assert.ok(closeVec(grid.Cube.all[5].origin, [4, 0, 2]));
});

test("generate_array is deterministic with a seed and random without one", () => {
  const args = {
    mode: "linear", count: 6, element_size: [2, 2, 2], start: [0, 0, 0], end: [10, 0, 0],
    jitter: [0.5, 0.5, 0.5], rotation_range: { min: [-10, -10, -10], max: [10, 10, 10] },
  };
  const a = loadPlugin(); a.commands.generate_array({ ...args, seed: 7 });
  const b = loadPlugin(); b.commands.generate_array({ ...args, seed: 7 });
  const c = loadPlugin(); c.commands.generate_array({ ...args, seed: 8 });
  const dump = (ctx) => ctx.Cube.all.map((x) => [...x.from, ...x.rotation].join(","));
  assert.deepEqual(dump(a), dump(b), "the same seed must reproduce the same array");
  assert.notDeepEqual(dump(a), dump(c), "a different seed must change it");
  // Rotation stays inside the requested range.
  a.Cube.all.forEach((x) => x.rotation.forEach((r) => assert.ok(r >= -10 && r <= 10)));
});

test("generate_array rejects bad input with actionable messages", () => {
  const { commands } = loadPlugin();
  assert.throws(() => commands.generate_array({ mode: "spiral", element_size: [1, 1, 1] }), /Unknown mode/);
  assert.throws(() => commands.generate_array({ mode: "linear", count: 3 }), /element_size/);
  assert.throws(
    () => commands.generate_array({ mode: "linear", count: 3, element_size: [0, 1, 1], start: [0, 0, 0], end: [1, 0, 0] }),
    /must be positive/
  );
  assert.throws(() => commands.generate_array({ mode: "linear", element_size: [1, 1, 1] }), /count/);
  assert.throws(
    () => commands.generate_array({ mode: "linear", count: 2, element_size: [1, 1, 1] }),
    /start.*end/
  );
  assert.throws(() => commands.generate_array({ mode: "radial", count: 2, element_size: [1, 1, 1] }), /center/);
  assert.throws(
    () => commands.generate_array({ mode: "linear", count: 5000, element_size: [1, 1, 1], start: [0, 0, 0], end: [1, 0, 0] }),
    /safety cap/
  );
  assert.throws(
    () => commands.generate_array({ mode: "linear", count: 2, element_size: [1, 1, 1], start: [0, 0, 0], end: [1, 0, 0], anchor: "sideways" }),
    /Unknown anchor/
  );
});

// --- extrude_chain ----------------------------------------------------------

test("extrude_chain builds a nested bone chain that tapers", () => {
  const { commands, Cube, Group } = loadPlugin();
  const res = commands.extrude_chain({
    segments: 4, base_origin: [0, 20, 4], segment_length: 3,
    initial_size: [4, 4], taper: 0.5, curvature: [10, 0, 0], name: "tail",
  });
  assert.equal(res.created, 4);
  assert.equal(Group.all.length, 4);
  assert.deepEqual(plain(Group.all.map((g) => g.name)), ["tail1", "tail2", "tail3", "tail4"]);
  // Nested: each bone is a child of the previous one.
  assert.equal(Group.all[0].parent, "root");
  assert.equal(Group.all[1].parent, Group.all[0]);
  assert.equal(Group.all[3].parent, Group.all[2]);
  // The rest pose is straight; the bones carry the curve.
  assert.deepEqual(plain(Group.all[0].rotation), [0, 0, 0]);
  assert.deepEqual(plain(Group.all[1].rotation), [10, 0, 0]);
  assert.ok(closeVec(Group.all[1].origin, [0, 23, 4]));
  // Cross-section shrinks toward the tip; length does not, by default.
  assert.ok(closeVec(size(Cube.all[0]), [4, 3, 4]));
  assert.ok(closeVec(size(Cube.all[3]), [2, 3, 2]));
  assert.equal(res.total_length, 12);
  assert.deepEqual(plain(res.end_thickness), [2, 2]);
});

test("extrude_chain reports where a curved chain actually ends", () => {
  const { commands } = loadPlugin();
  // Grow up, bend 90 degrees per segment about X: up, then back, then down.
  const res = commands.extrude_chain({
    segments: 3, base_origin: [0, 0, 0], segment_length: 4,
    initial_size: [2, 2], taper: 0, curvature: [90, 0, 0],
  });
  // seg0 straight up (0,4,0); seg1 rotated 90 about X -> +Z; seg2 -> down.
  assert.ok(closeVec(res.tip, [0, 0, 4], 1e-3), `tip was ${res.tip}`);
});

test("extrude_chain without bones bakes the accumulated rotation into each cube", () => {
  const { commands, Cube, Group } = loadPlugin();
  const res = commands.extrude_chain({
    segments: 3, base_origin: [0, 0, 0], segment_length: 4,
    initial_size: [2, 2], taper: 0, curvature: [30, 0, 0], create_bones: false,
  });
  assert.equal(Group.all.length, 0, "create_bones:false must not create bones");
  assert.deepEqual(plain(Cube.all[0].rotation), [0, 0, 0]);
  assert.ok(close(Cube.all[1].rotation[0], 30));
  assert.ok(close(Cube.all[2].rotation[0], 60));
  // Each cube pivots on the joint it starts from, which is the previous tip.
  assert.ok(closeVec(Cube.all[0].origin, [0, 0, 0]));
  assert.ok(closeVec(Cube.all[1].origin, [0, 4, 0]));
  assert.ok(closeVec(Cube.all[2].origin, [0, 4 + 4 * Math.cos(Math.PI / 6), 4 * Math.sin(Math.PI / 6)], 1e-3));
  assert.ok(res.note.includes("cannot be animated"));
});

test("extrude_chain grows in the direction it is given", () => {
  const down = loadPlugin();
  down.commands.extrude_chain({ segments: 2, base_origin: [0, 10, 0], segment_length: 3, direction: "down", taper: 0 });
  assert.ok(closeVec(down.Cube.all[0].from, [-2, 7, -2]));
  assert.ok(closeVec(down.Cube.all[0].to, [2, 10, 2]));

  const fwd = loadPlugin();
  const res = fwd.commands.extrude_chain({ segments: 2, base_origin: [0, 5, 0], segment_length: 3, direction: "forward", taper: 0 });
  // The model faces -Z, so 'forward' grows toward -Z.
  assert.ok(closeVec(res.tip, [0, 5, -6]));
});

test("extrude_chain warns about a boneless chain in an animated format", () => {
  const { commands } = loadPlugin({ Format: { id: "geckolib_model", box_uv: true, animation_mode: true } });
  const res = commands.extrude_chain({ segments: 2, base_origin: [0, 0, 0], create_bones: false });
  assert.match(res.warning, /create_bones:true/);
});

test("extrude_chain rejects bad input with actionable messages", () => {
  const { commands } = loadPlugin();
  assert.throws(() => commands.extrude_chain({ segments: 0 }), /segments/);
  assert.throws(() => commands.extrude_chain({ segments: 200 }), /64 cap/);
  assert.throws(() => commands.extrude_chain({ segments: 2, segment_length: 0 }), /segment_length/);
  assert.throws(() => commands.extrude_chain({ segments: 2, initial_size: [0, 4] }), /initial_size/);
  assert.throws(() => commands.extrude_chain({ segments: 2, direction: "sideways" }), /Unknown direction/);
  assert.throws(() => commands.extrude_chain({ segments: 2, parent: "nope" }), /Parent group not found/);
});

// --- audit_complexity -------------------------------------------------------

test("audit_complexity calls an empty model too_primitive", () => {
  const { commands } = loadPlugin();
  const res = commands.audit_complexity();
  assert.equal(res.verdict, "too_primitive");
  assert.equal(res.ready_for_texturing, false);
  assert.equal(res.issues[0].issue, "empty_model");
});

test("audit_complexity catches the monolithic-box blockout", () => {
  const { commands } = loadPlugin();
  // The classic AI model: one huge torso, one huge cloak, a head.
  commands.add_cubes({
    cubes: [
      { name: "torso", from: [-6, 10, -3], to: [6, 26, 3] },
      { name: "cloak", from: [-7, 6, 2], to: [7, 26, 5] },
      { name: "head", from: [-4, 26, -4], to: [4, 34, 4] },
    ],
  });
  const res = commands.audit_complexity({ target: "character" });
  assert.equal(res.verdict, "too_primitive");
  assert.equal(res.ready_for_texturing, false);
  const kinds = res.issues.map((i) => i.issue);
  assert.ok(kinds.includes("below_cube_budget"));
  assert.ok(kinds.includes("monolithic_box"), `expected a monolith issue, got ${kinds}`);
  assert.ok(kinds.includes("undetailed_slab"));
  assert.ok(res.monoliths.length >= 1);
  assert.ok(res.recommendations.join(" ").includes("add_hollow_volume"));
});

test("audit_complexity passes a dense, layered model", () => {
  const { commands } = loadPlugin();
  const cubes = [];
  // A layered torso: primary mass plus overlapping plates and micro-detail.
  for (let i = 0; i < 30; i++) {
    cubes.push({ name: `mass_${i}`, from: [-4, i * 0.5, -2], to: [4, i * 0.5 + 2, 2] });
  }
  for (let i = 0; i < 40; i++) {
    cubes.push({ name: `plate_${i}`, from: [-4.4, i * 0.4, 1.8], to: [-1, i * 0.4 + 1, 2.6] });
  }
  for (let i = 0; i < 40; i++) {
    cubes.push({ name: `stud_${i}`, from: [1 + (i % 4) * 0.4, i * 0.35, 1.9], to: [2 + (i % 4) * 0.4, i * 0.35 + 1, 2.9], rotation: [0, 45, 0] });
  }
  commands.add_cubes({ cubes });
  const res = commands.audit_complexity({ target: "character" });
  assert.equal(res.cubes, 110);
  assert.equal(res.verdict, "acceptable");
  assert.equal(res.ready_for_texturing, true);
  assert.ok(res.metrics.overlapping_pct > 50, `layering was ${res.metrics.overlapping_pct}%`);
  assert.ok(res.metrics.micro_pct >= 15, `micro detail was ${res.metrics.micro_pct}%`);
  assert.ok(!res.issues.some((i) => i.issue === "monolithic_box"));
});

test("audit_complexity scales its verdict to the target and honours min_cubes", () => {
  const { commands } = loadPlugin();
  const cubes = [];
  for (let i = 0; i < 40; i++) cubes.push({ name: `bit_${i}`, from: [i, 0, 0], to: [i + 1, 1, 1] });
  commands.add_cubes({ cubes });
  assert.equal(commands.audit_complexity({ target: "prop" }).verdict, "acceptable");
  assert.equal(commands.audit_complexity({ target: "character" }).verdict, "too_primitive");
  assert.equal(commands.audit_complexity({ target: "hero" }).verdict, "too_primitive");
  assert.equal(commands.audit_complexity({ target: "prop", min_cubes: 60 }).verdict, "too_primitive");
  assert.throws(() => commands.audit_complexity({ target: "spaceship" }), /Unknown target/);
});

test("audit_complexity defaults its budget from the rig it can see", () => {
  const { commands } = loadPlugin();
  commands.add_cubes({ cubes: [{ name: "block", from: [0, 0, 0], to: [4, 4, 4] }] });
  assert.equal(commands.audit_complexity().target, "prop", "no rig -> judged as a prop");

  commands.create_rig({ type: "humanoid", placeholder_cubes: false });
  assert.equal(commands.audit_complexity().target, "character", "a rig means a character budget");
});

test("generate_array reports z-fighting it could not avoid, and stays quiet when clean", () => {
  // Elements 2.4 wide spaced 1 apart overlap two neighbours each, so alternating
  // the depth is not enough: i and i+2 line up again.
  const dense = loadPlugin().commands.generate_array({
    mode: "linear", count: 8, element_size: [2.4, 1.6, 0.9],
    start: [-4, 12, 2.6], end: [4, 12, 2.6], distribution: "cells", depth_stagger: 0.08,
  });
  assert.ok(dense.z_fight_pairs > 0, "a triple-overlapping row should be reported");
  assert.match(dense.z_fight_hint, /jitter|element_size|rotation_range/);
  assert.ok(dense.z_fight_examples.length > 0);

  // One element per step, staggered: nothing shares a plane.
  const clean = loadPlugin().commands.generate_array({
    mode: "linear", count: 6, element_size: [2, 2, 1],
    start: [-10, 12, 2.6], end: [10, 12, 2.6], depth_stagger: 0.12,
  });
  assert.equal(clean.z_fight_pairs, undefined, "a clean row must not raise a warning");
});

test("a hollow shell and a voxelized matrix are clean by construction", () => {
  const { commands } = loadPlugin();
  const shell = commands.add_hollow_volume({ bounds: { from: [-5, 0, -5], to: [5, 10, 5] }, wall_thickness: 1 });
  assert.equal(shell.z_fight_pairs, undefined);
  const vox = loadPlugin().commands.voxelize_matrix({ matrix: ["####", "#..#", "####"] });
  assert.equal(vox.z_fight_pairs, undefined);
});

// --- add_wing ---------------------------------------------------------------

/** Stored (rest) coordinates -> where the bones actually put them, and back. */
function rotMat(deg) {
  const [x, y, z] = deg.map((d) => (d * Math.PI) / 180);
  const rx = [[1, 0, 0], [0, Math.cos(x), -Math.sin(x)], [0, Math.sin(x), Math.cos(x)]];
  const ry = [[Math.cos(y), 0, Math.sin(y)], [0, 1, 0], [-Math.sin(y), 0, Math.cos(y)]];
  const rz = [[Math.cos(z), -Math.sin(z), 0], [Math.sin(z), Math.cos(z), 0], [0, 0, 1]];
  const mul = (m, n) => m.map((row, i) => n[0].map((_, j) => row.reduce((s, _v, k) => s + m[i][k] * n[k][j], 0)));
  return mul(mul(rx, ry), rz);
}
const apply = (m, v) => m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
const transpose = (m) => m[0].map((_, i) => m.map((row) => row[i]));
function bonesAbove(node, Group) {
  const chain = [];
  for (let g = node instanceof Group ? node : node.parent; g instanceof Group; g = g.parent) chain.push(g);
  return chain; // innermost first
}
function toWorld(node, pt, Group) {
  let p = pt.slice();
  for (const g of bonesAbove(node, Group)) {
    const d = apply(rotMat(g.rotation), p.map((v, i) => v - g.origin[i]));
    p = d.map((v, i) => v + g.origin[i]);
  }
  return p;
}
function toRest(node, pt, Group) {
  let p = pt.slice();
  for (const g of bonesAbove(node, Group).reverse()) {
    const d = apply(transpose(rotMat(g.rotation)), p.map((v, i) => v - g.origin[i]));
    p = d.map((v, i) => v + g.origin[i]);
  }
  return p;
}
const near = (a, b, eps = 0.02) => a.every((v, i) => Math.abs(v - b[i]) <= eps);
const mix = (pts, w) => [0, 1, 2].map((k) => pts.reduce((s, p, i) => s + p[k] * w[i], 0));

test("add_wing builds arm -> forearm -> a finger fan, with membrane riding on its bones", () => {
  const { commands, Cube, Group } = loadPlugin();
  const res = commands.add_wing({ side: "right", base_origin: [3, 20, 2], fingers: 3 });
  const g = (n) => Group.all.find((x) => x.name === n);
  assert.deepEqual(Group.all.map((x) => x.name), [
    "wing_right_arm", "wing_right_forearm", "wing_right_finger1", "wing_right_finger2", "wing_right_finger3",
  ]);
  assert.equal(g("wing_right_forearm").parent, g("wing_right_arm"));
  for (let i = 1; i <= 3; i++) assert.equal(g(`wing_right_finger${i}`).parent, g("wing_right_forearm"));
  assert.equal(res.membrane, "cubes", "no mesh support in this format -> cube membrane");
  assert.equal(res.membrane_panels, 4);
  assert.ok(Cube.all.every((c) => c.parent instanceof Group), "nothing floats at the root");
  const membrane = Cube.all.filter((c) => /membrane/.test(c.name));
  for (const bone of ["wing_right_finger1", "wing_right_finger2", "wing_right_forearm", "wing_right_arm"]) {
    assert.ok(membrane.some((c) => c.parent === g(bone)), `a membrane panel should ride on ${bone}`);
  }
  assert.equal(res.z_fight_pairs, undefined);
  assert.equal(commands.check_model().by_type.coplanar_overlap, undefined, "a wing must not z-fight");
});

test("add_wing's bone rotations put the elbow, wrist and every tip where it reports", () => {
  const { commands, Cube, Group } = loadPlugin();
  const res = commands.add_wing({
    side: "right", base_origin: [3, 20, 2], fingers: 4, finger_length: [18, 16, 14, 12],
  });
  const forearm = Group.all.find((x) => x.name === "wing_right_forearm");
  assert.ok(near(toWorld(forearm, forearm.origin, Group), res.elbow));
  res.finger_tips.forEach((tip, i) => {
    const piece = Cube.all.find((c) => c.name === `wing_right_finger${i + 1}_tip`);
    // The far end of the tip piece, less the 0.1 it reaches past the corner.
    const end = [piece.to[0] - 0.1, (piece.from[1] + piece.to[1]) / 2, (piece.from[2] + piece.to[2]) / 2];
    assert.ok(near(toWorld(piece, end, Group), tip), `finger ${i + 1}: ${toWorld(piece, end, Group)} vs ${tip}`);
    assert.ok(Math.abs(tip[1] - 20) < 1e-6, "a horizontal wing stays in its plane");
    assert.ok(tip[0] > 3, "the right wing grows toward +X");
  });
  assert.ok(res.finger_tips[3][2] > res.finger_tips[0][2] + 5, "the fan sweeps back (+Z)");
});

test("add_wing's membrane is continuous: no hole between fingers or back to the body", () => {
  const { commands, Cube, Group } = loadPlugin();
  const res = commands.add_wing({ side: "right", base_origin: [3, 20, 2], fingers: 3, membrane_step: 0.75 });
  const membrane = Cube.all.filter((c) => /membrane/.test(c.name));
  const covered = (world) => membrane.some((c) => {
    const r = toRest(c, world, Group);
    return [0, 1, 2].every((k) => r[k] >= c.from[k] - 1e-6 && r[k] <= c.to[k] + 1e-6);
  });
  const W = res.wrist, T = res.finger_tips;
  const weights = [[0.6, 0.2, 0.2], [0.4, 0.55, 0.05], [0.4, 0.05, 0.55], [0.3, 0.35, 0.35], [0.9, 0.05, 0.05]];
  for (let i = 0; i + 1 < T.length; i++) {
    for (const w of weights) {
      const pt = mix([W, T[i], T[i + 1]], w);
      assert.ok(covered(pt), `gap between finger ${i + 1} and ${i + 2} at ${pt}`);
    }
  }
  const S = res.shoulder, E = res.elbow, A = res.membrane_attach, last = T[T.length - 1];
  for (const pt of [mix([S, E, A], [1 / 3, 1 / 3, 1 / 3]), mix([E, W, last], [1 / 3, 1 / 3, 1 / 3]),
    mix([E, A], [0.5, 0.5]), mix([W, A], [0.4, 0.6]), mix([E, last], [0.5, 0.5])]) {
    assert.ok(covered(pt), `gap in the body membrane at ${pt}`);
  }
});

test("add_wing mirrors by side and lays a vertical wing out upward", () => {
  const left = loadPlugin();
  const l = left.commands.add_wing({ side: "left", base_origin: [-3, 20, 2] });
  assert.ok(left.Group.all.every((g) => g.name.startsWith("wing_left")));
  assert.ok(l.finger_tips.every((t) => t[0] < -3), "the left wing grows toward -X");
  assert.equal(left.commands.check_model().by_type.coplanar_overlap, undefined);

  const up = loadPlugin();
  const v = up.commands.add_wing({ side: "right", base_origin: [3, 20, 2], plane: "vertical" });
  assert.ok(v.finger_tips[0][1] > 30, "the leading finger points up");
  assert.ok(v.membrane_attach[1] < 20, "the membrane hangs down to the body");
  assert.ok(v.finger_tips.every((t) => Math.abs(t[2] - 2) < 1e-6), "a vertical wing stays in its plane");
});

test("add_wing builds a double-sided mesh membrane whose corners are the finger tips", () => {
  class MeshFace { constructor(mesh, d) { this.vertices = d.vertices; } }
  class Mesh {
    constructor(d) { this.name = d.name; this.origin = d.origin; this.rotation = d.rotation; this.vertices = {}; this.faces = {}; this.n = 0; }
    addVertices(...vs) { return vs.map((v) => { const k = `v${this.n++}`; this.vertices[k] = v; return k; }); }
    addFaces(...fs) { fs.forEach((f) => { this.faces[`f${Object.keys(this.faces).length}`] = f; }); }
    init() { return this; }
    addTo(p) { this.parent = p; p.children.push(this); return this; }
  }
  const { commands, Group } = loadPlugin({ Mesh, MeshFace, Format: { id: "free", box_uv: false, meshes: true } });
  const res = commands.add_wing({ side: "right", base_origin: [3, 20, 2], fingers: 2 });
  assert.equal(res.membrane, "mesh");
  assert.equal(res.meshes.length, 3);
  const panel = Group.all.find((g) => g.name === "wing_right_finger1").children.find((c) => c instanceof Mesh);
  const corners = Object.values(panel.vertices).map((v) => toWorld(panel, v.map((x, i) => x + panel.origin[i]), Group));
  for (const tip of res.finger_tips) assert.ok(corners.some((c) => near(c, tip)), `the membrane should reach ${tip}`);
  assert.ok(corners.every((c) => Math.abs(c[1] - 20) < 0.01));
  const faces = Object.values(panel.faces);
  assert.ok(faces.length >= 4 && faces.length % 2 === 0, "each triangle is emitted with both windings");
});

test("wings get their own rig slot and drive the fly cycle instead of the arms", () => {
  const { commands, internals } = loadPlugin();
  commands.add_group({ name: "arm_right", origin: [5, 22, 0] });
  commands.add_group({ name: "arm_left", origin: [-5, 22, 0] });
  commands.add_wing({ side: "right", base_origin: [3, 24, 2] });
  commands.add_wing({ side: "left", base_origin: [-3, 24, 2] });
  const rig = internals.detectRig();
  assert.equal(rig.arms.right.upper.name, "arm_right", "a wing must not replace the arm");
  assert.equal(rig.wings.right.upper.name, "wing_right_arm");
  assert.equal(rig.wings.left.lower.name, "wing_left_forearm");
  const animated = new Set(internals.genFly(rig, internals.rigFrame(), { length: 1, power: 1 }).map((k) => k.bone));
  for (const b of ["wing_right_arm", "wing_right_forearm", "wing_right_finger1", "wing_right_finger3", "wing_left_finger2"]) {
    assert.ok(animated.has(b), `fly should animate ${b}`);
  }
  assert.ok(!animated.has("arm_right"), "the arms are not flapped when there are wings");
});

test("add_wing rejects bad input with actionable messages", () => {
  const { commands } = loadPlugin();
  assert.throws(() => commands.add_wing({ base_origin: [3, 20, 0] }), /side is required/);
  assert.throws(() => commands.add_wing({ side: "right" }), /base_origin/);
  assert.throws(() => commands.add_wing({ side: "right", base_origin: [-3, 20, 0] }), /right/i);
  assert.throws(() => commands.add_wing({ side: "right", base_origin: [3, 20, 0], fingers: 9 }), /fingers/);
  assert.throws(() => commands.add_wing({ side: "right", base_origin: [3, 20, 0], plane: "diagonal" }), /Unknown plane/);
  assert.throws(() => commands.add_wing({ side: "right", base_origin: [3, 20, 0], membrane: "mesh" }), /does not support meshes/);
  assert.throws(() => commands.add_wing({ side: "right", base_origin: [3, 20, 0], parent: "nope" }), /Parent group not found/);
});

// --- generators integrate with the rest of the plugin ----------------------

test("generated geometry parents into bones and is seen by check_model", () => {
  const { commands, Cube } = loadPlugin();
  commands.add_group({ name: "head" });
  commands.add_hollow_volume({
    bounds: { from: [-5, 24, -5], to: [5, 34, 5] },
    open_faces: ["north", "down"], name: "hood", parent: "head",
  });
  commands.generate_array({
    mode: "linear", count: 6, element_size: [2, 3, 1],
    start: [-5, 24, 4], end: [5, 24, 4], anchor: "top", depth_stagger: 0.1, parent: "head",
  });
  assert.ok(Cube.all.every((c) => c.parent && c.parent.name === "head"));
  const check = commands.check_model();
  assert.equal(check.by_type.coplanar_overlap, undefined, "generators must not create z-fighting pairs");
});

test("side-tagged generators refuse geometry on the wrong side", () => {
  const { commands } = loadPlugin();
  // The model faces -Z, so its own right is +X.
  const ok = commands.extrude_chain({ segments: 2, base_origin: [4, 20, 0], name: "horn", side: "right" });
  assert.ok(ok.sample[0].name.startsWith("horn_right"));
  assert.throws(
    () => commands.extrude_chain({ segments: 2, base_origin: [-4, 20, 0], name: "horn", side: "right" }),
    /right/i
  );
  assert.throws(
    () => commands.voxelize_matrix({ matrix: ["#"], origin: [-6, 0, 0], side: "right" }),
    /right/i
  );
});
