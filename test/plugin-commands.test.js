/**
 * Behaviour tests for the bridge's element and texture commands: meshes,
 * batches, and where things end up after they are created.
 *
 * Like plugin-generators.test.js, the plugin runs in a vm context with stubbed
 * Blockbench globals, so these exercise the handlers that actually ship. The
 * stubs copy the Blockbench behaviour the handlers depend on — most of all
 * that `new Mesh(data)` seeds a default 4x4x4 cube unless `data.vertices` is
 * given, and that mesh vertices are stored relative to the mesh's origin.
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

const REGISTER = "Plugin.register(PLUGIN_ID, {";
assert.ok(source.includes(REGISTER), "plugin registration call moved — update this harness");
const instrumented = source.replace(REGISTER, "globalThis.__MCP_COMMANDS__ = commands;\n" + REGISTER);

/** A fresh, empty Blockbench-ish world plus the plugin's command table. */
function loadPlugin(overrides = {}) {
  let seq = 0;
  const uuid = (p) => `${p}-${++seq}`;
  const elements = [];
  const root = [];
  const attach = (node, parent) => {
    if (parent && parent !== "root") { node.parent = parent; parent.children.push(node); }
    else { node.parent = "root"; root.push(node); }
    return node;
  };

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
    addTo(parent) { return attach(this, parent); }
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
      this.faces = {};
      this.parent = "root";
      this.uuid = uuid("c");
    }
    init() { Cube.all.push(this); elements.push(this); return this; }
    addTo(parent) { return attach(this, parent); }
    applyTexture() {}
  }

  class MeshFace {
    constructor(mesh, data = {}) {
      this.vertices = (data.vertices || []).slice();
      this.uv = {};
      this.texture = null;
    }
  }

  class Mesh {
    static all = [];
    constructor(data = {}) {
      this.vertices = {};
      this.faces = {};
      this.nextKey = 0;
      // What Blockbench's constructor does when it is handed no vertices.
      if (!data.vertices) {
        const k = this.addVertices(
          [2, 4, 2], [2, 4, -2], [2, 0, 2], [2, 0, -2], [-2, 4, 2], [-2, 4, -2], [-2, 0, 2], [-2, 0, -2]
        );
        for (const f of [[0, 2, 1, 3], [4, 5, 6, 7], [0, 1, 4, 5], [2, 6, 3, 7], [0, 4, 2, 6], [1, 3, 5, 7]]) {
          this.addFaces(new MeshFace(this, { vertices: f.map((i) => k[i]) }));
        }
      }
      this.name = data.name || "mesh";
      this.origin = (data.origin || [0, 0, 0]).slice();
      this.rotation = (data.rotation || [0, 0, 0]).slice();
      this.parent = "root";
      this.uuid = uuid("m");
    }
    // Blockbench: the origin is where a mesh sits, and `position` only reads it.
    get position() { return this.origin; }
    addVertices(...vs) {
      return vs.map((v) => { const k = `v${this.nextKey++}`; this.vertices[k] = v.slice(); return k; });
    }
    addFaces(...fs) {
      return fs.map((f) => { const k = `f${this.nextKey++}`; this.faces[k] = f; return k; });
    }
    init() { Mesh.all.push(this); elements.push(this); return this; }
    addTo(parent) { return attach(this, parent); }
  }

  class Locator {
    constructor(data = {}) {
      this.name = data.name || "locator";
      this.position = (data.position || [0, 0, 0]).slice();
      this.rotation = [0, 0, 0];
      this.parent = "root";
      this.uuid = uuid("l");
    }
    // Blockbench (Locator, NullObject, Billboard): the position is stored, and
    // `origin` is a getter with no setter that returns it.
    get origin() { return this.position; }
    init() { elements.push(this); return this; }
    addTo(parent) { return attach(this, parent); }
  }

  // Built like Blockbench 5's BoundingBox: from/to are accessors with setters,
  // while origin and position are getters with no setter returning a fresh [0,0,0].
  class BoundingBox {
    constructor(data = {}) {
      this._static = { properties: { from: (data.from || [0, 0, 0]).slice(), to: (data.to || [1, 1, 1]).slice() } };
      this.name = data.name || "bounding_box";
      this.type = "bounding_box";
      this.parent = "root";
      this.uuid = uuid("b");
    }
    get from() { return this._static.properties.from; }
    set from(v) { this._static.properties.from = v; }
    get to() { return this._static.properties.to; }
    set to(v) { this._static.properties.to = v; }
    get origin() { return [0, 0, 0]; }
    get position() { return [0, 0, 0]; }
    init() { elements.push(this); return this; }
    addTo(parent) { return attach(this, parent); }
  }

  class Texture {
    static all = [];
    static getDefault() { return null; }
    constructor(data = {}) {
      this.name = data.name;
      this.width = data.width;
      this.height = data.height;
      this.uuid = data.uuid || uuid("t");
    }
    fromDataURL(url) { this.source = url; return this; }
    add() { Texture.all.push(this); return this; }
    enableParticle() { this.particle = true; }
  }
  Texture.all.push(new Texture({ uuid: "t-metal", name: "metal" }));

  /** A canvas that remembers its size and fill in the data URL it hands back. */
  const document = {
    createElement() {
      const canvas = {
        width: 0,
        height: 0,
        fill: null,
        getContext: () => ({ set fillStyle(v) { canvas.fill = v; }, fillRect() {} }),
        toDataURL: () => `data:test;${canvas.width}x${canvas.height};${canvas.fill}`,
      };
      return canvas;
    },
  };

  /** Records every edit, so a test can check what Undo was told. */
  const Undo = {
    edits: [],
    initEdit(aspects) { this.edits.push({ aspects }); },
    finishEdit(message, after) {
      const edit = this.edits[this.edits.length - 1];
      edit.message = message;
      edit.after = after;
    },
  };

  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Buffer,
    isApp: true,
    Plugin: { register() {} },
    Blockbench: { version: "5.1.4", showQuickMessage() {} },
    Project: { name: "test", geometry_name: "test", texture_width: 64, texture_height: 64 },
    Format: { id: "free", box_uv: false, animation_mode: false, meshes: true },
    Formats: {},
    Mode: { selected: { id: "edit" } },
    Texture,
    document,
    Animation: { all: [] },
    Undo,
    Canvas: { updateAll() {} },
    Outliner: { root, elements },
    Group,
    Cube,
    Mesh,
    MeshFace,
    Locator,
    ...overrides,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(instrumented, sandbox, { filename: "blockbench_mcp.js" });
  return { commands: sandbox.__MCP_COMMANDS__, Group, Cube, Mesh, Locator, BoundingBox, Texture, Undo, sandbox };
}

