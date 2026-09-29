/**
 * Behaviour tests for the bridge's element commands: meshes, and where things
 * end up after they are created.
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
  const attach = (node, parent) => {
    if (parent && parent !== "root") { node.parent = parent; parent.children.push(node); }
    else node.parent = "root";
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
    addVertices(...vs) {
      return vs.map((v) => { const k = `v${this.nextKey++}`; this.vertices[k] = v.slice(); return k; });
    }
    addFaces(...fs) {
      return fs.map((f) => { const k = `f${this.nextKey++}`; this.faces[k] = f; return k; });
    }
    init() { Mesh.all.push(this); elements.push(this); return this; }
    addTo(parent) { return attach(this, parent); }
  }

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
    Texture: Object.assign([], { all: [{ uuid: "t-metal", name: "metal" }], getDefault: () => null }),
    Animation: { all: [] },
    Undo,
    Canvas: { updateAll() {} },
    Outliner: { root: [], elements },
    Group,
    Cube,
    Mesh,
    MeshFace,
    ...overrides,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(instrumented, sandbox, { filename: "blockbench_mcp.js" });
  return { commands: sandbox.__MCP_COMMANDS__, Group, Cube, Mesh, Undo, sandbox };
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
