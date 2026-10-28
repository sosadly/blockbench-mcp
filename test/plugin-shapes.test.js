/**
 * Behaviour tests for the shape builders, placement, z-fighting, UV packing
 * and palette maths in the bridge plugin — the real code, loaded into a vm
 * with stubbed Blockbench globals (same approach as plugin-generators.test.js).
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
const source = fs.readFileSync(path.join(here, "..", "plugin", "blockbench_mcp.js"), "utf8");
const REGISTER = "Plugin.register(PLUGIN_ID, {";
assert.ok(source.includes(REGISTER), "plugin registration call moved — update this harness");
const INTERNALS = [
  "ngonBands", "cylinderCubes", "cubeWorldInfo", "pointInInfo", "findZFighting", "findHiddenCubes",
  "uvModeFor", "packUV", "colorName", "rampFor", "familiesFromClusters", "rgbToLab", "paletteLookup",
  "hexToRgb", "rgbToHsl", "nodeWorld", "xformPoint", "faceGrid", "facePaintFrame", "renderFaceFeatures",
];
const instrumented = source.replace(
  REGISTER,
  "globalThis.__MCP_COMMANDS__ = commands;\n" +
    `globalThis.__MCP_INTERNALS__ = { ${INTERNALS.join(", ")} };\n` + REGISTER
);

const FACE_DIRS = ["north", "south", "east", "west", "up", "down"];

function loadPlugin(format = {}) {
  let seq = 0;
  const uuid = (p) => `${p}-${String(++seq).padStart(5, "0")}`;
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
      if (parent && parent !== "root") { this.parent = parent; parent.children.push(this); } else this.parent = "root";
      return this;
    }
    forEachChild(fn, type) {
      const walk = (n) => n.children.forEach((c) => { if (!type || c instanceof type) fn(c); if (c.children) walk(c); });
      walk(this);
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
      this.box_uv = data.box_uv;
      this.faces = {};
      FACE_DIRS.forEach((d) => { this.faces[d] = { uv: [0, 0, 0, 0], texture: null }; });
      this.parent = "root";
      this.uuid = uuid("c");
    }
    init() { Cube.all.push(this); return this; }
    addTo(parent) {
      if (parent && parent !== "root") { this.parent = parent; parent.children.push(this); } else this.parent = "root";
      return this;
    }
    applyTexture() {}
  }
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, Buffer,
    isApp: true,
    Plugin: { register() {} },
    Blockbench: { version: "5.2.2", showQuickMessage() {} },
    Project: { name: "test", geometry_name: "test", texture_width: 64, texture_height: 64 },
    Format: Object.assign({ id: "free", box_uv: false, animation_mode: false }, format),
    Formats: {},
    Mode: { selected: { id: "edit" } },
    Texture: Object.assign([], { all: [], getDefault: () => null }),
    Animation: { all: [] },
    Undo: { initEdit() {}, finishEdit() {}, cancelEdit() {} },
    Canvas: { updateAll() {} },
    Outliner: { root: [], get elements() { return Cube.all; } },
    Group,
    Cube,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(instrumented, sandbox, { filename: "blockbench_mcp.js" });
  return { commands: sandbox.__MCP_COMMANDS__, I: sandbox.__MCP_INTERNALS__, Cube, Group, sandbox };
}

const plain = (v) => JSON.parse(JSON.stringify(v));
const dist2 = (p) => Math.hypot(p[0], p[1]);

// --- round shapes -----------------------------------------------------------

test("ngonBands cover exactly the regular polygon: no star points, no holes", () => {
  const { I } = loadPlugin();
  for (const n of [6, 8, 12, 16]) {
    const R = 5;
    const bands = plain(I.ngonBands(n, R, 0));
    assert.equal(bands.length, n / 2, `${n}-gon should take ${n / 2} bands`);
    const covered = (x, y) => bands.some((b) => {
      const t = (b.angle * Math.PI) / 180;
      const u = x * Math.cos(t) + y * Math.sin(t), v = -x * Math.sin(t) + y * Math.cos(t);
      return Math.abs(u) <= b.radial / 2 + 1e-9 && Math.abs(v) <= b.tangent / 2 + 1e-9;
    });
    // every band corner sits on the circumcircle (nothing pokes out)
    for (const b of bands) {
      assert.ok(Math.abs(Math.hypot(b.radial / 2, b.tangent / 2) - R) < 1e-6, `${n}-gon band corner off the circle`);
      assert.ok(b.angle > -45 - 1e-6 && b.angle <= 45 + 1e-6, "rotations are folded into (-45, 45]");
    }
    // everything inside the apothem is covered; nothing beyond the circumradius is
    const apo = R * Math.cos(Math.PI / n);
    for (let k = 0; k < 720; k++) {
      const a = (k / 720) * 2 * Math.PI;
      assert.ok(covered(Math.cos(a) * apo * 0.999, Math.sin(a) * apo * 0.999), `${n}-gon hole at ${a.toFixed(2)}`);
      assert.ok(!covered(Math.cos(a) * R * 1.01, Math.sin(a) * R * 1.01), `${n}-gon pokes out at ${a.toFixed(2)}`);
    }
  }
});

test("add_cylinder builds a round, flicker-free solid within its radius", () => {
  const { commands, I, Cube } = loadPlugin();
  const res = commands.add_cylinder({ center: [0, 4, 0], radius: 3, length: 6, axis: "y", sides: 12 });
  assert.equal(res.created, 6);
  assert.equal(res.z_fight_pairs, undefined);
  let maxR = 0;
  Cube.all.forEach((c) => I.cubeWorldInfo(c).corners.forEach((p) => { maxR = Math.max(maxR, Math.hypot(p[0], p[2])); }));
  assert.ok(Math.abs(maxR - 3) < 1e-3, `corners reach ${maxR}, expected 3`);
  assert.equal(I.findZFighting({}).length, 0);
});

test("add_cylinder with inner_radius is a ring of slabs", () => {
  const { commands } = loadPlugin();
  const res = commands.add_cylinder({ center: [0, 0, 0], radius: 4, inner_radius: 3, length: 1, axis: "z", sides: 12 });
  assert.equal(res.created, 12);
  assert.equal(res.solid, false);
});

test("add_gear meshes a second gear: matching tooth size, centre distance, no tooth collisions", () => {
  const { commands, I, Cube, sandbox } = loadPlugin({ animation_mode: true });
  const a = commands.add_gear({ name: "gear_a", center: [0, 10, 0], radius: 6, axis: "z" });
  const b = commands.add_gear({ name: "gear_b", radius: 3.5, axis: "z", mesh_with: { gear: "gear_a", angle: 0 } });
  assert.equal(b.mesh.with, "gear_a");
  const reg = sandbox.Project.mcp_gears;
  const d = Math.hypot(reg.gear_b.center[0] - reg.gear_a.center[0], reg.gear_b.center[1] - reg.gear_a.center[1]);
  assert.ok(Math.abs(d - (reg.gear_a.pitch_radius + reg.gear_b.pitch_radius + 0.15)) < 1e-6);
  assert.equal(b.teeth, Math.round((a.teeth * reg.gear_b.pitch_radius) / reg.gear_a.pitch_radius));
  // No tooth of B may sit inside a tooth of A.
  const teethA = Cube.all.filter((c) => /^gear_a_tooth/.test(c.name)).map(I.cubeWorldInfo);
  const teethB = Cube.all.filter((c) => /^gear_b_tooth/.test(c.name)).map(I.cubeWorldInfo);
  for (const tb of teethB) {
    const c = tb.corners.reduce((s, p) => [s[0] + p[0] / 8, s[1] + p[1] / 8, s[2] + p[2] / 8], [0, 0, 0]);
    assert.ok(!teethA.some((ta) => I.pointInInfo(ta, c, 0)), `${tb.cube.name} collides with gear_a`);
  }
  assert.throws(() => commands.add_gear({ name: "gear_a", radius: 3 }), /already exists/);
  assert.throws(() => commands.add_gear({ name: "g3", mesh_with: { gear: "nope" } }), /Known gears: gear_a, gear_b/);
});

test("add_pipe builds segments plus fittings and flanges", () => {
  const { commands, Cube } = loadPlugin();
  const res = commands.add_pipe({ points: [[0, 0, 0], [0, 8, 0], [6, 8, 0]], radius: 1, sides: 8 });
  assert.equal(res.segments, 2);
  assert.ok(Cube.all.some((c) => /flange_start/.test(c.name)) && Cube.all.some((c) => /joint1/.test(c.name)));
  assert.throws(() => commands.add_pipe({ points: [[0, 0, 0]] }), /at least two/);
});

test("add_flare turns every panel outward and hangs from the top ring", () => {
  const { commands, I, Cube } = loadPlugin();
  const res = commands.add_flare({ name: "skirt", center: [0, 12, 0], top_radius: 3, bottom_radius: 5, height: 4, segments: 12, pleat: 0.2 });
  assert.equal(res.created, 12);
  for (const c of Cube.all) {
    const w = I.cubeWorldInfo(c);
    const north = w.faces.find((f) => f.dir === "south").normal; // local +Z = outward
    const mid = w.corners.reduce((s, p) => [s[0] + p[0] / 8, s[1] + p[1] / 8, s[2] + p[2] / 8], [0, 0, 0]);
    const radial = [mid[0], 0, mid[2]];
    const len = Math.hypot(radial[0], radial[2]);
    const dot = (north[0] * radial[0] + north[2] * radial[2]) / len;
    assert.ok(dot > 0.85, `${c.name} faces ${dot.toFixed(2)} outward`);
    assert.ok(w.max[1] <= 12.5 && w.min[1] >= 7.5, `${c.name} is outside the skirt's height`);
  }
});

test("add_hair builds cap, bangs in front of the face and tail bone chains with ribbons", () => {
  const { commands, Cube, Group } = loadPlugin({ animation_mode: true });
  commands.add_groups({ groups: [{ name: "head_bone", origin: [0, 20, 0] }] });
  commands.add_cubes({ cubes: [{ name: "head", from: [-4, 20, -4], to: [4, 28, 4], parent: "head_bone" }] });
  const res = commands.add_hair({ head: "head", style: "twin_tails", tails: [{ side: "right", ribbon: "bow" }, { side: "left" }] });
  assert.equal(res.z_fight_pairs, undefined, "hair should come out flicker-free");
  const bangs = Cube.all.filter((c) => /^hair_bang/.test(c.name));
  assert.ok(bangs.length >= 3);
  assert.ok(bangs.every((c) => c.from[2] < -4), "bangs hang in front of the face (-Z)");
  assert.ok(Group.all.some((g) => g.name.startsWith("hair_tail_right")) && Group.all.some((g) => g.name.startsWith("hair_tail_left")));
  assert.ok(Cube.all.some((c) => c.name === "ribbon_right_bow_a"));
  assert.throws(() => commands.add_hair({ head: "nohead" }), /no cube "nohead"/);
});

test("twin tails with extra strands are mirror twins", () => {
  const { commands, Cube } = loadPlugin({ animation_mode: true });
  commands.add_groups({ groups: [{ name: "head_bone", origin: [0, 20, 0] }] });
  commands.add_cubes({ cubes: [{ name: "head", from: [-4, 20, -4], to: [4, 28, 4], parent: "head_bone" }] });
  const tail = { height: "high", direction: "up", length: 6, size: 2.4, segments: 3, strands: 5, ribbon: "bow" };
  commands.add_hair({ head: "head", style: "twin_tails", tails: [{ ...tail, side: "right" }, { ...tail, side: "left" }] });
  const right = Cube.all.filter((c) => /^hair_tail_right/.test(c.name));
  assert.ok(right.filter((c) => /_lock/.test(c.name)).length >= 8, "4 extra locks per tail");
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
  for (const r of right) {
    const l = Cube.all.find((c) => c.name === r.name.replace("_right", "_left"));
    assert.ok(l, `${r.name} has a twin`);
    assert.ok(near(l.from, [-r.to[0], r.from[1], r.from[2]]) && near(l.to, [-r.from[0], r.to[1], r.to[2]]), `${r.name} box is mirrored`);
    const rot = r.rotation || [0, 0, 0];
    assert.ok(near(l.rotation || [0, 0, 0], [rot[0], -rot[1], -rot[2]]), `${r.name} rotation ${rot} is mirrored, got ${l.rotation}`);
  }
});

// --- placement ----------------------------------------------------------------

test("attach puts a part flush on a rotated cube's face, and mirror builds the twin", () => {
  const { commands, I, Cube } = loadPlugin();
  commands.add_cubes({ cubes: [{ name: "plate", from: [-2, 0, -1], to: [2, 4, 1], origin: [0, 2, 0], rotation: [0, 30, 0] }] });
  commands.add_cubes({ cubes: [{ name: "stud", size: [1, 1, 0.5], attach: { to: "plate", face: "front", at: [0, 0] } }] });
  const plate = I.cubeWorldInfo(Cube.all.find((c) => c.name === "plate"));
  const stud = I.cubeWorldInfo(Cube.all.find((c) => c.name === "stud"));
  const front = plate.faces.find((f) => f.dir === "north");
  const sBack = stud.faces.find((f) => f.dir === "south");
  // The stud's back face lies in the plate's front plane.
  const n = front.normal;
  const planeD = (p) => n[0] * p[0] + n[1] * p[1] + n[2] * p[2];
  // (positions are rounded to 0.001, so allow that much)
  const gap = Math.abs(planeD(sBack.poly[0]) - planeD(front.poly[0]));
  assert.ok(gap < 2e-3, `stud floats ${gap} off the plate`);
  assert.ok(Math.abs(sBack.normal[0] + n[0]) < 1e-3 && Math.abs(sBack.normal[2] + n[2]) < 1e-3, "stud is turned with the plate");
  commands.add_cubes({ cubes: [{ name: "pauldron", center: [5, 10, 0], size: [2, 1, 2], mirror: true }] });
  const r = Cube.all.find((c) => c.name === "pauldron_right"), l = Cube.all.find((c) => c.name === "pauldron_left");
  assert.ok(r && l, "mirror creates _right and _left");
  assert.equal(r.from[0], -l.to[0]);
});

// --- z-fighting ------------------------------------------------------------------

test("fix_z_fighting settles a dense cluster instead of oscillating", () => {
  const { commands } = loadPlugin();
  const cubes = [];
  for (let i = 0; i < 6; i++) cubes.push({ name: `slat${i}`, from: [i * 0.5, 0, 0], to: [i * 0.5 + 1, 1, 1] });
  commands.add_cubes({ cubes, fix_z_fighting: false });
  const res = commands.fix_z_fighting({});
  assert.ok(res.found > 0);
  assert.equal(res.remaining, 0, JSON.stringify(res.remaining_examples));
});

test("check_model flags a cube buried inside another as hidden", () => {
  const { commands } = loadPlugin();
  commands.add_cubes({ cubes: [{ name: "body", from: [-3, 0, -2], to: [3, 8, 2] }, { name: "buried", from: [-1, 2, -1], to: [1, 4, 1] }] });
  const res = commands.check_model();
  const hidden = res.issues.find((i) => i.issue === "hidden_cube");
  assert.ok(hidden && hidden.cube === "buried" && hidden.inside === "body");
});

// --- UV packing ----------------------------------------------------------------

test("pack_uv keeps box UV for whole cubes and gives thin/off-grid cubes whole-pixel per-face UV", () => {
  const { commands, Cube } = loadPlugin({ id: "bedrock", box_uv: true, optional_box_uv: true });
  commands.add_cubes({ cubes: [
    { name: "block", from: [0, 0, 0], to: [4, 4, 4] },
    { name: "tooth", from: [6, 0, 0], to: [6.6, 1.3, 2] },
  ] });
  const res = commands.pack_uv({});
  assert.equal(res.box_uv, 1);
  assert.equal(res.per_face_uv, 1);
  const tooth = Cube.all.find((c) => c.name === "tooth");
  assert.equal(tooth.box_uv, false);
  for (const d of FACE_DIRS) {
    const u = tooth.faces[d].uv;
    assert.ok(u[2] - u[0] >= 1 && u[3] - u[1] >= 1, `${d} face got ${JSON.stringify(u)}`);
    assert.ok(Number.isInteger(u[2] - u[0]) && Number.isInteger(u[3] - u[1]), "whole pixels");
  }
  // No two faces share pixels.
  const rects = [];
  Cube.all.filter((c) => !c.box_uv).forEach((c) => FACE_DIRS.forEach((d) => rects.push(c.faces[d].uv)));
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const a = rects[i], b = rects[j];
    const overlap = Math.min(a[2], b[2]) > Math.max(a[0], b[0]) && Math.min(a[3], b[3]) > Math.max(a[1], b[1]);
    assert.ok(!overlap, "per-face rects overlap");
  }
});

test("pack_uv never switches cubes away from box UV in a box-only format", () => {
  const { commands } = loadPlugin({ id: "modded_entity", box_uv: true, optional_box_uv: false });
  commands.add_cubes({ cubes: [{ name: "thin", from: [0, 0, 0], to: [0.5, 2, 2] }] });
  const res = commands.pack_uv({});
  assert.equal(res.per_face_uv, 0);
  assert.match(res.warning, /thinner than 1 unit/);
});

// --- palette ----------------------------------------------------------------------

test("make_palette from a text brief stores ramps usable as $key colours", async () => {
  const { commands, I } = loadPlugin();
  const res = await commands.make_palette({ colors: { hair: "#5b6bd6", skin: "#f6d6c4" } });
  const hair = res.palette.find((e) => e.key === "hair");
  assert.equal(hair.ramp.length, 5);
  assert.equal(hair.ramp[2], "#5b6bd6");
  const L = hair.ramp.map((h) => I.rgbToHsl(...I.hexToRgb(h)).l);
  for (let k = 1; k < 5; k++) assert.ok(L[k] > L[k - 1], "ramp goes dark -> light");
  assert.deepEqual(plain(I.hexToRgb("$hair.light")), plain(I.hexToRgb(hair.ramp[3])));
  assert.equal(res.palette.find((e) => e.key === "skin").name, "skin");
  assert.throws(() => I.hexToRgb("$nope"), /Palette keys: hair, skin/);
});

test("make_palette builds a harmony for a text-only brief", async () => {
  const { commands } = loadPlugin();
  const res = await commands.make_palette({ base_color: "#2a6f97", scheme: "triadic", mood: "vibrant" });
  assert.deepEqual(plain(res.palette.map((e) => e.key)), ["main", "secondary", "accent1", "dark_neutral", "light_neutral"]);
});

test("colour families merge light and shadow of one material, keep different hues apart", () => {
  const { I } = loadPlugin();
  const mk = (hex, share) => { const rgb = I.hexToRgb(hex); return { rgb, lab: I.rgbToLab(rgb), share }; };
  const fams = plain(I.familiesFromClusters([mk("#5b6bd6", 0.3), mk("#3a468f", 0.2), mk("#8f9cf0", 0.1), mk("#b3262d", 0.25)], 8));
  assert.equal(fams.length, 2);
  assert.equal(fams[0].observed.length, 3);
  assert.match(I.colorName(I.hexToRgb("#b3262d")), /red/);
  assert.equal(I.colorName(I.hexToRgb("#f6d6c4")), "skin");
});

// --- faces --------------------------------------------------------------------

test("a face on a head tilted by its bone stays on the pixel grid (eyes not crooked)", () => {
  const { I, Cube, Group } = loadPlugin();
  const neck = new Group({ name: "neck", origin: [0, 32, 0], rotation: [-4, 0, 0] }).init().addTo("root");
  const headBone = new Group({ name: "head", origin: [0, 34.3, 0], rotation: [-9, 3, -6] }).init().addTo(neck);
  const head = new Cube({ name: "head", from: [-4, 34.4, -3.8], to: [4, 42.4, 3.6] }).init().addTo(headBone);
  head.faces.north.uv = [0, 0, 8, 8];
  const scale = 4;
  const X = I.nodeWorld(head);
  const frame = I.facePaintFrame(head, "north", head.faces.north, scale, X);
  const { cells, Wf, Hf } = I.faceGrid(frame, X, scale);
  assert.equal(Wf, 32, "face grid width = the face's pixels, no resampling");
  assert.equal(Hf, 32);
  const seen = new Set(cells.map((c) => `${c[2]},${c[3]}`));
  assert.equal(seen.size, 32 * 32, "every texture pixel maps to its own face cell");
  // seen from the front the image is mirrored: the face's x runs from the model's right (+x) to its left
  const leftmost = cells.find((c) => c[2] === 0 && c[3] === 0);
  assert.equal(leftmost[0], 0, "the face's top-left cell is the texture rect's top-left pixel");
});

test("anime eyes are mirror images at the same height", () => {
  const { I } = loadPlugin();
  for (const expression of ["neutral", "shy", "sad", "angry", "surprised"]) {
    const { grid } = I.renderFaceFeatures(32, 32, {
      style: "anime", expression, eye_width: 8, eye_height: 9, eye_gap: 6, eye_y: 15, blush: true, nose: "none", mouth: "none",
      skin_rgb: [240, 210, 195],
    });
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 16; x++) {
        const a = grid[y] && grid[y][x], b = grid[y] && grid[y][31 - x];
        assert.deepEqual(plain(a || null), plain(b || null), `${expression}: pixel (${x},${y}) differs from its mirror`);
      }
    }
  }
});