/** Values made inside the vm carry that realm's prototypes; compare them by value. */
const plain = (v) => JSON.parse(JSON.stringify(v));

/** A mesh's vertices in model space: stored relative to the origin, so add it back. */
const worldVertices = (mesh) => Object.values(mesh.vertices).map((v) => v.map((x, i) => x + mesh.origin[i]));

function worldBounds(mesh) {
  const pts = worldVertices(mesh);
  return {
    from: [0, 1, 2].map((i) => Math.min(...pts.map((p) => p[i]))),
    to: [0, 1, 2].map((i) => Math.max(...pts.map((p) => p[i]))),
  };
}

// --- add_mesh ---------------------------------------------------------------

test("add_mesh builds only the requested shape, not Blockbench's default cube as well", () => {
  const { commands, Mesh } = loadPlugin();
  const res = commands.add_mesh({ shape: "pyramid", texture: "metal" });
  const mesh = Mesh.all[0];
  // A pyramid is 5 vertices and 5 faces; the default cube would add 8 and 6.
  assert.equal(Object.keys(mesh.vertices).length, 5);
  assert.equal(Object.keys(mesh.faces).length, 5);
  assert.equal(res.vertices, 5);
  assert.equal(res.faces, 5);
  assert.ok(Object.values(mesh.faces).every((f) => f.texture === "t-metal"), "every face carries the texture");
});

test("add_mesh puts the shape at from..from+size, and origin only sets the pivot", () => {
  const from = [10, 2, -6];
  const size = [4, 6, 2];
  for (const origin of [undefined, [1, 1, 1], [-20, 5, 30]]) {
    const { commands, Mesh } = loadPlugin();
    commands.add_mesh({ shape: "crystal", from, size, origin });
    const mesh = Mesh.all[0];
    const b = worldBounds(mesh);
    assert.deepEqual(b.from, from, `origin ${origin}: shape starts at ${b.from}`);
    assert.deepEqual(b.to, [14, 8, -4], `origin ${origin}: shape ends at ${b.to}`);
    assert.deepEqual(plain(mesh.origin), origin || [12, 5, -5], "the pivot defaults to the shape's centre");
  }
});

test("add_mesh hands Undo the new mesh, so undoing it removes the mesh", () => {
  const { commands, Mesh, Undo } = loadPlugin();
  commands.add_mesh({ shape: "cone", segments: 6 });
  assert.equal(Undo.edits.length, 1);
  const { after } = Undo.edits[0];
  assert.ok(after, "finishEdit needs the after-state");
  assert.equal(after.outliner, true);
  assert.equal(after.elements.length, 1);
  assert.equal(after.elements[0], Mesh.all[0]);
});

test("add_mesh refuses an unknown parent, texture or shape before creating anything", () => {
  const { commands, Mesh, Undo } = loadPlugin();
  assert.throws(() => commands.add_mesh({ parent: "nope" }), /Parent group not found: nope/);
  assert.throws(() => commands.add_mesh({ texture: "nope" }), /Texture not found: nope/);
  assert.throws(() => commands.add_mesh({ shape: "blob" }), /Unknown mesh shape/);
  assert.equal(Mesh.all.length, 0);
  assert.equal(Undo.edits.length, 0, "no edit is opened for a spec that fails");
});

test("add_mesh refuses a format without meshes", () => {
  const { commands } = loadPlugin({ Format: { id: "java_block", box_uv: false, meshes: false } });
  assert.throws(() => commands.add_mesh({}), /does not support meshes/);
});

// --- add_meshes -------------------------------------------------------------

test("add_meshes builds every mesh in one undo step, each where its spec says", () => {
  const { commands, Mesh, Group, Undo } = loadPlugin();
  commands.add_group({ name: "crown" });
  const res = commands.add_meshes({
    meshes: [
      { name: "gem_a", shape: "gem", from: [0, 10, 0], size: [2, 3, 2], parent: "crown" },
      { name: "spike", shape: "cone", segments: 5, from: [-4, 0, -4], size: [2, 6, 2], texture: "metal" },
      { name: "blade", shape: "wedge", from: [5, 1, 1], size: [1, 8, 2], origin: [0, 0, 0] },
    ],
  });
  assert.equal(res.created, 3);
  assert.deepEqual(plain(res.meshes.map((m) => m.name)), ["gem_a", "spike", "blade"]);
  assert.deepEqual(plain(res.meshes.map((m) => m.shape)), ["gem", "cone", "wedge"]);
  assert.equal(Mesh.all.length, 3);
  assert.equal(Mesh.all[0].parent, Group.all[0], "parented into the named group");

  assert.deepEqual(worldBounds(Mesh.all[0]), { from: [0, 10, 0], to: [2, 13, 2] });
  assert.deepEqual(worldBounds(Mesh.all[2]), { from: [5, 1, 1], to: [6, 9, 3] });
  // A cone's ring never reaches every corner, but its apex and base do reach the box's top and bottom.
  const spike = worldBounds(Mesh.all[1]);
  assert.equal(spike.from[1], 0);
  assert.equal(spike.to[1], 6);
  assert.equal(Object.keys(Mesh.all[1].vertices).length, 5 + 2, "5 ring vertices, an apex and a centre");

  const meshEdits = Undo.edits.filter((e) => e.message === "MCP: add meshes");
  assert.equal(meshEdits.length, 1, "one undo step for the whole batch");
  assert.equal(meshEdits[0].after.elements.length, 3);
  assert.ok(Mesh.all.every((m) => meshEdits[0].after.elements.includes(m)));
});

test("add_meshes checks every item before creating any of them", () => {
  const { commands, Mesh, Undo } = loadPlugin();
  const good = { shape: "crystal" };
  assert.throws(
    () => commands.add_meshes({ meshes: [good, { parent: "nope" }, good] }),
    /meshes\[1\]: Parent group not found: nope/
  );
  assert.throws(() => commands.add_meshes({ meshes: [good, good, { texture: "nope" }] }), /meshes\[2\]: Texture not found/);
  assert.throws(() => commands.add_meshes({ meshes: [{ shape: "blob" }] }), /meshes\[0\]: Unknown mesh shape/);
  assert.throws(() => commands.add_meshes({ meshes: [good, "crystal"] }), /meshes\[1\] must be an object/);
  assert.throws(() => commands.add_meshes({ meshes: [good, [1, 2, 3]] }), /meshes\[1\] must be an object/);
  assert.equal(Mesh.all.length, 0, "nothing is built when any item is bad");
  assert.equal(Undo.edits.length, 0, "and no edit is opened");
});

test("add_meshes caps the batch size and the segment count, and wants a whole number of segments", () => {
  const { commands, Mesh, Undo } = loadPlugin();
  assert.throws(() => commands.add_meshes({}), /non-empty array/);
  assert.throws(() => commands.add_meshes({ meshes: [] }), /non-empty array/);
  const tooMany = Array.from({ length: 201 }, () => ({ shape: "plane" }));
  assert.throws(() => commands.add_meshes({ meshes: tooMany }), /At most 200 meshes per call \(got 201\)/);
  assert.throws(
    () => commands.add_meshes({ meshes: [{ shape: "cylinder", segments: 129 }] }),
    /meshes\[0\]: segments must be a whole number, at most 128/
  );
  assert.throws(() => commands.add_mesh({ shape: "cylinder", segments: 5000 }), /segments must be a whole number, at most 128/);
  assert.throws(() => commands.add_mesh({ shape: "cone", segments: "lots" }), /segments must be a whole number, at most 128/);
  // A fractional count used to fail half-way through building, after the first mesh was made.
  assert.throws(
    () => commands.add_meshes({ meshes: [{ shape: "crystal" }, { shape: "cone", segments: 3.5 }] }),
    /meshes\[1\]: segments must be a whole number/
  );
  assert.throws(() => commands.add_mesh({ shape: "cylinder", segments: 6.5 }), /segments must be a whole number/);
  assert.equal(Mesh.all.length, 0);
  assert.equal(Undo.edits.length, 0, "no edit is opened for a refused count");

  assert.equal(commands.add_meshes({ meshes: Array.from({ length: 200 }, () => ({ shape: "plane" })) }).created, 200);
  assert.equal(commands.add_mesh({ shape: "cylinder", segments: 128 }).vertices, 2 * 128 + 2);
});

test("add_meshes accepts a JSON-string list or a single spec", () => {
  const { commands, Mesh } = loadPlugin();
  assert.equal(commands.add_meshes({ meshes: '[{"shape":"plane"},{"shape":"pyramid"}]' }).created, 2);
  assert.equal(commands.add_meshes({ meshes: { shape: "prism" } }).created, 1);
  assert.equal(Mesh.all.length, 3);
});

// --- create_textures --------------------------------------------------------

test("create_textures makes each solid texture in order, at the project size unless told", async () => {
  const { commands, Texture } = loadPlugin();
  const res = await commands.create_textures({
    textures: [
      { name: "dark_metal", fill: "#8a8f99" },
      { name: "glow", fill: "#66ccff", width: 16, height: 32 },
      // Items are untyped, so a client may send a size as text; it still arrives as a number.
      { name: "trim", fill: "#ff0000", width: "32", height: "8" },
    ],
  });
  assert.equal(res.created, 3);
  assert.deepEqual(plain(res.textures.map((t) => t.name)), ["dark_metal", "glow", "trim"]);
  assert.deepEqual(plain(res.textures.map((t) => [t.width, t.height])), [[64, 64], [16, 32], [32, 8]]);
  const [darkMetal, glow, trim] = Texture.all.slice(1);
  assert.equal(darkMetal.source, "data:test;64x64;#8a8f99");
  assert.equal(glow.source, "data:test;16x32;#66ccff");
  assert.equal(trim.source, "data:test;32x8;#ff0000");
  assert.equal(typeof trim.width, "number");
  assert.equal(typeof trim.height, "number");
  assert.equal(res.textures[0].uuid, darkMetal.uuid);
});

test("create_textures refuses a data_url or a bad size before making anything", async () => {
  const { commands, Texture } = loadPlugin();
  const ok = { name: "metal", fill: "#888888" };
  await assert.rejects(
    commands.create_textures({ textures: [ok, { name: "img", data_url: "data:image/png;base64,AAAA" }] }),
    /textures\[1\]: create_textures takes solid fills only/
  );
  await assert.rejects(
    commands.create_textures({ textures: [{ width: 5000 }] }),
    /textures\[0\]\.width must be a whole number 1\.\.4096/
  );
  await assert.rejects(
    commands.create_textures({ textures: [ok, { height: 0 }] }),
    /textures\[1\]\.height must be a whole number 1\.\.4096/
  );
  await assert.rejects(commands.create_textures({ textures: [{ width: "wide" }] }), /width must be a whole number/);
  await assert.rejects(commands.create_textures({ textures: [ok, { width: 16.5 }] }), /textures\[1\]\.width must be a whole number/);
  await assert.rejects(commands.create_textures({ textures: [ok, "#ff0000"] }), /textures\[1\] must be an object/);
  await assert.rejects(commands.create_textures({ textures: [] }), /non-empty array/);
  await assert.rejects(commands.create_textures({}), /non-empty array/);
  const tooMany = Array.from({ length: 65 }, (_, i) => ({ name: `t${i}`, fill: "#000000" }));
  await assert.rejects(commands.create_textures({ textures: tooMany }), /At most 64 textures per call \(got 65\)/);
  assert.equal(Texture.all.length, 1, "only the texture the world started with");
});

test("create_textures accepts a JSON-string list", async () => {
  const { commands, Texture } = loadPlugin();
  const res = await commands.create_textures({ textures: '[{"name":"a","fill":"#111111"},{"name":"b"}]' });
  assert.equal(res.created, 2);
  assert.equal(Texture.all.length, 3);
});

// --- edit_element: offset ----------------------------------------------------

test("edit_element offset moves a cube's from, to and origin together", () => {
  const { commands, Cube, Undo } = loadPlugin();
  commands.add_cube({ name: "plate", from: [0, 0, 0], to: [2, 1, 4], origin: [1, 0, 2] });
  commands.edit_element({ element: "plate", offset: [3, -1, 0.5] });
  const plate = Cube.all[0];
  assert.deepEqual(plain(plate.from), [3, -1, 0.5]);
  assert.deepEqual(plain(plate.to), [5, 0, 4.5]);
  assert.deepEqual(plain(plate.origin), [4, -1, 2.5]);
  const edit = Undo.edits[Undo.edits.length - 1];
  assert.equal(edit.aspects.elements.length, 1);
  assert.equal(edit.aspects.elements[0], plate);
});

test("edit_element offset moves a mesh by its origin and leaves its vertices alone", () => {
  const { commands, Mesh } = loadPlugin();
  commands.add_mesh({ name: "gem", shape: "gem", from: [0, 0, 0], size: [2, 2, 2] });
  const gem = Mesh.all[0];
  const before = plain(gem.vertices);
  commands.edit_element({ element: "gem", offset: [5, 0, -1] });
  assert.deepEqual(plain(gem.origin), [6, 1, 0]);
  assert.deepEqual(plain(gem.vertices), before, "vertices are relative to the origin, so they stay put");
  assert.deepEqual(worldBounds(gem), { from: [5, 0, -1], to: [7, 2, 1] });
});

test("edit_element offset moves a locator by its position, not through its origin getter", () => {
  const { commands, Locator } = loadPlugin();
  const muzzle = new Locator({ name: "muzzle", position: [1, 2, 3] }).init();
  commands.edit_element({ element: "muzzle", offset: [0, 0, -4] });
  assert.deepEqual(plain(muzzle.position), [1, 2, -1]);
});

test("edit_element offset on a group moves everything inside it, and Undo snapshots all of it", () => {
  const { commands, Group, Cube, Mesh, Locator, Undo } = loadPlugin();
  commands.add_group({ name: "arm", origin: [4, 20, 0] });
  commands.add_group({ name: "forearm", origin: [4, 14, 0], parent: "arm" });
  commands.add_cube({ name: "bracer", from: [3, 10, -1], to: [5, 14, 1], origin: [4, 14, 0], parent: "forearm" });
  commands.add_mesh({ name: "spike", shape: "cone", from: [5, 18, 0], size: [1, 2, 1], parent: "arm" });
  const [arm, forearm] = Group.all;
  const hand = new Locator({ name: "hand", position: [4, 9, 0] }).init().addTo(forearm);
  const spike = Mesh.all[0];
  const spikeBefore = worldBounds(spike);

  commands.edit_element({ element: "arm", offset: [0, -2, 1] });

  assert.deepEqual(plain(arm.origin), [4, 18, 1]);
  assert.deepEqual(plain(forearm.origin), [4, 12, 1], "a sub-group moves once, not once per level");
  assert.deepEqual(plain(Cube.all[0].from), [3, 8, 0]);
  assert.deepEqual(plain(Cube.all[0].to), [5, 12, 2]);
  assert.deepEqual(plain(Cube.all[0].origin), [4, 12, 1]);
  assert.deepEqual(worldBounds(spike), {
    from: spikeBefore.from.map((v, i) => v + [0, -2, 1][i]),
    to: spikeBefore.to.map((v, i) => v + [0, -2, 1][i]),
  });
  assert.deepEqual(plain(hand.position), [4, 7, 1]);

  const { aspects } = Undo.edits[Undo.edits.length - 1];
  assert.equal(aspects.groups.length, 2);
  assert.ok(aspects.groups.includes(arm) && aspects.groups.includes(forearm), "both groups are snapshotted");
  assert.equal(aspects.elements.length, 3);
  for (const el of [Cube.all[0], spike, hand]) assert.ok(aspects.elements.includes(el), `${el.name} is snapshotted`);

  // Without an offset a group edit touches only the group, so that is all Undo needs.
  commands.edit_element({ element: "arm", new_name: "upper_arm" });
  const rename = Undo.edits[Undo.edits.length - 1].aspects;
  assert.equal(rename.group, arm);
  assert.equal(rename.elements, undefined);
});

test("edit_element refuses from/to/inflate where they would do nothing, before changing anything", () => {
  const { commands, Cube, Mesh, Undo } = loadPlugin();
  commands.add_mesh({ name: "gem", shape: "gem" });
  commands.add_group({ name: "body" });
  commands.add_cube({ name: "plate", from: [0, 0, 0], to: [1, 1, 1] });
  const edits = Undo.edits.length;
  assert.throws(
    () => commands.edit_element({ element: "gem", new_name: "moved", from: [0, 5, 0] }),
    /from\/to apply only to cubes and bounding boxes; to move "gem" pass offset/
  );
  assert.throws(() => commands.edit_element({ element: "gem", to: [1, 1, 1] }), /from\/to apply only/);
  assert.throws(() => commands.edit_element({ element: "body", from: [1, 1, 1] }), /from\/to apply only/);
  assert.throws(() => commands.edit_element({ element: "body", inflate: 0.5 }), /inflate applies to cubes only/);
  assert.throws(() => commands.edit_element({ element: "gem", inflate: 0.5 }), /inflate applies to cubes only/);
  assert.equal(Mesh.all[0].name, "gem", "nothing else in the call was applied");
  assert.equal(Mesh.all[0].from, undefined, "no stray property on the mesh");
  assert.equal(Undo.edits.length, edits, "no edit is opened");

  commands.edit_element({ element: "plate", from: [0, 0, -1], inflate: 0.25 });
  assert.deepEqual(plain(Cube.all[0].from), [0, 0, -1]);
  assert.equal(Cube.all[0].inflate, 0.25);
});

test("edit_element resizes a bounding box with from/to, and offset moves it by them", () => {
  const { commands, BoundingBox, Group, Undo } = loadPlugin();
  const hitbox = new BoundingBox({ name: "hitbox", from: [0, 0, 0], to: [4, 4, 4] }).init();
  commands.edit_element({ element: "hitbox", from: [0, 1, 0] });
  assert.deepEqual(plain(hitbox.from), [0, 1, 0], "a bounding box stores from/to, so they apply");
  // Its origin and position are constant getters: the move has to go through from/to.
  commands.edit_element({ element: "hitbox", offset: [2, 0, -1] });
  assert.deepEqual(plain(hitbox.from), [2, 1, -1]);
  assert.deepEqual(plain(hitbox.to), [6, 4, 3]);
  assert.throws(() => commands.edit_element({ element: "hitbox", inflate: 1 }), /inflate applies to cubes only/);

  commands.add_group({ name: "body" });
  const feet = new BoundingBox({ name: "feet", from: [0, 0, 0], to: [2, 1, 2] }).init().addTo(Group.all[0]);
  commands.edit_element({ element: "body", offset: [0, 3, 0] });
  assert.deepEqual(plain(feet.from), [0, 3, 0], "a bounding box inside a group moves with it");
  assert.deepEqual(plain(feet.to), [2, 4, 2]);
  assert.ok(Undo.edits[Undo.edits.length - 1].aspects.elements.includes(feet));
});

test("edit_element offset refuses what it cannot move, before moving anything", () => {
  const { commands, Group, Cube, Undo, sandbox } = loadPlugin();
  commands.add_group({ name: "body", origin: [0, 8, 0] });
  commands.add_cube({ name: "torso", from: [-2, 6, -1], to: [2, 12, 1], parent: "body" });
  // An armature has bones of its own, which moving it alone would leave behind.
  const rig = { name: "rig", type: "armature", uuid: "a-1", parent: "root", origin: [0, 0, 0], children: [] };
  // Placed only through getters with no setter: there is nothing to write to.
  const marker = { name: "marker", type: "marker", uuid: "x-1", parent: "root", get origin() { return [0, 0, 0]; } };
  sandbox.Outliner.elements.push(rig, marker);
  const edits = Undo.edits.length;

  assert.throws(
    () => commands.edit_element({ element: "rig", offset: [1, 0, 0] }),
    /offset can't move "rig" \(armature\): it has children that would not move with it/
  );
  assert.throws(
    () => commands.edit_element({ element: "marker", offset: [1, 0, 0] }),
    /offset can't move "marker" \(marker\): it has no position to move/
  );
  assert.deepEqual(plain(rig.origin), [0, 0, 0]);

  // One element the offset can't move stops the whole group, not just itself.
  const body = Group.all[0];
  marker.parent = body;
  body.children.push(marker);
  assert.throws(
    () => commands.edit_element({ element: "body", new_name: "moved", offset: [0, 5, 0] }),
    /offset can't move "marker"/
  );
  assert.deepEqual(plain(body.origin), [0, 8, 0], "the group stayed put");
  assert.deepEqual(plain(Cube.all[0].from), [-2, 6, -1], "and so did everything in it");
  assert.equal(body.name, "body", "nothing else in the call was applied");
  assert.equal(Undo.edits.length, edits, "no edit is opened");
});

// --- mesh details -----------------------------------------------------------

test("add_mesh and add_meshes report where each mesh sits", () => {
  const { commands } = loadPlugin();
  const one = commands.add_mesh({ shape: "wedge", from: [2, 0, -3], size: [4, 2, 6] });
  assert.deepEqual(plain(one.bounds), { from: [2, 0, -3], to: [6, 2, 3] });
  assert.deepEqual(plain(one.origin), [4, 1, 0]);
  const batch = commands.add_meshes({ meshes: [{ shape: "plane", from: [0, 0, 0], size: [2, 3, 0], origin: [9, 9, 9] }] });
  assert.deepEqual(plain(batch.meshes[0].bounds), { from: [0, 0, 0], to: [2, 3, 0] });
  assert.deepEqual(plain(batch.meshes[0].origin), [9, 9, 9]);
});

test("get_element and list_outliner describe a mesh: origin, rotation, bounds and counts", () => {
  const { commands } = loadPlugin();
  commands.add_mesh({ name: "gem", shape: "gem", from: [-1, 4, -1], size: [2, 3, 2], rotation: [0, 45, 0] });
  const gem = commands.get_element({ element: "gem" });
  assert.deepEqual(plain(gem.origin), [0, 5.5, 0]);
  assert.deepEqual(plain(gem.rotation), [0, 45, 0]);
  assert.deepEqual(plain(gem.bounds), { from: [-1, 4, -1], to: [1, 7, 1] }, "bounds ignore rotation, like measure_model");
  assert.equal(gem.vertices, 6);
  assert.equal(gem.faces, 8);
  const listed = commands.list_outliner().find((n) => n.name === "gem");
  assert.deepEqual(plain(listed.bounds), plain(gem.bounds));
});

test("mesh bounds come from a plain loop, so a 200k-vertex mesh does not overflow the stack", () => {
  const { commands, Mesh } = loadPlugin();
  const big = new Mesh({ name: "scan", origin: [1, 2, 3], vertices: {} });
  const N = 200000;
  for (let i = 0; i < N; i++) big.vertices[`v${i}`] = [(i % 1000) / 10, -(i % 7), i / N];
  big.init();
  const res = commands.get_element({ element: "scan" });
  assert.equal(res.vertices, N);
  assert.deepEqual(plain(res.bounds), { from: [1, -4, 3], to: [100.9, 2, 4] });
});

test("an empty mesh reports null bounds rather than infinities", () => {
  const { commands, Mesh } = loadPlugin();
  new Mesh({ name: "empty", vertices: {} }).init();
  assert.equal(commands.get_element({ element: "empty" }).bounds, null);
});
