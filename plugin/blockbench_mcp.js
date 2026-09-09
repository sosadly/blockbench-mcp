/**
 * BlockbenchMCP — bridge plugin
 *
 * Runs a small local HTTP server inside Blockbench that the BlockbenchMCP server
 * (a separate Node process spoken to by an AI via the Model Context Protocol)
 * connects to. Every request is a JSON command that is executed against the
 * Blockbench API on the renderer thread and answered with a JSON result.
 *
 * Nothing here is exposed to the public internet: the server binds to 127.0.0.1
 * only. Stop it any time from Tools ▸ MCP Server.
 */
(function () {

const PLUGIN_ID = 'blockbench_mcp';
const DEFAULT_PORT = 8787;
const PROTOCOL_VERSION = 1;

// Survive plugin reloads: keep the running server + reference state on a global handle.
const G = (globalThis.__BLOCKBENCH_MCP__ = globalThis.__BLOCKBENCH_MCP__ || {
	server: null,
	port: null,
	references: [],   // [{id,name,data_url,width,height,source,added_at,ref_image}]
	lastCompare: null, // {match_percent, view, reference, time}
	activity: [],     // ring buffer of {t, action, ok, ms} for the in-app panel
	refSeq: 0,
	pending: [],      // review/question requests waiting for the user in the panel
	requests: {},     // every request by id (answers outlive the tool call that asked)
	askSeq: 0,
	answers: [],      // ring buffer of answered requests (audit trail)
});
// Tolerate a global left over from an older plugin version that lacked these fields.
if (!Array.isArray(G.references)) G.references = [];
if (!Array.isArray(G.activity)) G.activity = [];
if (typeof G.refSeq !== 'number') G.refSeq = 0;
if (!Array.isArray(G.pending)) G.pending = [];
if (!Array.isArray(G.answers)) G.answers = [];
if (!G.requests || typeof G.requests !== 'object') G.requests = {};
if (typeof G.askSeq !== 'number') G.askSeq = 0;
const ACTIVITY_CAP = 60;

// Blockbench gives plugins a permission-scoped `require`. The 'http' module is
// NOT on its allow-list, but 'net' is (it grants full network access). So we
// build a tiny HTTP/1.1 server on top of a raw TCP server. `require('net')` is
// called lazily from startServer() so the permission dialog appears when the
// user actually starts the server, and any error is surfaced instead of swallowed.
let net = null;
function getNet() {
	if (net) return net;
	net = require('net'); // may show a permission dialog or throw if denied
	if (!net || !net.createServer) {
		throw new Error('Network access (net module) was denied. Allow it to start the MCP server.');
	}
	return net;
}

let deletables = [];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function requireProject() {
	if (!Project || typeof Project !== 'object') {
		throw new Error('No project is open. Create one first with new_project.');
	}
}

function requireApp() {
	if (typeof isApp === 'undefined' || !isApp) {
		throw new Error('This action is only available in the Blockbench desktop app.');
	}
}

/** Resolve a Format from an id, a name, or a fuzzy match. */
function resolveFormat(id) {
	if (!id) return null;
	if (Formats[id]) return Formats[id];
	const key = String(id).toLowerCase().replace(/[\s\-]+/g, '_');
	if (Formats[key]) return Formats[key];
	for (const fid in Formats) {
		const f = Formats[fid];
		if (!f) continue;
		if (fid.toLowerCase() === key) return f;
		if (f.name && f.name.toLowerCase().replace(/[\s\-]+/g, '_') === key) return f;
		if (f.name && f.name.toLowerCase().includes(String(id).toLowerCase())) return f;
	}
	return null;
}

/** Find a group (bone) by uuid or name. */
function findGroup(ref) {
	if (!ref) return null;
	let g = Group.all.find((x) => x.uuid === ref);
	if (!g) g = Group.all.find((x) => x.name === ref);
	return g || null;
}

/** Find any outliner element (cube, mesh, locator, …) by uuid or name. */
function findElement(ref) {
	if (!ref) return null;
	let e = Outliner.elements.find((x) => x.uuid === ref);
	if (!e) e = Outliner.elements.find((x) => x.name === ref);
	return e || null;
}

/** Find a group OR an element by uuid or name. */
function findNode(ref) {
	return findGroup(ref) || findElement(ref);
}

function findTexture(ref) {
	if (!ref && ref !== 0) return null;
	let t = Texture.all.find((x) => x.uuid === ref);
	if (!t) t = Texture.all.find((x) => x.name === ref);
	if (!t && typeof ref === 'number') t = Texture.all[ref];
	return t || null;
}

function findAnimation(ref) {
	if (!ref) return null;
	const list = Animation.all || [];
	let a = list.find((x) => x.uuid === ref);
	if (!a) a = list.find((x) => x.name === ref);
	return a || null;
}

function num3(v, fallback) {
	if (!Array.isArray(v)) return fallback;
	return [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0];
}

/**
 * Coerce a value into an array. Some MCP clients serialize array arguments as a
 * JSON string when the tool schema doesn't pin `type: array`, so accept that too.
 */
function toList(v) {
	if (Array.isArray(v)) return v;
	if (typeof v === 'string') {
		const s = v.trim();
		if (s[0] === '[') {
			try { const parsed = JSON.parse(s); if (Array.isArray(parsed)) return parsed; } catch (e) {}
		}
		return [v];
	}
	return v == null ? [] : [v];
}

// ---------------------------------------------------------------------------
// ORIENTATION — one source of truth for FRONT/BACK and LEFT/RIGHT.
//
// Verified against Blockbench's own bundled vanilla data (js/formats/skin.js
// presets) and its Bedrock/Java codecs:
//   * Minecraft models face NORTH = -Z (the head's face texture is on the
//     `north` face). Format.forward_direction says so per format.
//   * Blockbench MIRRORS X when reading/writing Bedrock & Java model files
//     (bedrock codec: `origin[0] *= -1`, `from[0] = -(from[0] + size[0])`;
//     modded-entity export: `c[0] *= -1`). So vanilla `rightArm`, stored at
//     Bedrock x = -5, lives at Blockbench x = +5.
//   * Right-hand rule: right = forward × up. forward (0,0,-1) × up (0,1,0)
//     = (1,0,0). Both agree: in BLOCKBENCH SPACE the model's RIGHT is +X.
//
// The trap this module exists to close: on a screenshot taken from the FRONT
// (looking at the face) the model's right hand appears on the LEFT of the
// image — exactly like facing a real person. Judging "left/right" by eye from
// a render is therefore wrong half the time; ask this module instead.
// ---------------------------------------------------------------------------

const AXIS_VECTORS = {
	'+x': [1, 0, 0], '-x': [-1, 0, 0],
	'+y': [0, 1, 0], '-y': [0, -1, 0],
	'+z': [0, 0, 1], '-z': [0, 0, -1],
};

function vecCross(a, b) {
	return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function vecDot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function vecNeg(a) { return [-a[0], -a[1], -a[2]]; }
function vecAdd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function vecScale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
function vecNorm(a) {
	const l = Math.hypot(a[0], a[1], a[2]) || 1;
	return [a[0] / l, a[1] / l, a[2] / l];
}
/** '+x' | '-z' | … for an axis-aligned vector. */
function axisLabel(v) {
	for (const k in AXIS_VECTORS) {
		const a = AXIS_VECTORS[k];
		if (Math.abs(a[0] - v[0]) < 1e-6 && Math.abs(a[1] - v[1]) < 1e-6 && Math.abs(a[2] - v[2]) < 1e-6) return k;
	}
	return null;
}
const AXIS_INDEX = { x: 0, y: 1, z: 2 };

/** The axis the model faces. Blockbench formats declare it; Minecraft = '-z'. */
function facingAxis() {
	let f = null;
	try { f = Format && Format.forward_direction; } catch (e) {}
	if (Project && Project.mcp_facing && AXIS_VECTORS[Project.mcp_facing]) return Project.mcp_facing;
	return AXIS_VECTORS[f] ? f : '-z';
}

/**
 * The full handedness frame of the current model. Everything that says
 * "left"/"right"/"front" anywhere in this plugin derives from this.
 */
function orientation() {
	const facing = facingAxis();
	const front = AXIS_VECTORS[facing];
	const up = [0, 1, 0];
	const right = vecCross(front, up); // right = forward × up
	const left = vecNeg(right);
	const rightAxis = axisLabel(right) || '+x';
	const idx = AXIS_INDEX[rightAxis[1]];
	return {
		facing,
		front_axis: facing,
		back_axis: axisLabel(vecNeg(front)),
		right_axis: rightAxis,
		left_axis: axisLabel(left),
		up_axis: '+y',
		down_axis: '-y',
		front_vec: front,
		back_vec: vecNeg(front),
		right_vec: right,
		left_vec: left,
		up_vec: up,
		/** Index (0/1/2) of the coordinate that separates left from right. */
		side_index: idx,
		/** Multiply a coordinate by this: > 0 means the model's RIGHT. */
		side_sign: rightAxis[0] === '+' ? 1 : -1,
	};
}

/** 'right' | 'left' | 'center' for a point in model space. */
function sideOfCoord(coord, eps) {
	const o = orientation();
	const d = coord * o.side_sign;
	const e = eps == null ? 0.35 : eps;
	if (d > e) return 'right';
	if (d < -e) return 'left';
	return 'center';
}
function sideOfPoint(p, eps) {
	return sideOfCoord(p[orientation().side_index], eps);
}

/** The side coordinate (signed, + = model's right) of a cube/group. */
function sideCoordOf(node) {
	const o = orientation();
	const i = o.side_index;
	if (node instanceof Cube) return ((node.from[i] + node.to[i]) / 2) * o.side_sign;
	if (node instanceof Group) {
		const cubes = [];
		const walk = (g) => g.children.forEach((c) => (c instanceof Group ? walk(c) : (c instanceof Cube && cubes.push(c))));
		walk(node);
		if (cubes.length) {
			let sum = 0;
			cubes.forEach((c) => (sum += (c.from[i] + c.to[i]) / 2));
			return (sum / cubes.length) * o.side_sign;
		}
		return (node.origin ? node.origin[i] : 0) * o.side_sign;
	}
	if (node && node.origin) return node.origin[i] * o.side_sign;
	return 0;
}

/** Names that a creature is expected to have one of on each side. */
const PAIRED_PART_RE = /arm|leg|hand|foot|feet|paw|hoof|claw|toe|finger|wing|ear|horn|antler|shoulder|thigh|shin|knee|elbow|eye|tusk|fin|antenna/i;

const SIDE_WORDS = {
	right: ['right', 'rght', 'rgt', 'rt', 'r'],
	left: ['left', 'lft', 'lt', 'l'],
};

/** Split a name into lowercase tokens: "armUpper_L2" -> ['arm','upper','l','2'] */
function nameTokens(name) {
	return String(name || '')
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.split(/[^A-Za-z0-9]+/)
		.map((t) => t.trim().toLowerCase())
		.filter(Boolean)
		.flatMap((t) => {
			const m = /^([a-z]+)(\d+)$/.exec(t);
			return m ? [m[1], m[2]] : [t];
		});
}

/** 'left' | 'right' | null — the side a name CLAIMS. null when unmarked/ambiguous. */
function sideFromName(name) {
	const tokens = nameTokens(name);
	let hit = null;
	for (const t of tokens) {
		for (const side in SIDE_WORDS) {
			if (SIDE_WORDS[side].includes(t)) {
				if (hit && hit !== side) return null; // "left_right" — ambiguous
				hit = side;
			}
		}
	}
	return hit;
}

/** Rename foo_left <-> foo_right (token-wise, preserving case style). */
function swapSideInName(name) {
	return String(name).replace(/(right|Right|RIGHT|left|Left|LEFT)/g, (m) => {
		const map = { right: 'left', Right: 'Left', RIGHT: 'LEFT', left: 'right', Left: 'Right', LEFT: 'RIGHT' };
		return map[m] || m;
	}).replace(/(^|[^a-zA-Z])([rRlL])($|[^a-zA-Z])/g, (m, a, c, b) => {
		const map = { r: 'l', R: 'L', l: 'r', L: 'R' };
		return a + (map[c] || c) + b;
	});
}

/**
 * The human-readable rulebook. Returned by get_orientation, embedded in
 * get_status and stamped onto every screenshot, so the model never has to
 * guess (or "remember") which side is which.
 */
function orientationReport() {
	const o = orientation();
	const s = o.side_sign > 0 ? '+' : '-';
	const ax = o.right_axis[1].toUpperCase();
	return {
		facing: o.facing,
		summary:
			`The model FACES ${o.front_axis}. Its own RIGHT is ${o.right_axis}, its own LEFT is ${o.left_axis}.`,
		front_axis: o.front_axis,
		back_axis: o.back_axis,
		right_axis: o.right_axis,
		left_axis: o.left_axis,
		rules: [
			`ANATOMY (character's own left/right, which is what "put the sword in his right hand" means):`,
			`  the model's RIGHT side is at ${o.right_axis} (${ax} ${s === '+' ? '>' : '<'} 0), its LEFT side at ${o.left_axis}.`,
			`  So a right hand/arm/leg/horn belongs at ${ax} ${s === '+' ? '>' : '<'} 0 and must be named *_right.`,
			`SCREENSHOTS LIE ABOUT SIDES: in a FRONT view (looking at the face) you see the model`,
			`  mirrored, like facing a person — its RIGHT hand appears on the LEFT of the image.`,
			`  In a BACK view its right hand appears on the right of the image. Never decide a side`,
			`  from a render: use these axes, check_sides, or the label printed on every screenshot.`,
			`ROTATION SIGNS: +X rotation turns a bone so its FRONT face goes UP. Therefore a bone`,
			`  that points DOWN (arm, leg) swings its tip FORWARD (${o.front_axis}) with +X, and a bone`,
			`  that points UP (torso, neck, head) tips BACKWARD with +X. +Y rotation turns the model`,
			`  toward its own LEFT. +Z rotation tips the top of a bone toward the model's LEFT.`,
			`EXPORT: Blockbench mirrors X when writing Bedrock/GeckoLib/Java files, so a bone you`,
			`  place at ${o.right_axis} here is written out at ${o.left_axis} in the .json — that is correct and`,
			`  matches vanilla (Bedrock "rightArm" pivot is x = -5).`,
		].join('\n'),
	};
}

/** Append _left/_right to a name when `side` was given and the name lacks it. */
function sideNameFor(name, side) {
	if (!side) return name;
	const s = String(side).toLowerCase();
	if (s !== 'left' && s !== 'right') return name;
	return sideFromName(name) === s ? name : `${name}_${s}`;
}

/**
 * Hard-stop when an explicit `side` contradicts the coordinate. Silently
 * building a "right arm" on the left is the failure the user actually hits,
 * so this refuses instead of warning.
 */
function assertSide(name, side, coord, what) {
	if (!side) return;
	const s = String(side).toLowerCase();
	if (s !== 'left' && s !== 'right') throw new Error(`side must be "left" or "right", got "${side}"`);
	const o = orientation();
	const signed = coord * o.side_sign;
	const wanted = s === 'right' ? 1 : -1;
	if (signed * wanted <= 0.0001) {
		const axis = s === 'right' ? o.right_axis : o.left_axis;
		throw new Error(
			`${what} "${name}" is declared side:"${s}" but sits at ${o.right_axis[1].toUpperCase()}=${coord.toFixed(2)}, ` +
			`which is the model's ${signed > 0 ? 'RIGHT' : signed < 0 ? 'LEFT' : 'CENTRE'}. ` +
			`The model faces ${o.front_axis}, so its ${s} side is ${axis}. ` +
			`Move it to ${axis} (flip the sign of that coordinate) or change side/name.`
		);
	}
}

/** Non-fatal note when a name says one side and the geometry says the other. */
function sideWarning(node) {
	const claimed = sideFromName(node.name);
	if (!claimed) return null;
	const actual = sideOfCoord(sideCoordOf(node));
	if (actual === claimed) return null;
	const o = orientation();
	if (actual === 'center') return `"${node.name}" is named ${claimed} but sits on the centre line (the model's ${claimed} is ${claimed === 'right' ? o.right_axis : o.left_axis}).`;
	return `LEFT/RIGHT MISMATCH: "${node.name}" is named ${claimed} but its geometry is on the model's ${actual}. The model faces ${o.front_axis}, so its RIGHT is ${o.right_axis}. Rename it "${swapSideInName(node.name)}" or move it to ${claimed === 'right' ? o.right_axis : o.left_axis}.`;
}

// ---------------------------------------------------------------------------
// Serializers (strip THREE.js / circular data, keep what an AI can reason about)
// ---------------------------------------------------------------------------

function serializeElement(el) {
	if (!el) return null;
	const out = {
		uuid: el.uuid,
		name: el.name,
		type: el.type,
		parent: el.parent && el.parent !== 'root' ? el.parent.uuid : 'root',
	};
	if (el instanceof Cube) {
		Object.assign(out, {
			from: el.from,
			to: el.to,
			origin: el.origin,
			rotation: el.rotation,
			inflate: el.inflate,
			box_uv: el.box_uv,
			uv_offset: el.uv_offset,
			autouv: el.autouv,
			faces: serializeFaces(el),
		});
	}
	return out;
}

function serializeFaces(cube) {
	const faces = {};
	for (const dir in cube.faces) {
		const f = cube.faces[dir];
		faces[dir] = {
			uv: f.uv,
			rotation: f.rotation,
			texture: f.texture ? (Texture.all.find((t) => t.uuid === f.texture) || {}).name || f.texture : null,
		};
	}
	return faces;
}

function serializeGroup(g, deep) {
	if (!g) return null;
	const out = {
		uuid: g.uuid,
		name: g.name,
		type: 'group',
		origin: g.origin,
		rotation: g.rotation,
		visibility: g.visibility,
		parent: g.parent && g.parent !== 'root' ? g.parent.uuid : 'root',
	};
	if (deep) {
		out.children = g.children.map((c) =>
			c instanceof Group ? serializeGroup(c, true) : serializeElement(c)
		);
	}
	return out;
}

function serializeTexture(t) {
	if (!t) return null;
	return {
		uuid: t.uuid,
		name: t.name,
		width: t.width,
		height: t.height,
		uv_width: t.uv_width,
		uv_height: t.uv_height,
		particle: t.particle,
		render_mode: t.render_mode,
		render_sides: t.render_sides,
		frame_count: (() => { try { return t.frameCount; } catch (e) { return undefined; } })(),
		frame_time: t.frame_time,
		frame_interpolate: t.frame_interpolate,
		path: t.path || null,
	};
}

function serializeAnimation(a) {
	if (!a) return null;
	return {
		uuid: a.uuid,
		name: a.name,
		loop: a.loop,
		length: a.length,
		snapping: a.snapping,
		bones: Object.values(a.animators || {})
			.filter((an) => an && an.keyframes)
			.map((an) => ({
				name: an.name,
				uuid: an.uuid,
				keyframe_count: an.keyframes.length,
			})),
	};
}

function outlinerTree() {
	return Outliner.root.map((n) =>
		n instanceof Group ? serializeGroup(n, true) : serializeElement(n)
	);
}

// ---------------------------------------------------------------------------
// Texture utilities
// ---------------------------------------------------------------------------

function blankTextureDataURL(width, height, fill) {
	const c = document.createElement('canvas');
	c.width = width;
	c.height = height;
	const ctx = c.getContext('2d');
	if (fill) {
		ctx.fillStyle = fill;
		ctx.fillRect(0, 0, width, height);
	}
	return c.toDataURL('image/png');
}

// --- colour helpers ---------------------------------------------------------
let _colorCanvas = null;
/** Parse any CSS colour ('#abc', 'rgb(...)', 'red', ...) into {r,g,b,a}. */
function parseColor(col) {
	if (!_colorCanvas) _colorCanvas = document.createElement('canvas');
	_colorCanvas.width = _colorCanvas.height = 1;
	const x = _colorCanvas.getContext('2d');
	x.clearRect(0, 0, 1, 1);
	x.fillStyle = '#000';
	x.fillStyle = col;
	x.fillRect(0, 0, 1, 1);
	const d = x.getImageData(0, 0, 1, 1).data;
	return { r: d[0], g: d[1], b: d[2], a: d[3] };
}
function clamp8(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }
/** Multiply a colour's brightness by `factor` (1 = unchanged). Returns 'rgb(...)'. */
function shadeHex(col, factor) {
	const c = parseColor(col);
	return `rgb(${clamp8(c.r * factor)},${clamp8(c.g * factor)},${clamp8(c.b * factor)})`;
}

/** A cube face's UV as an axis-aligned pixel rect on the texture canvas. */
function faceRect(face, scale) {
	const u = (face && face.uv) || [0, 0, 0, 0];
	const x1 = u[0] * scale, y1 = u[1] * scale, x2 = u[2] * scale, y2 = u[3] * scale;
	return {
		x: Math.round(Math.min(x1, x2)),
		y: Math.round(Math.min(y1, y2)),
		w: Math.round(Math.abs(x2 - x1)),
		h: Math.round(Math.abs(y2 - y1)),
	};
}

/** Shift paint ops by (ox,oy) so callers can use coordinates relative to a face. */
function offsetOps(ops, ox, oy, rectW, rectH) {
	return (ops || []).map((op) => {
		const o = Object.assign({}, op);
		['x', 'y', 'x1', 'y1', 'x2', 'y2'].forEach((k) => {
			if (typeof o[k] === 'number') o[k] += (k[0] === 'x' ? ox : oy);
		});
		if (Array.isArray(o.points)) o.points = o.points.map((p) => [p[0] + ox, p[1] + oy]);
		// Region-style ops default to the whole face when no explicit box is given.
		if ((o.type === 'noise' || o.type === 'dither' || o.type === 'clear') && o.width == null) {
			o.x = ox; o.y = oy; o.width = rectW; o.height = rectH;
		}
		if (o.type === 'fill_all') { o.type = 'rect'; o.x = ox; o.y = oy; o.width = rectW; o.height = rectH; }
		return o;
	});
}

/** Bounding box of all cubes, with a sensible fallback when the model is empty. */
function sceneBounds() {
	let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
	Cube.all.forEach((c) => {
		for (let i = 0; i < 3; i++) {
			min[i] = Math.min(min[i], c.from[i], c.to[i]);
			max[i] = Math.max(max[i], c.from[i], c.to[i]);
		}
	});
	if (!isFinite(min[0])) { min = [-8, 0, -8]; max = [8, 16, 8]; }
	const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
	const size = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1);
	return { center, size };
}

// ---------------------------------------------------------------------------
// MODEL-RELATIVE CAMERA VIEWS
//
// Blockbench's own presets are world-axis names (north/south/east/west) and the
// old fallback here made "front" mean "camera on the +Z side" — which for a
// Minecraft model (facing -Z) shows its BACK. Views are now named from the
// MODEL's point of view: `front` looks at its face, `left` looks at the side
// its left arm is on. Every view also reports which side of the IMAGE the
// model's right ends up on, and screenshots get that stamped on them.
// ---------------------------------------------------------------------------

/** Camera offset direction (from the model centre) for a named view. */
function viewOffsetDir(name) {
	const o = orientation();
	const F = o.front_vec, B = o.back_vec, R = o.right_vec, L = o.left_vec, U = o.up_vec;
	const n = String(name || '').toLowerCase().replace(/[\s-]+/g, '_');
	const iso = (a, b) => vecNorm(vecAdd(vecAdd(a, b), vecScale(U, 0.85)));
	const table = {
		// model-relative
		front: F, face: F, head_on: F, front_view: F,
		back: B, behind: B, rear: B, tail: B,
		left: L, left_side: L, model_left: L,
		right: R, right_side: R, model_right: R,
		top: vecNorm(vecAdd(U, vecScale(F, 0.001))),
		up: vecNorm(vecAdd(U, vecScale(F, 0.001))),
		bottom: vecNorm(vecAdd(vecNeg(U), vecScale(F, 0.001))),
		down: vecNorm(vecAdd(vecNeg(U), vecScale(F, 0.001))),
		// three-quarter views (the most readable angles)
		iso: iso(F, R), isometric: iso(F, R),
		front_right: iso(F, R), isometric_front_right: iso(F, R), isometric_right_front: iso(F, R),
		front_left: iso(F, L), isometric_front_left: iso(F, L), isometric_left_front: iso(F, L),
		back_right: iso(B, R), isometric_back_right: iso(B, R),
		back_left: iso(B, L), isometric_back_left: iso(B, L),
		// explicit world axes, for when you really mean the axis
		'+x': AXIS_VECTORS['+x'], '-x': AXIS_VECTORS['-x'],
		'+y': AXIS_VECTORS['+y'], '-y': AXIS_VECTORS['-y'],
		'+z': AXIS_VECTORS['+z'], '-z': AXIS_VECTORS['-z'],
		east: AXIS_VECTORS['+x'], west: AXIS_VECTORS['-x'],
		south: AXIS_VECTORS['+z'], north: AXIS_VECTORS['-z'],
	};
	return table[n] || null;
}

/**
 * What a view shows, in words — including the L/R mirror trap.
 * Returns {view, dir, looking_at, model_right_on, label, note}.
 */
function describeView(name, dir) {
	const o = orientation();
	dir = dir || viewOffsetDir(name) || viewOffsetDir('front_right');
	// The camera sits at centre + dir, so it LOOKS along -dir.
	const look = vecNeg(dir);
	// Screen right = look × up (right-handed). Degenerate for top/bottom views:
	// there we use the model's front as the up-on-screen direction instead.
	let up = o.up_vec;
	if (Math.abs(vecDot(vecNorm(look), up)) > 0.95) up = o.front_vec;
	const screenRight = vecNorm(vecCross(look, up));
	const d = vecDot(screenRight, o.right_vec);
	const rightOn = d > 0.2 ? 'image_right' : d < -0.2 ? 'image_left' : 'edge_on';
	const towardFront = vecDot(vecNorm(dir), o.front_vec);
	const lookingAt =
		towardFront > 0.5 ? "the model's FRONT (its face)" :
		towardFront < -0.5 ? "the model's BACK" :
		Math.abs(vecDot(vecNorm(dir), o.up_vec)) > 0.85 ? (dir[1] > 0 ? 'the model from ABOVE' : 'the model from BELOW') :
		vecDot(vecNorm(dir), o.right_vec) > 0 ? "the model's RIGHT side" : "the model's LEFT side";
	const rightWord =
		rightOn === 'image_right' ? "model's RIGHT is on the IMAGE RIGHT" :
		rightOn === 'image_left' ? "model's RIGHT is on the IMAGE LEFT (mirrored — you face it)" :
		"model's left/right are edge-on here";
	return {
		view: name,
		dir,
		looking_at: lookingAt,
		model_right_on: rightOn,
		label: `${String(name).toUpperCase()} · ${lookingAt} · ${rightWord}`,
		note: rightWord,
	};
}

/** Place the preview camera for a named model-relative view. */
function applyAngleName(preview, name) {
	const { center, size } = sceneBounds();
	const dist = size * 2.2 + 12;
	const v = vecNorm(viewOffsetDir(name) || viewOffsetDir('front_right'));
	preview.camera.position.set(center[0] + v[0] * dist, center[1] + v[1] * dist, center[2] + v[2] * dist);
	if (preview.controls) preview.controls.target.set(center[0], center[1], center[2]);
	return describeView(name, v);
}

// ---------------------------------------------------------------------------
// Reference images + silhouette comparison (the grounded-modeling engine)
// ---------------------------------------------------------------------------

/** Load a data URL (or path-less image source) into an <img>, resolving when ready. */
function loadImageElement(src) {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error('Could not decode image data.'));
		img.src = src;
	});
}

/**
 * Stamp a render with what it actually shows: the view name, whether you are
 * looking at the model's face or its back, and — the part that keeps getting
 * models built back-to-front — which edge of the IMAGE the model's own RIGHT
 * side is on. Also draws big R/L markers on the correct edges.
 */
async function annotateShot(dataUrl, info, extra) {
	try {
		const img = await loadImageElement(dataUrl);
		const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
		const scale = Math.max(1, Math.min(3, w / 400));
		const barH = Math.round(19 * scale);
		const canvas = document.createElement('canvas');
		canvas.width = w; canvas.height = h + barH * 2;
		const ctx = canvas.getContext('2d');
		ctx.fillStyle = '#101216';
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.drawImage(img, 0, barH);

		const font = (px, bold) => `${bold ? 'bold ' : ''}${Math.round(px * scale)}px monospace`;
		// Top bar: what this view is.
		ctx.fillStyle = '#1b1f27';
		ctx.fillRect(0, 0, w, barH);
		ctx.fillStyle = '#e7ecf5';
		ctx.font = font(11, true);
		ctx.textBaseline = 'middle';
		const top = `${String(info.view || 'view').toUpperCase()}  |  looking at ${info.looking_at || '?'}`;
		ctx.fillText(top.slice(0, Math.floor(w / (6.2 * scale))), Math.round(5 * scale), barH / 2);
		if (extra) {
			ctx.textAlign = 'right';
			ctx.fillStyle = '#9fd0ff';
			ctx.fillText(String(extra), w - Math.round(5 * scale), barH / 2);
			ctx.textAlign = 'left';
		}

		// Bottom bar: the side mapping, spelled out on the correct edges.
		const y = h + barH + barH / 2;
		ctx.fillStyle = '#1b1f27';
		ctx.fillRect(0, h + barH, w, barH);
		ctx.font = font(11, true);
		const rightOn = info.model_right_on;
		if (rightOn === 'image_right' || rightOn === 'image_left') {
			const mirrored = rightOn === 'image_left';
			const leftEdge = mirrored ? "<< model's RIGHT" : "<< model's LEFT";
			const rightEdge = mirrored ? "model's LEFT >>" : "model's RIGHT >>";
			ctx.textAlign = 'left';
			ctx.fillStyle = mirrored ? '#ff8a7a' : '#7ab8ff';
			ctx.fillText(leftEdge, Math.round(5 * scale), y);
			ctx.textAlign = 'right';
			ctx.fillStyle = mirrored ? '#7ab8ff' : '#ff8a7a';
			ctx.fillText(rightEdge, w - Math.round(5 * scale), y);
			// Only add the middle caption when it cannot collide with the edges.
			const edges = ctx.measureText(leftEdge).width + ctx.measureText(rightEdge).width;
			ctx.font = font(9, false);
			const mid = mirrored ? 'MIRRORED — you face the model' : 'same-side view';
			if (edges + ctx.measureText(mid).width + 24 * scale < w) {
				ctx.textAlign = 'center';
				ctx.fillStyle = '#c9d3e2';
				ctx.fillText(mid, w / 2, y);
			}
		} else {
			ctx.fillStyle = '#c9d3e2';
			ctx.textAlign = 'center';
			ctx.fillText(info.note || '', w / 2, y);
			ctx.textAlign = 'left';
		}
		ctx.textAlign = 'left';
		return canvas.toDataURL('image/png');
	} catch (e) {
		return dataUrl; // never fail a screenshot over a caption
	}
}

/** Decode an image source to a 2D ImageData (optionally downscaled so the longest side <= maxDim). */
async function imageDataFromSource(src, maxDim) {
	const img = await loadImageElement(src);
	let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
	if (maxDim && Math.max(w, h) > maxDim) {
		const s = maxDim / Math.max(w, h);
		w = Math.max(1, Math.round(w * s));
		h = Math.max(1, Math.round(h * s));
	}
	const c = document.createElement('canvas');
	c.width = w; c.height = h;
	const ctx = c.getContext('2d');
	ctx.drawImage(img, 0, 0, w, h);
	// Return the ImageData itself (it carries .data/.width/.height) — maskFromPixels &
	// referenceSilhouette destructure those directly, so do NOT re-wrap it.
	return ctx.getImageData(0, 0, w, h);
}

/** Store a reference image (and best-effort add it as a Blockbench viewport overlay). */
async function addReference(dataURL, name, source, opts) {
	if (!dataURL || typeof dataURL !== 'string') throw new Error('A data URL is required.');
	const img = await loadImageElement(dataURL);
	const entry = {
		id: 'ref_' + (++G.refSeq),
		name: name || ('reference_' + G.refSeq),
		data_url: dataURL,
		width: img.naturalWidth || img.width,
		height: img.naturalHeight || img.height,
		source: source || 'data',
		added_at: Date.now(),
		ref_image: null,
	};
	G.references.push(entry);
	const wantOverlay = !opts || opts.overlay !== false;
	if (wantOverlay) entry.overlay_added = tryAddReferenceOverlay(entry, opts);
	return entry;
}

/** Best-effort: pin the reference behind the model in the viewport. Version-tolerant, never throws. */
function tryAddReferenceOverlay(entry, opts) {
	try {
		if (typeof ReferenceImage === 'undefined' || !Project) return false;
		const ri = new ReferenceImage({
			name: entry.name,
			source: entry.data_url,
			position: [0, 0],
			size: [entry.width, entry.height],
			opacity: opts && opts.opacity != null ? opts.opacity : 0.45,
			visibility: true,
			layer: (opts && opts.layer) || 'background',
			scope: 'project',
		});
		if (typeof ri.addAsReference === 'function') ri.addAsReference();
		else if (typeof ri.add === 'function') ri.add();
		if (typeof ri.select === 'function') { try { ri.select(); } catch (e) {} }
		if (typeof ri.update === 'function') { try { ri.update(); } catch (e) {} }
		entry.ref_image = ri;
		return true;
	} catch (e) {
		console.warn('[BlockbenchMCP] reference overlay unavailable:', e && e.message);
		return false;
	}
}

function removeReferenceOverlay(entry) {
	try {
		const ri = entry && entry.ref_image;
		if (ri && typeof ri.delete === 'function') ri.delete();
	} catch (e) {}
	if (entry) entry.ref_image = null;
}

/** Resolve a reference by id/name/index; default = the most recently added. */
function pickReference(ref) {
	if (!G.references.length) return null;
	if (ref == null || ref === '') return G.references[G.references.length - 1];
	let r = G.references.find((x) => x.id === ref || x.name === ref);
	if (!r && typeof ref === 'number' && G.references[ref]) r = G.references[ref];
	return r || null;
}

/** Squared-ish colour distance (0..~441). */
function colorDist(r1, g1, b1, r2, g2, b2) {
	return Math.sqrt((r1 - r2) * (r1 - r2) + (g1 - g2) * (g1 - g2) + (b1 - b2) * (b1 - b2));
}

/**
 * Render the model with a transparent background and grid/gizmos hidden, then
 * hand the captured GL pixels to `fn`. Restores all preview state afterwards.
 * Relies on Blockbench's preview renderer using preserveDrawingBuffer (it does —
 * that is how Screencam works), so reading the canvas right after render is valid.
 */
function withSilhouetteCapture(preview, fn) {
	const renderer = preview.renderer;
	// Blockbench renders the global `scene` (preview has no own .scene field).
	const sc = (typeof scene !== 'undefined' && scene && scene.traverse) ? scene : preview.scene;
	const oldBg = sc.background;
	let oldClear;
	try { oldClear = renderer.getClearColor(new THREE.Color()); } catch (e) { try { oldClear = renderer.getClearColor(); } catch (e2) { oldClear = null; } }
	const oldAlpha = (typeof renderer.getClearAlpha === 'function') ? renderer.getClearAlpha() : 1;
	const restores = [];
	// Hide helper geometry (grid, axes, gizmos, selection outlines) — never Meshes (the model).
	try {
		sc.traverse((o) => {
			if (o === sc || !o.visible) return;
			const t = o.type || '';
			if (o.isGridHelper || o.isAxesHelper ||
				t === 'GridHelper' || t === 'AxesHelper' ||
				t === 'LineSegments' || t === 'Line' || t === 'LineLoop') {
				restores.push([o, o.visible]); o.visible = false;
			}
		});
	} catch (e) {}
	try {
		if (typeof Canvas !== 'undefined' && Array.isArray(Canvas.gizmos)) {
			Canvas.gizmos.forEach((g) => { if (g && g.visible) { restores.push([g, g.visible]); g.visible = false; } });
		}
	} catch (e) {}
	sc.background = null;
	try { renderer.setClearColor(0x000000, 0); } catch (e) {}
	let result;
	try {
		preview.render();
		const gl = preview.canvas || renderer.domElement;
		const c = document.createElement('canvas');
		c.width = gl.width; c.height = gl.height;
		const ctx = c.getContext('2d');
		ctx.drawImage(gl, 0, 0);
		result = fn({
			image_data: ctx.getImageData(0, 0, gl.width, gl.height),
			data_url: c.toDataURL('image/png'),
			width: gl.width, height: gl.height,
		});
	} finally {
		sc.background = oldBg;
		try { if (oldClear) renderer.setClearColor(oldClear, oldAlpha); } catch (e) {}
		restores.forEach(([o, v]) => { o.visible = v; });
		preview.render();
	}
	return result;
}

/** Build a binary mask + bounding box from ImageData, given a per-pixel predicate. */
function maskFromPixels(imageData, predicate) {
	const { data, width, height } = imageData;
	const mask = new Uint8Array(width * height);
	let area = 0, minX = width, minY = height, maxX = -1, maxY = -1;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4;
			if (predicate(data[i], data[i + 1], data[i + 2], data[i + 3])) {
				mask[y * width + x] = 1;
				area++;
				if (x < minX) minX = x; if (x > maxX) maxX = x;
				if (y < minY) minY = y; if (y > maxY) maxY = y;
			}
		}
	}
	const bbox = maxX < 0 ? { x: 0, y: 0, w: 0, h: 0 } : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
	return { mask, width, height, bbox, area };
}

/** Silhouette of the model render: any pixel with alpha above the cutoff. */
function modelSilhouette(imageData, threshold) {
	const a = Math.round((threshold != null ? threshold : 0.5) * 255);
	return maskFromPixels(imageData, (r, g, b, alpha) => alpha > a);
}

/**
 * Silhouette of a reference image.
 * - If the image has real transparency, the alpha channel IS the cutout.
 * - Otherwise the background is region-grown inward from the border by LOCAL colour
 *   similarity (a magic-wand flood from the edges). This stops at the subject's sharp
 *   outline and, crucially, KEEPS dark interior parts (a brown loincloth, shadowed legs)
 *   that a simple "distance from one background colour" test would wrongly drop when the
 *   background itself is dark. Handles flat, gradient and two-tone backgrounds.
 *   Falls back to global colour-distance, then to the whole frame, if it degenerates.
 */
function referenceSilhouette(imageData) {
	const { data, width, height } = imageData;
	const total = width * height;
	// 1) Transparent PNG → use the alpha channel directly.
	let transparent = 0;
	for (let i = 3; i < data.length; i += 4) if (data[i] < 200) transparent++;
	if (transparent > total * 0.02) {
		return maskFromPixels(imageData, (r, g, b, a) => a > 128);
	}
	// 2) Opaque → flood the background in from the border by local similarity.
	const bgMask = new Uint8Array(total);
	const stack = [];
	const localTol = 26;
	const seed = (idx) => { if (!bgMask[idx]) { bgMask[idx] = 1; stack.push(idx); } };
	for (let x = 0; x < width; x++) { seed(x); seed((height - 1) * width + x); }
	for (let y = 0; y < height; y++) { seed(y * width); seed(y * width + width - 1); }
	while (stack.length) {
		const idx = stack.pop();
		const x = idx % width, y = (idx / width) | 0, o = idx * 4;
		const r = data[o], g = data[o + 1], b = data[o + 2];
		const nb = idx >= width ? idx - width : -1;
		const sb = y < height - 1 ? idx + width : -1;
		const wb = x > 0 ? idx - 1 : -1;
		const eb = x < width - 1 ? idx + 1 : -1;
		[nb, sb, wb, eb].forEach((nidx) => {
			if (nidx < 0 || bgMask[nidx]) return;
			const no = nidx * 4;
			if (colorDist(r, g, b, data[no], data[no + 1], data[no + 2]) < localTol) { bgMask[nidx] = 1; stack.push(nidx); }
		});
	}
	let area = 0, minX = width, minY = height, maxX = -1, maxY = -1;
	const mask = new Uint8Array(total);
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
		const idx = y * width + x;
		if (!bgMask[idx]) {
			mask[idx] = 1; area++;
			if (x < minX) minX = x; if (x > maxX) maxX = x;
			if (y < minY) minY = y; if (y > maxY) maxY = y;
		}
	}
	// Fallback: degenerate flood (subject touches every border, or near-uniform image).
	if (area < total * 0.008 || area > total * 0.97) {
		const corners = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1], [1, 1], [width - 2, 1], [1, height - 2], [width - 2, height - 2]];
		let br = 0, bgc = 0, bb = 0, n = 0;
		corners.forEach(([x, y]) => { if (x < 0 || y < 0 || x >= width || y >= height) return; const i = (y * width + x) * 4; br += data[i]; bgc += data[i + 1]; bb += data[i + 2]; n++; });
		br /= n; bgc /= n; bb /= n;
		const g2 = maskFromPixels(imageData, (r, g, b) => colorDist(r, g, b, br, bgc, bb) > 50);
		if (g2.area > total * 0.01 && g2.area < total * 0.97) return g2;
		// last resort: treat the whole frame as the silhouette (aspect still meaningful)
		return { mask: new Uint8Array(total).fill(1), width, height, bbox: { x: 0, y: 0, w: width, h: height }, area: total };
	}
	const bbox = maxX < 0 ? { x: 0, y: 0, w: 0, h: 0 } : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
	return { mask, width, height, bbox, area };
}

/**
 * Rasterise a mask into a WxH canvas, scaled so its bounding box height fills ~90%
 * and centred. This isolates SHAPE/proportion from where the silhouette happens to
 * sit (and at what zoom) in its source image. Inverse-mapped, so no holes.
 */
function normalizeMaskToBox(maskObj, W, H) {
	const out = new Uint8Array(W * H);
	const { mask, width, bbox } = maskObj;
	if (!bbox.w || !bbox.h) return out;
	const scale = (0.9 * H) / bbox.h;
	const outW = bbox.w * scale, outH = bbox.h * scale;
	const ox = (W - outW) / 2, oy = (H - outH) / 2;
	for (let dy = 0; dy < H; dy++) {
		for (let dx = 0; dx < W; dx++) {
			const sx = Math.floor(bbox.x + (dx - ox) / scale);
			const sy = Math.floor(bbox.y + (dy - oy) / scale);
			if (sx < bbox.x || sy < bbox.y || sx >= bbox.x + bbox.w || sy >= bbox.y + bbox.h) continue;
			if (mask[sy * width + sx]) out[dy * W + dx] = 1;
		}
	}
	return out;
}

/** Centroid of a normalized mask (0..1 in each axis), or null if empty. */
function maskCentroid(norm, W, H) {
	let sx = 0, sy = 0, n = 0;
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (norm[y * W + x]) { sx += x; sy += y; n++; }
	if (!n) return null;
	return { x: sx / n / W, y: sy / n / H, area: n };
}

/** Draw an image source into a target rect, letterboxed (preserve aspect). */
function drawFitted(ctx, img, dx, dy, dw, dh) {
	const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
	const s = Math.min(dw / iw, dh / ih);
	const w = iw * s, h = ih * s;
	ctx.drawImage(img, dx + (dw - w) / 2, dy + (dh - h) / 2, w, h);
}

/** Run a list of drawing operations against a 2D canvas context. */
function applyPaintOps(ctx, ops) {
	for (const op of ops) {
		const color = op.color || '#000000';
		ctx.fillStyle = color;
		ctx.strokeStyle = color;
		switch (op.type) {
			case 'pixel':
				ctx.fillRect(op.x | 0, op.y | 0, 1, 1);
				break;
			case 'rect':
				if (op.fill === false) {
					ctx.lineWidth = op.line_width || 1;
					ctx.strokeRect(op.x + 0.5, op.y + 0.5, op.width - 1, op.height - 1);
				} else {
					ctx.fillRect(op.x | 0, op.y | 0, op.width | 0, op.height | 0);
				}
				break;
			case 'line':
				ctx.lineWidth = op.line_width || 1;
				ctx.beginPath();
				ctx.moveTo(op.x1 + 0.5, op.y1 + 0.5);
				ctx.lineTo(op.x2 + 0.5, op.y2 + 0.5);
				ctx.stroke();
				break;
			case 'circle': {
				ctx.beginPath();
				ctx.arc(op.x, op.y, op.radius, 0, Math.PI * 2);
				if (op.fill === false) {
					ctx.lineWidth = op.line_width || 1;
					ctx.stroke();
				} else {
					ctx.fill();
				}
				break;
			}
			case 'fill_all':
				ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
				break;
			case 'clear':
				ctx.clearRect(op.x | 0, op.y | 0, (op.width | 0) || ctx.canvas.width, (op.height | 0) || ctx.canvas.height);
				break;
			case 'gradient': {
				const grad = ctx.createLinearGradient(op.x1 || 0, op.y1 || 0, op.x2 || 0, op.y2 || (ctx.canvas.height));
				(op.stops || [[0, '#000'], [1, '#fff']]).forEach((s) => grad.addColorStop(s[0], s[1]));
				ctx.fillStyle = grad;
				ctx.fillRect(op.x | 0, op.y | 0, (op.width | 0) || ctx.canvas.width, (op.height | 0) || ctx.canvas.height);
				break;
			}
			case 'ellipse': {
				const w = op.width || (op.radius ? op.radius * 2 : 2);
				const h = op.height || (op.radius ? op.radius * 2 : 2);
				const cx = (op.x || 0) + w / 2, cy = (op.y || 0) + h / 2;
				ctx.beginPath();
				ctx.ellipse(cx, cy, Math.max(0.5, w / 2), Math.max(0.5, h / 2), 0, 0, Math.PI * 2);
				if (op.fill === false) { ctx.lineWidth = op.line_width || 1; ctx.stroke(); }
				else ctx.fill();
				break;
			}
			case 'polygon': {
				const pts = op.points || [];
				if (pts.length < 2) break;
				ctx.beginPath();
				ctx.moveTo(pts[0][0] + 0.5, pts[0][1] + 0.5);
				for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] + 0.5, pts[i][1] + 0.5);
				ctx.closePath();
				if (op.fill === false) { ctx.lineWidth = op.line_width || 1; ctx.stroke(); }
				else ctx.fill();
				break;
			}
			case 'dither': {
				const x = op.x | 0, y = op.y | 0, w = (op.width | 0) || ctx.canvas.width, h = (op.height | 0) || ctx.canvas.height;
				const c1 = op.color || '#000000', c2 = op.color2 || op.color || '#ffffff';
				const dens = op.density != null ? Number(op.density) : 1;
				for (let yy = 0; yy < h; yy++) {
					for (let xx = 0; xx < w; xx++) {
						const on = ((xx + yy) & 1) === 0;
						if (on && dens < 1 && Math.random() > dens) continue;
						ctx.fillStyle = on ? c1 : c2;
						if (on || op.color2) ctx.fillRect(x + xx, y + yy, 1, 1);
					}
				}
				break;
			}
			case 'noise': {
				const x = op.x | 0, y = op.y | 0;
				const w = (op.width | 0) || ctx.canvas.width, h = (op.height | 0) || ctx.canvas.height;
				const amt = op.amount != null ? Number(op.amount) : 0.12;
				const seed = op.color ? parseColor(op.color) : null;
				const img = ctx.getImageData(x, y, w, h);
				const d = img.data;
				const mono = op.mono !== false;
				for (let i = 0; i < d.length; i += 4) {
					if (seed) { d[i] = seed.r; d[i + 1] = seed.g; d[i + 2] = seed.b; d[i + 3] = 255; }
					else if (d[i + 3] === 0) continue;
					if (mono) {
						const j = (Math.random() * 2 - 1) * amt * 255;
						d[i] = clamp8(d[i] + j); d[i + 1] = clamp8(d[i + 1] + j); d[i + 2] = clamp8(d[i + 2] + j);
					} else {
						d[i] = clamp8(d[i] + (Math.random() * 2 - 1) * amt * 255);
						d[i + 1] = clamp8(d[i + 1] + (Math.random() * 2 - 1) * amt * 255);
						d[i + 2] = clamp8(d[i + 2] + (Math.random() * 2 - 1) * amt * 255);
					}
				}
				ctx.putImageData(img, x, y);
				break;
			}
			default:
				throw new Error('Unknown paint op: ' + op.type);
		}
	}
}

// ---------------------------------------------------------------------------
// Quality helpers: UV packing, box blur, region colours
// ---------------------------------------------------------------------------

/** Box-UV footprint of a cube in texture pixels: 2*(w+d) wide, (h+d) tall. */
function boxUVFootprint(cube) {
	const w = Math.ceil(Math.abs(cube.to[0] - cube.from[0]) + (cube.inflate ? 0 : 0));
	const h = Math.ceil(Math.abs(cube.to[1] - cube.from[1]));
	const d = Math.ceil(Math.abs(cube.to[2] - cube.from[2]));
	return { w: Math.max(1, 2 * (w + d)), h: Math.max(1, h + d) };
}

/**
 * Shelf-pack the box UV of the given cubes so no two share the same pixels.
 * Sets each cube's uv_offset and recomputes its 6 face UVs. Returns the used
 * extent so the caller can grow the texture if it overflowed.
 */
function packBoxUV(cubes, texW, pad) {
	pad = pad == null ? 1 : pad;
	const items = cubes
		.filter((c) => c instanceof Cube)
		.map((c) => ({ c, f: boxUVFootprint(c) }))
		.sort((a, b) => b.f.h - a.f.h); // tallest first packs tighter
	let x = 0, y = 0, rowH = 0, maxX = 0;
	for (const it of items) {
		if (x + it.f.w + pad > texW && x > 0) { x = 0; y += rowH + pad; rowH = 0; }
		it.c.box_uv = true;
		it.c.uv_offset = [x, y];
		if (it.c.mapAutoUV) it.c.mapAutoUV();
		x += it.f.w + pad;
		rowH = Math.max(rowH, it.f.h);
		maxX = Math.max(maxX, x);
	}
	return { packed: items.length, used: [maxX, y + rowH] };
}

/** In-place 3x3 box blur of a texture rect, blended by `amt` (0..1). The "smooth brush". */
function blurRect(ctx, rx, ry, rw, rh, amt) {
	if (rw < 2 || rh < 2 || amt <= 0) return;
	const src = ctx.getImageData(rx, ry, rw, rh);
	const s = src.data;
	const out = ctx.createImageData(rw, rh);
	const d = out.data;
	for (let y = 0; y < rh; y++) {
		for (let x = 0; x < rw; x++) {
			let R = 0, G = 0, B = 0, A = 0, N = 0;
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					const xx = x + dx, yy = y + dy;
					if (xx < 0 || yy < 0 || xx >= rw || yy >= rh) continue;
					const i = (yy * rw + xx) * 4;
					R += s[i]; G += s[i + 1]; B += s[i + 2]; A += s[i + 3]; N++;
				}
			}
			const o = (y * rw + x) * 4;
			d[o] = clamp8(s[o] * (1 - amt) + (R / N) * amt);
			d[o + 1] = clamp8(s[o + 1] * (1 - amt) + (G / N) * amt);
			d[o + 2] = clamp8(s[o + 2] * (1 - amt) + (B / N) * amt);
			d[o + 3] = clamp8(s[o + 3] * (1 - amt) + (A / N) * amt);
		}
	}
	ctx.putImageData(out, rx, ry);
}

/**
 * Pick a base colour for a cube by name. `colorMap` is an array of
 * { match, color } where `match` is a regex source tested (case-insensitively)
 * against the cube name; first hit wins, else `base`.
 */
function regionColorFor(name, colorMap, base) {
	if (Array.isArray(colorMap)) {
		for (const rule of colorMap) {
			if (!rule || !rule.match || !rule.color) continue;
			try { if (new RegExp(rule.match, 'i').test(name)) return rule.color; } catch (e) {}
		}
	} else if (colorMap && typeof colorMap === 'object') {
		for (const key in colorMap) {
			try { if (new RegExp(key, 'i').test(name)) return colorMap[key]; } catch (e) {}
		}
	}
	return base;
}

// ---------------------------------------------------------------------------
// VFX texture generation — pixelated flames / energy / crystals / smoke, with
// optional multi-frame flipbook animation. The look: a bright hot core fading
// to cool edges in QUANTIZED colour bands (the pixel-art step look), jagged
// transparent edges, animated by scrolling/flickering value noise per frame.
// ---------------------------------------------------------------------------

const VFX_PALETTES = {
	fire:   ['#fff7da', '#ffe24a', '#ff9d2f', '#ff5a1f', '#b81e0c'],
	ember:  ['#fff0c0', '#ffb43a', '#ff6a1f', '#9c2a0c'],
	ice:    ['#ffffff', '#dcf4ff', '#8cd8ff', '#3aa6ff', '#1546c8'],
	frost:  ['#ffffff', '#e2f7ff', '#a6e2ff', '#5fb6ff'],
	energy: ['#ffffff', '#ccffff', '#5ff0ff', '#22b6ff', '#0a5fd6'],
	arcane: ['#ffffff', '#f0d0ff', '#c07bff', '#7a1fd0', '#380a66'],
	poison: ['#f2ffd6', '#b6ff5a', '#46c41e', '#176b12'],
	shadow: ['#cfa6ff', '#8a4af0', '#4a14a0', '#16052e'],
	holy:   ['#ffffff', '#fff4c0', '#ffd24a', '#ff9e1f'],
	smoke:  ['#e8e8e8', '#acacac', '#6c6c6c', '#343434'],
	blood:  ['#ff7a7a', '#e02020', '#9c0c0c', '#4a0606'],
	nature: ['#eaffc8', '#9fe05a', '#4faa2e', '#1f6b1a'],
};

function vfxHash(x, y, seed) {
	const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
	return n - Math.floor(n);
}
function vfxNoise(x, y, seed) {
	const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
	const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
	const a = vfxHash(xi, yi, seed), b = vfxHash(xi + 1, yi, seed);
	const c = vfxHash(xi, yi + 1, seed), e = vfxHash(xi + 1, yi + 1, seed);
	return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + e * u * v;
}
function vfxFractal(x, y, seed) {
	return vfxNoise(x, y, seed) * 0.6 + vfxNoise(x * 2.1, y * 2.1, seed + 5) * 0.3 + vfxNoise(x * 4.3, y * 4.3, seed + 11) * 0.1;
}

/**
 * Intensity field for a VFX style at pixel (px,py) in a w x h frame, at phase
 * t (0..1 across the flipbook) and a noise `seed`. Returns intensity 0..1, or
 * < 0 for a hard-transparent pixel (outside the shape).
 */
function vfxField(style, px, py, w, h, t, seed) {
	const u = w > 1 ? px / (w - 1) : 0.5;     // 0..1 left->right
	const v = h > 1 ? py / (h - 1) : 0.5;     // 0..1 top->bottom
	const xc = (u - 0.5) * 2;                  // -1..1
	const yc = (v - 0.5) * 2;                  // -1..1
	const r = Math.hypot(xc, yc);
	switch (style) {
		case 'flame': case 'fire': {
			const sway = (vfxFractal(t * 1.5 + 3, (1 - v) * 3, seed) - 0.5) * (1 - v) * 0.8;
			const cx = xc - sway;
			const halfW = 0.16 + v * 0.74;                 // narrow at top, wide at base
			const body = 1 - Math.abs(cx) / halfW;
			if (body <= 0) return -1;
			const turb = vfxFractal(u * 4, (1 - v) * 4 - t * 6, seed);
			const inten = body * (0.32 + 0.68 * v) * (0.55 + 0.8 * turb);
			if (inten < 0.2 + (1 - v) * 0.32) return -1;   // erode top into tongues
			return Math.min(1, inten);
		}
		case 'orb': case 'glow': {
			const inten = 1 - r;
			return inten <= 0 ? -1 : inten;
		}
		case 'energy': case 'plasma': {
			const ang = Math.atan2(yc, xc);
			const spikes = vfxFractal(ang / Math.PI * 7 + t * 4, r * 3 + t * 2, seed);
			const edge = 0.5 + spikes * 0.5;
			let inten = (edge - r) / edge;
			inten += Math.max(0, 0.35 - r) * 1.6;          // hot core
			return inten <= 0.06 ? -1 : Math.min(1, inten);
		}
		case 'spark': case 'star': {
			const ax = Math.abs(xc), ay = Math.abs(yc);
			const horiz = (1 - ax) * Math.max(0, 1 - ay * 6);
			const vert = (1 - ay) * Math.max(0, 1 - ax * 6);
			const diag = Math.max(0, 0.5 - r) * 0.8;
			const inten = Math.max(horiz, vert) + diag;
			return inten <= 0.08 ? -1 : Math.min(1, inten);
		}
		case 'smoke': case 'cloud': {
			const cloud = vfxFractal(u * 3 + t * 1.5, v * 3 - t, seed);
			const inten = cloud * (1 - r * 0.9) * 1.3;
			return inten <= 0.28 ? -1 : Math.min(1, inten);
		}
		case 'trail': case 'streak': {
			// head bright at the RIGHT (u=1), tapering to the left tail
			const widen = 0.12 + (1 - u) * 0.5;
			const line = 1 - Math.abs(yc) / widen;
			if (line <= 0) return -1;
			const dash = vfxFractal(u * 6 - t * 5, v * 2, seed);
			const inten = line * (0.2 + 0.9 * u) * (0.5 + dash);
			return inten <= 0.16 ? -1 : Math.min(1, inten);
		}
		case 'beam': case 'beam_v': {
			const dx = Math.abs(xc);
			const flick = 0.7 + vfxFractal(0, v * 5 - t * 6, seed) * 0.6;
			const inten = (1 - dx / 0.55) * flick;
			return inten <= 0.12 ? -1 : Math.min(1, inten);
		}
		case 'beam_h': {
			const dy = Math.abs(yc);
			const flick = 0.7 + vfxFractal(u * 5 - t * 6, 0, seed) * 0.6;
			const inten = (1 - dy / 0.55) * flick;
			return inten <= 0.12 ? -1 : Math.min(1, inten);
		}
		case 'bolt': case 'lightning': {
			const path = (vfxFractal(0, v * 6 + t * 4, seed) - 0.5) * 1.1;
			const dx = Math.abs(xc - path);
			const inten = 1 - dx / 0.16;
			return inten <= 0.15 ? -1 : Math.min(1, inten);
		}
		case 'rune': case 'ring': {
			const ringR = 0.7;
			const d = Math.abs(r - ringR);
			const inten = 1 - d / 0.18;
			return inten <= 0.12 ? -1 : Math.min(1, inten);
		}
		case 'crystal': case 'gem': {
			// opaque faceted diamond — for the body of an ice shard / gem
			const dist = Math.abs(xc) + Math.abs(yc);     // diamond
			if (dist > 1) return -1;
			const facet = Math.floor((1 - dist) * 4) / 4;
			const streak = (vfxFractal(u * 3, v * 4, seed) - 0.5) * 0.18;
			return Math.max(0, Math.min(1, 0.25 + facet * 0.85 + streak));
		}
		case 'shockwave': {
			const ringR = t * 0.95 + 0.05;
			const d = Math.abs(r - ringR);
			const inten = (1 - d / (0.12 + t * 0.1)) * (1 - t * 0.6);
			return inten <= 0.12 ? -1 : Math.min(1, inten);
		}
		default: {
			const inten = 1 - r;
			return inten <= 0 ? -1 : inten;
		}
	}
}

const VFX_OPAQUE = { crystal: true, gem: true };

/** Map intensity (1 = hottest core) to a quantized palette colour. */
function vfxColorAt(palette, inten) {
	const n = palette.length;
	let idx = Math.floor((1 - inten) * n);
	if (idx < 0) idx = 0; else if (idx >= n) idx = n - 1;
	return parseColor(palette[idx]);
}

/** Render one VFX frame into an existing ctx at (ox,oy), size w x h. */
function drawVfxFrame(ctx, ox, oy, w, h, style, palette, t, seed, opaque, softEdge) {
	const img = ctx.createImageData(w, h);
	const d = img.data;
	for (let py = 0; py < h; py++) {
		for (let px = 0; px < w; px++) {
			const inten = vfxField(style, px, py, w, h, t, seed);
			const o = (py * w + px) * 4;
			if (inten < 0) { d[o + 3] = 0; continue; }
			const c = vfxColorAt(palette, inten);
			d[o] = c.r; d[o + 1] = c.g; d[o + 2] = c.b;
			// Crisp pixel alpha by default; optionally fade the coolest band a little.
			d[o + 3] = opaque ? 255 : (softEdge && inten < 0.25 ? 150 : 255);
		}
	}
	ctx.putImageData(img, ox, oy);
}

/**
 * Build a VFX canvas. With frames>1 it stacks the frames vertically into a
 * Blockbench flipbook (height = h*frames; Blockbench shows one h-tall frame and
 * animates through them when TextureAnimator is running).
 */
function buildVfxCanvas(w, h, frames, style, palette, seed, softEdge) {
	const opaque = !!VFX_OPAQUE[style];
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h * Math.max(1, frames);
	const ctx = c.getContext('2d');
	ctx.imageSmoothingEnabled = false;
	for (let i = 0; i < Math.max(1, frames); i++) {
		const t = frames > 1 ? i / frames : 0;
		drawVfxFrame(ctx, 0, i * h, w, h, style, palette, t, seed, opaque, softEdge);
	}
	return c;
}

// ---------------------------------------------------------------------------
// Mesh primitives — non-cuboid geometry (crystals, blades, cones, prisms…) so
// models aren't limited to axis-aligned boxes. Returns vertices in a [0..w/h/d]
// box and faces as arrays of vertex indices (3 or 4 per face).
// ---------------------------------------------------------------------------

function meshPrimitive(shape, w, h, d, segments) {
	const n = Math.max(3, segments || 8);
	const verts = [];
	const faces = [];
	const V = (x, y, z) => { verts.push([x, y, z]); return verts.length - 1; };
	const cx = w / 2, cz = d / 2, rx = w / 2, rz = d / 2;
	switch (shape) {
		case 'plane': {
			const a = V(0, 0, 0), b = V(w, 0, 0), c = V(w, h, 0), e = V(0, h, 0);
			faces.push([a, b, c, e]);
			break;
		}
		case 'pyramid': {
			const b0 = V(0, 0, 0), b1 = V(w, 0, 0), b2 = V(w, 0, d), b3 = V(0, 0, d);
			const ap = V(cx, h, cz);
			faces.push([b3, b2, b1, b0]);                 // base (downward)
			faces.push([b0, b1, ap], [b1, b2, ap], [b2, b3, ap], [b3, b0, ap]);
			break;
		}
		case 'wedge': case 'prism': {
			const b0 = V(0, 0, 0), b1 = V(w, 0, 0), b2 = V(w, 0, d), b3 = V(0, 0, d);
			const t0 = V(0, h, cz), t1 = V(w, h, cz);
			faces.push([b3, b2, b1, b0]);                 // bottom
			faces.push([b0, b1, t1, t0]);                 // front slope (z=0)
			faces.push([b2, b3, t0, t1]);                 // back slope (z=d)
			faces.push([b0, b3, t0], [b2, b1, t1]);       // triangular end caps (x=0, x=w)
			break;
		}
		case 'octahedron': case 'crystal': case 'gem': case 'shard': case 'diamond': {
			const my = h * (shape === 'shard' ? 0.4 : 0.5);  // longer top point for a shard
			const top = V(cx, h, cz), bot = V(cx, 0, cz);
			const m0 = V(0, my, cz), m1 = V(cx, my, d), m2 = V(w, my, cz), m3 = V(cx, my, 0);
			faces.push([top, m0, m1], [top, m1, m2], [top, m2, m3], [top, m3, m0]);
			faces.push([bot, m1, m0], [bot, m2, m1], [bot, m3, m2], [bot, m0, m3]);
			break;
		}
		case 'cone': {
			const ap = V(cx, h, cz), center = V(cx, 0, cz);
			const ring = [];
			for (let i = 0; i < n; i++) {
				const a = (i / n) * Math.PI * 2;
				ring.push(V(cx + Math.cos(a) * rx, 0, cz + Math.sin(a) * rz));
			}
			for (let i = 0; i < n; i++) {
				const a = ring[i], b = ring[(i + 1) % n];
				faces.push([a, b, ap]);
				faces.push([b, a, center]);
			}
			break;
		}
		case 'cylinder': {
			const topC = V(cx, h, cz), botC = V(cx, 0, cz);
			const top = [], bot = [];
			for (let i = 0; i < n; i++) {
				const a = (i / n) * Math.PI * 2;
				const x = cx + Math.cos(a) * rx, z = cz + Math.sin(a) * rz;
				top.push(V(x, h, z)); bot.push(V(x, 0, z));
			}
			for (let i = 0; i < n; i++) {
				const j = (i + 1) % n;
				faces.push([bot[i], bot[j], top[j], top[i]]);  // side
				faces.push([top[j], top[i], topC]);            // top cap
				faces.push([bot[i], bot[j], botC]);            // bottom cap
			}
			break;
		}
		default:
			throw new Error('Unknown mesh shape: ' + shape + ' (plane|pyramid|wedge|prism|crystal|shard|cone|cylinder)');
	}
	return { verts, faces };
}

/**
 * Planar-project a mesh face's UVs into a texture rect [x1,y1,x2,y2] (uv units).
 * Each face fills the rect by mapping its two dominant in-plane axes to u,v —
 * good enough for solid / gradient VFX skins without manual unwrapping.
 */
function setMeshFaceUV(mesh, face, rect) {
	const vk = face.vertices;
	const pos = vk.map((k) => mesh.vertices[k]);
	const e1 = [pos[1][0] - pos[0][0], pos[1][1] - pos[0][1], pos[1][2] - pos[0][2]];
	const p2 = pos[2] || pos[0];
	const e2 = [p2[0] - pos[0][0], p2[1] - pos[0][1], p2[2] - pos[0][2]];
	const nrm = [
		Math.abs(e1[1] * e2[2] - e1[2] * e2[1]),
		Math.abs(e1[2] * e2[0] - e1[0] * e2[2]),
		Math.abs(e1[0] * e2[1] - e1[1] * e2[0]),
	];
	let a = 0, b = 1;
	if (nrm[0] >= nrm[1] && nrm[0] >= nrm[2]) { a = 2; b = 1; }
	else if (nrm[1] >= nrm[0] && nrm[1] >= nrm[2]) { a = 0; b = 2; }
	else { a = 0; b = 1; }
	let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
	pos.forEach((pp) => {
		minA = Math.min(minA, pp[a]); maxA = Math.max(maxA, pp[a]);
		minB = Math.min(minB, pp[b]); maxB = Math.max(maxB, pp[b]);
	});
	const spanA = (maxA - minA) || 1, spanB = (maxB - minB) || 1;
	const uv = {};
	vk.forEach((k, i) => {
		uv[k] = [
			rect[0] + ((pos[i][a] - minA) / spanA) * (rect[2] - rect[0]),
			rect[1] + ((pos[i][b] - minB) / spanB) * (rect[3] - rect[1]),
		];
	});
	face.uv = uv;
}

// ---------------------------------------------------------------------------
// Modeling playbook (returned by get_guide / referenced by tool descriptions)
// ---------------------------------------------------------------------------

const MODELING_GUIDE = [
	'BLOCKBENCH MODELING PLAYBOOK — read before building any model. Other topics:',
	'get_guide {topic:"detailing"|"orientation"|"rigging"|"texturing"|"vfx"|"animation"|',
	'"review"|"reference"}. Read "detailing" for the cube budget and the 4-layer doctrine',
	'before anything with a costume, armour, cloth or a weapon. If the model will be animated, read "rigging" BEFORE placing cubes,',
	'and "orientation" before anything that has a left and a right.',
	'',
	'GOLDEN WORKFLOW (loop it, do not one-shot):',
	'  get_reference (look at what you must match) -> get_status -> plan bones &',
	'  proportions -> add_groups -> add_cubes -> compare_reference (SCORE the silhouette)',
	'  -> fix the biggest delta -> compare_reference again ... THEN pack_uv -> create_texture',
	'  -> detail_cubes -> paint_faces -> screenshot_views -> check_model -> FIX -> repeat.',
	'Do at least 2-3 passes. The first pass is NEVER good enough — plan to redo it.',
	'',
	'0. GROUND YOURSELF IN THE REFERENCE. If a reference image was provided (dropped in',
	'   the MCP Copilot panel, or via load_reference), call get_reference and LOOK at it.',
	'   Then build, and use compare_reference EVERY pass — it renders your model from the',
	'   reference angle and returns a hard match_percent (silhouette IoU) plus a side-by-',
	'   side overlay. Do not trust your own "looks close" — trust the number. See',
	'   get_guide {topic:"reference"}.',
	'',
	'1. SILHOUETTE FIRST. Build the grey shape and compare_reference it BEFORE texturing.',
	'   A great texture cannot rescue wrong proportions. Match the reference silhouette:',
	'   overall stance, head size/position, limb length. Aim for match_percent >= 85.',
	'',
	'2. PART COUNT & DETAIL. BUDGET: simple prop 30-60 cubes, standard mob/NPC 100-180,',
	'   hero/boss 180-300+. A humanoid under ~70 cubes is a draft, not a model, and does',
	'   NOT go to texturing — audit_complexity is the gate and it says so. Break every',
	'   limb into 3 segments, give the head a separate snout/brow/jaw, and build in',
	'   LAYERS: primary mass, then secondary volumes standing 0.3-0.8 proud of it, then',
	'   fringes and silhouette breakers, then 1x1 micro-detail. Do not hand-compute',
	'   hundreds of boxes: add_hollow_volume (shells: hoods, helmets, armour),',
	'   generate_array (rows: hems, scales, plates, teeth, rivets), extrude_chain (horns,',
	'   tails, tentacles), voxelize_matrix (blades, emblems, flat detail from a character',
	'   grid). Full doctrine: get_guide {topic:"detailing"}.',
	'',
	'3. ROTATION & TAPER make shapes organic. Cubes AND bones take rotation:[x,y,z].',
	'   - A single cube rotates cleanly on ONE axis; for a compound angle put it in a',
	'     GROUP and rotate the group, or nest groups. Build each limb as a bone at the',
	'     JOINT origin and rotate the bone to pose it.',
	'   - inflate (small +/-) rounds/shrinks a cube in place. Taper limbs by shrinking',
	'     each segment.',
	'   - A cube rotated 45° reads as a crystal/diamond/blade — use this for non-boxy',
	'     shapes in cube formats. For true non-cuboid shapes use add_mesh.',
	'',
	'3b. AVOID Z-FIGHTING / CLIPPING (the flickering "two squares inside one another").',
	'   It happens when two faces sit on the SAME plane at the same depth. Rules:',
	'   - When two cubes overlap, make one clearly PENETRATE the other (by >=0.1, ideally',
	'     ~0.5) so no faces are coplanar — never align two faces to the exact same coord.',
	'   - Decorative pieces (leaves, scales, plates, fur, trim) must NOT sit flush on a',
	'     surface: push each out by a small UNIQUE amount and stagger neighbours\' depths',
	'     so no two share a plane. Vary by 0.05-0.2 between adjacent pieces.',
	'   - Two billboard PLANES must never share the exact same position — offset by >=0.1.',
	'   - check_model reports `coplanar_overlap` pairs; fix every one by nudging a cube.',
	'',
	'4. SYMMETRY. Build one side, then mirror_element {axis:"x"} (or emit the mirror in',
	'   the same add_cubes call: negate X of from/to, swap so from<to, negate Y/Z',
	'   rotation signs). Keep paired bones named *_left / *_right.',
	'',
	'5. TEXTURE SMOOTH, not flat. pack_uv FIRST (box UV does not auto-pack), then',
	'   detail_cubes for a smooth shaded base on every face (no gaps), then paint_faces',
	'   for crisp features. See get_guide {topic:"texturing"}.',
	'',
	'6. REVIEW HONESTLY. screenshot_views every pass; check_model for untextured faces /',
	'   bad UVs / unparented cubes / left-right mistakes. If a screenshot looks wrong,',
	'   FIX it — never call a visible flaw "acceptable" or "close enough".',
	'',
	'7. THEN ASK THE USER. Your own opinion of your own screenshot is not verification.',
	'   At the end of a blockout, a texture pass or an animation, call request_review —',
	'   it shows the user labelled renders inside Blockbench and waits for their verdict',
	'   before you continue. See get_guide {topic:"review"}.',
	'',
	'8. LEFT AND RIGHT are the model\'s own, not the viewer\'s: the model faces -Z, so its',
	'   RIGHT is +X and a front-view render shows it MIRRORED. Pass side:"left"/"right"',
	'   to add_cube(s)/add_group and let the tool police it; verify with check_sides.',
	'   See get_guide {topic:"orientation"}.',
	'',
	'Animation formats (GeckoLib/Bedrock): every cube must live under a bone; bone',
	'origins must sit at the real joint; limbs need 3 segments so elbows and knees can',
	'bend (create_rig does all of this). GeckoLib store id "geckolib", format',
	'"geckolib_model". Meshes do NOT export to GeckoLib/Java — use rotated cubes there.',
].join('\n');

const TEXTURING_GUIDE = [
	'BLOCKBENCH TEXTURING PLAYBOOK — the smooth, Hytale/@volmur look (not dirty/noisy).',
	'',
	'ORDER: pack_uv -> create_texture -> detail_cubes (smooth base) -> paint_faces',
	'(crisp features) -> get_texture to inspect -> fix.',
	'',
	'1. PACK UV FIRST. New box-UV cubes all sit at uv_offset [0,0] and share the same',
	'   pixels. Call pack_uv before painting and again after adding/resizing cubes, or',
	'   every face paints onto the same spot. It auto-grows the texture if needed.',
	'',
	'2. SIZE. 64px for simple, 128px typical, 256px for very detailed. Square.',
	'',
	'3. SMOOTH BASE COAT — detail_cubes. It bakes, per face: a soft vertical gradient in',
	'   the base colour + gentle directional shading (top lighter, underside darker) +',
	'   a SUBTLE low-contrast mottle, then a 3x3 box blur per UV island (the "smooth',
	'   brush"). This is the difference between good and bad textures. Tips:',
	'   - Use the `colors` map to colour regions by cube name, e.g.',
	'     colors:[{match:"leg|paw",color:"#5a3d22"},{match:"belly",color:"#3a2a18"}].',
	'     Bodies/limbs are often the SAME tone as the head with darker extremities —',
	'     do not default everything to one brown.',
	'   - Keep noise LOW (0.04-0.08). Do NOT raise edge_darken (a dark outline on every',
	'     face reads as a dirty grid — the look to avoid). streaks:true adds fur/wood/',
	'     stone grain on top/back faces.',
	'   - Glow parts (eyes cores, gems, lanterns, runes): name them *_core or *_glow —',
	'     detail_cubes fills them bright with no shading/blur. Mark the texture emissive',
	'     with set_texture_render_mode for real in-engine glow.',
	'',
	'4. CRISP FEATURES — paint_faces, AFTER the bake (so blur does not soften them).',
	'   Coords are RELATIVE to each face ([0,0] = its top-left). Eyes are the #1 thing',
	'   that makes a creature read as alive: dark socket rect, bright iris, 1px hotspot.',
	'   Also nose, mouth, claws, stripes, scars, armour trim, rune lines. Ops: rect,',
	'   ellipse, polygon, line, gradient, dither (patterns), noise.',
	'',
	'5. INSPECT. get_texture shows the sheet; screenshot_views shows it on the model.',
	'   Compare to the reference palette. Recolour with detail_cubes `colors` and repeat.',
].join('\n');

const VFX_GUIDE = [
	'BLOCKBENCH PIXEL-VFX PLAYBOOK — flames, energy, projectiles, slashes, trails, auras.',
	'The look: layered emissive PIXEL shapes, a bright hot core fading to cool edges,',
	'jagged stepped silhouettes, animated. Built from PLANES + emissive textures, posed',
	'and animated with bones. (Think the homegaddiel magma fire / a glowing ice shard.)',
	'',
	'CORE IDEA: a VFX is a few flat 2-sided PLANES carrying transparent emissive pixel',
	'textures, layered and crossed for volume, then animated (scale/position/rotation/',
	'flipbook). Bright additive layers stack into a glow.',
	'',
	'1. BUILD THE PLANES — add_plane {from,width,height,facing,crossed}. Make a flame/',
	'   energy sheet as 2-3 stacked planes at slightly different depths, or crossed:true',
	'   for a volumetric particle. Parent them to a bone so you can animate them.',
	'   For a solid glowing core (orb, gem, shard) use a small cube or add_mesh',
	'   {shape:"crystal"|"shard"} (or, in GeckoLib, a cube rotated 45°).',
	'',
	'2. MAKE THE TEXTURE — create_vfx_texture {style,preset,frames}. Styles: flame,',
	'   energy, orb/glow, spark/star, smoke, trail/streak, beam, bolt/lightning, ring,',
	'   shockwave, crystal. Presets (palettes): fire, ember, ice, frost, energy, arcane,',
	'   poison, shadow, holy, smoke, blood, nature. It defaults to ADDITIVE (flames/',
	'   energy) or EMISSIVE (crystals) render mode + 2-sided, so it glows. For a looping',
	'   animated effect set frames:4-8 — it bakes a vertical flipbook and starts the',
	'   animation player. Tune speed with frame_time (lower=faster).',
	'',
	'3. LAYER FOR DEPTH. Stack a wide dim outer glow + a brighter narrower mid + a small',
	'   white-hot core (3 planes, additive). Cooler/darker = bigger & behind; hotter =',
	'   smaller & in front. This is what makes pixel fire/energy look rich, not flat.',
	'',
	'4. EMISSIVE/ADDITIVE — set_texture_render_mode {render_mode:"additive"|"emissive",',
	'   render_sides:"double"}. additive = bright pixels add light & dark vanishes (best',
	'   for fire/energy on planes); emissive = full-bright, ignores scene light (solid',
	'   gems/runes). Always render_sides:"double" for planes.',
	'',
	'5. ANIMATE (the life of a VFX). Use create_animation + add_keyframes on the planes/',
	'   bones:',
	'   - FLICKER: small fast scale Y (1.0->1.15->0.95) + tiny position jitter, looped.',
	'   - PROJECTILE (ice shard / fireball): a solid core + a TRAIL. Trail = a row of',
	'     planes/cubes behind the core, each scaling down and fading (scale->0) on a',
	'     staggered delay so it streaks; or one "trail" plane stretched on the travel',
	'     axis. The whole group flies via position; spin the core (rotation) for energy.',
	'   - SLASH: an arc plane that sweeps (rotation) and quickly scales up then fades.',
	'   - BURST/IMPACT: a shockwave ring (style:"shockwave", or a ring plane scaling out',
	'     while fading) + outward spark planes.',
	'   Fade by scaling to 0 (GeckoLib has no opacity channel); flipbook frames also',
	'   carry motion. Use linear for snappy pops, catmullrom for smooth pulses.',
	'',
	'6. REVIEW with screenshot_views from a few angles and against the reference. Check',
	'   the core reads hottest, edges are jagged pixels (not smooth), and it glows.',
].join('\n');

const ANIMATION_GUIDE = [
	'BLOCKBENCH ANIMATION PLAYBOOK (GeckoLib/Bedrock). Read get_guide {topic:"rigging"}',
	'and {topic:"orientation"} FIRST — a bad rig or a flipped axis cannot be animated out.',
	'',
	'THE LOOP (never skip a step):',
	'  check_rig -> generate_animation (correct base cycle) -> analyze_animation (MEASURE',
	'  it) -> fix -> add_keyframes to refine -> preview_animation -> request_review (the',
	'  USER confirms) -> only then move on.',
	'Budget real time per animation. One pass is never enough; 3-4 passes is normal.',
	'',
	'1. AXIS SIGNS — the reason attacks end up swinging into the model\'s back.',
	'   +X rotation turns a bone so its FRONT face goes UP. Consequences:',
	'     - a bone pointing DOWN (arm, leg) swings its tip FORWARD with +X;',
	'     - a bone pointing UP (torso, neck, head) tips BACKWARD with +X;',
	'     - ELBOWS bend +X (hand comes forward), KNEES bend -X (heel goes back);',
	'   +Y turns the model toward its own LEFT. +Z tips a bone\'s top toward its LEFT.',
	'   Never guess a sign: generate_animation already knows them, and',
	'   analyze_animation measures where the hand actually ended up.',
	'',
	'2. NEVER TRUST YOUR OWN EYE ON A RENDER. analyze_animation evaluates the rig and',
	'   reports, per hand/foot/head, how far it travels FORWARD/BACK/LEFT/RIGHT/UP in the',
	'   model\'s own axes, whether the loop closes, and whether the lower limb segments',
	'   move at all. A strike that measures "backward 6.2, forward 0" is wrong no matter',
	'   how good the screenshot looks.',
	'',
	'3. BONES: limbs need THREE segments (upper / lower / hand-or-foot). With two there',
	'   is no elbow or knee and every cycle looks like cardboard. check_rig reports this;',
	'   create_rig builds it correctly. Animate the LOWER segments too — that is the',
	'   single biggest difference between amateur and good animation.',
	'',
	'4. KEYFRAME DENSITY: a cycle wants 6-9 keyframes per moving bone (not 2), and the',
	'   whole body moving, not just the limb that "does" the action: hips bob and twist,',
	'   chest counter-rotates, neck/head stabilise, tail/cloak lag behind by 0.1-0.2s.',
	'   Use add_keyframes {close_loop:true} so the first and last poses match exactly.',
	'',
	'5. TIMING & EASING: catmullrom for swings and settles, linear for the snap of an',
	'   impact, step for instant changes. Anticipation before a strike (wind back ~25% of',
	'   the length), contact HOLD of 2-3 frames at the hit, then a slower recovery.',
	'   Typical lengths: idle 3-5s, walk 0.9-1.1s, run 0.55-0.7s, attack 0.7-0.9s.',
	'',
	'6. CYCLES: walk = arms and legs opposite (right arm with LEFT leg), two body bobs',
	'   per cycle, hips and chest counter-rotating. Run = bigger swing, forward lean, air',
	'   time. Quadruped = diagonal gait (front-right with back-left), NOT a front-pair /',
	'   back-pair bound, which reads as a march.',
	'',
	'7. SHOW YOUR WORK: preview_animation renders labelled poses; request_review puts them',
	'   in front of the user and waits for their verdict. Do not describe an animation as',
	'   good, finished or working until the user has said so.',
	'',
	'VFX animation: see get_guide {topic:"vfx"} — scale/position pulses, trails that',
	'scale to 0, spinning cores, sweeping slashes, expanding shockwaves.',
].join('\n');

const ORIENTATION_GUIDE = [
	'ORIENTATION — WHICH SIDE IS LEFT? (read before rigging, posing or attaching items)',
	'',
	'THE RULE: a Minecraft-style model FACES -Z. Its own RIGHT is +X, its own LEFT is -X.',
	'Call get_orientation for the live values (formats can declare a different facing).',
	'',
	'WHY IT GOES WRONG: a render taken from the front shows the model MIRRORED, exactly',
	'like standing in front of a person — their right hand is on your left. An AI that',
	'looks at that image and says "the sword is on the right" is wrong 100% of the time.',
	'Every screenshot from this plugin is now stamped with which image edge is the',
	'model\'s right, and there is a tool for the question:',
	'  - get_orientation  -> the axis rules for this project',
	'  - which_side {element} -> "hand_left sits on the model\'s LEFT"',
	'  - check_sides -> audits every left/right NAME against the geometry',
	'',
	'WHEN THE USER SAYS "shield in the left hand, sword in the right":',
	'  1. which_side on the two hand bones, or check_sides, to learn which is which.',
	'  2. Parent the shield to the bone on -X (named *_left) and the sword to +X (*_right).',
	'  3. check_sides again, then request_review with a FRONT and a BACK view so the user',
	'     confirms. Never conclude it is correct from your own look at the render.',
	'',
	'BUILDING: pass side:"left"/"right" to add_cube/add_cubes/add_group — the tool',
	'refuses the call if the coordinate contradicts the side, so a mirrored limb is',
	'impossible to create by accident. Keep paired bones named *_left / *_right.',
	'',
	'EXPORT: Blockbench mirrors X when it writes Bedrock/GeckoLib/Java files, so a bone',
	'you place at +X here is written as x = -5 in the .json. That is correct — vanilla',
	'"rightArm" has pivot x = -5. Do not "fix" it.',
	'',
	'CAMERA VIEWS are named from the MODEL\'s point of view: "front" looks at its face,',
	'"left" looks at the side its left arm is on, "front_right" is a three-quarter from',
	'its front-right. World-axis names (+x, -z, north, east) still work if you want them.',
].join('\n');

const RIGGING_GUIDE = [
	'RIGGING PLAYBOOK — the skeleton decides how good the animation can ever be.',
	'',
	'THE FAILURE TO AVOID: a limb made of 2 bones ("arm" + "hand"). There is no elbow, so',
	'nothing can bend and every animation looks like cardboard cut-outs swinging. Minimum',
	'for anything that moves:',
	'  arm  = shoulder? -> arm_upper -> arm_lower -> hand      (3 movable segments)',
	'  leg  = leg_upper -> leg_lower -> foot',
	'  body = hips -> spine -> chest -> neck -> head (+ jaw)',
	'  plus tail / ears / cloak chains of 2-4 bones for follow-through.',
	'A creature rig is normally 15-30 bones. Under 8 is a red flag.',
	'',
	'FASTEST PATH: create_rig {type:"humanoid"|"quadruped", height, arm_segments:3,',
	'leg_segments:3, tail_segments:3} builds the whole hierarchy with joints on the real',
	'pivots, correct left/right naming, and a blocked-out placeholder body you then',
	'reshape with edit_element and add detail cubes into. Then check_rig.',
	'',
	'JOINT ORIGINS: a bone rotates around its origin, so the origin must sit ON the joint',
	'— the shoulder for arm_upper, the elbow for arm_lower, the wrist for the hand, the',
	'hip/knee/ankle for legs. An origin in the middle of a limb makes it spin in place;',
	'check_rig reports that as origin_not_at_joint.',
	'',
	'NAMING drives every automatic tool. Use lower_snake with a side suffix:',
	'  arm_upper_right, arm_lower_right, hand_right, leg_upper_left, foot_left, tail1..3.',
	'The side must match the geometry: the model\'s right is +X (see',
	'get_guide {topic:"orientation"}). check_sides verifies it; create_rig gets it right',
	'by construction.',
	'',
	'PARENTING: in animated formats every cube must live under a bone. Cubes stay in the',
	'segment they belong to (forearm cubes under arm_lower, not under arm_upper), or the',
	'elbow bend will tear the mesh apart.',
	'',
	'BEFORE ANIMATING: check_rig must say ready_to_animate. Then generate_animation.',
].join('\n');

const REVIEW_GUIDE = [
	'REVIEW PROTOCOL — how to stop shipping work that is not actually right.',
	'',
	'The problem this fixes: taking a screenshot, judging it yourself, and telling the',
	'user "everything looks good" when it does not. You are a poor judge of your own',
	'render — you know what you INTENDED, so you see it. The user does not.',
	'',
	'RULE: after every user-visible milestone, call request_review and WAIT. The tool',
	'renders labelled views, puts them in the MCP Copilot panel inside Blockbench, and',
	'blocks until the user presses a button — the answer comes back to you in the same',
	'tool call, so nothing about the conversation is interrupted.',
	'',
	'MILESTONES THAT NEED A REVIEW:',
	'  - the silhouette / blockout is finished (before texturing)',
	'  - the texture pass is finished',
	'  - EACH animation, previewed at several times (pass `animation` to request_review)',
	'  - anything the user asked for specifically ("shield in the left hand")',
	'  - before you say a task is done',
	'',
	'HOW TO ASK WELL: one concrete question, and say what to look at.',
	'  request_review {question:"Walk cycle: is the stride length right and do the knees',
	'  bend enough?", animation:"animation.golem.walk", times:[0,0.25,0.5,0.75],',
	'  views:["front_right","left"]}',
	'Use ask_user for a decision you cannot make yourself (which hand, which colour,',
	'which of two silhouettes) instead of guessing and building the wrong thing.',
	'',
	'WHEN THE ANSWER COMES BACK:',
	'  approved -> continue.  changes requested -> fix exactly what they said, then ask',
	'  again.  no answer (timeout) -> say so in chat; NEVER treat silence as approval.',
	'',
	'AND BEFORE YOU ASK: run the objective checks first (check_model, check_sides,',
	'check_rig, analyze_animation, compare_reference). Do not spend the user\'s attention',
	'on something a tool would have caught.',
].join('\n');

const REFERENCE_GUIDE = [
	'MATCHING A REFERENCE — the grounded loop. Hit it, do not "almost" it.',
	'',
	'Why models miss the reference: the AI builds from a fuzzy memory of the image, then',
	'RATIONALISES the result ("close enough") because nothing measures the gap. This',
	'toolset removes both excuses — the reference is in the workspace and the match is a',
	'NUMBER. Use the number, not your opinion.',
	'',
	'THE TOOLS:',
	'- get_reference — returns the reference image(s) the user dropped in the MCP Copilot',
	'  panel (or that you loaded). LOOK at it before and during the build.',
	'- load_reference {path|data_url} — add a reference from disk / a data URL yourself.',
	'- compare_reference {view?} — THE key tool. Renders your model from the chosen angle',
	'  on a transparent background, extracts both silhouettes, and returns:',
	'    match_percent (silhouette IoU 0-100), aspect_delta_pct (too wide/narrow),',
	'    ref_only_pct (reference area with NO model under it = MISSING mass),',
	'    model_only_pct (model sticking out beyond the reference = EXTRA mass),',
	'    a verdict + concrete advice, AND a composite image: [reference | your model |',
	'    overlay]. In the overlay: RED = reference only (fill it), BLUE = model only',
	'    (trim it), WHITE = match. Drive RED and BLUE toward zero.',
	'- measure_model — bounding box + per-bone sizes + key ratios, to match proportions',
	'  numerically (e.g. head_height_fraction).',
	'',
	'THE LOOP:',
	'1. get_reference and describe it concretely in words: stance; head size & position;',
	'   limbs/appendages (count + shape); key features; ~5 palette colours; what is',
	'   BIGGEST. Turn that into a bone + part list before building.',
	'2. Build the grey silhouette (no texture yet). Aim the camera to the reference angle',
	'   (set_camera_angle / screenshot_views; models usually face -Z so "back" shows the',
	'   FACE) — or pass `view` to compare_reference.',
	'3. compare_reference. Read match_percent and the advice. Study the overlay: where is',
	'   it RED (add/enlarge parts there)? where BLUE (shrink/move)? Is aspect_delta_pct',
	'   telling you too wide/narrow? Fix the SINGLE biggest delta.',
	'4. compare_reference again. Repeat until match_percent >= 85 (90+ for a hero asset).',
	'   Only THEN texture — match the palette with detail_cubes `colors` + paint_faces.',
	'5. NEVER declare success on opinion when a compare score exists. If match_percent is',
	'   72 and you "think it looks great", it does not — keep going. Stop when the number',
	'   is high AND the side-by-side would convince the user, not just you.',
].join('\n');

const DETAILING_GUIDE = [
	'DETAILING DOCTRINE — how a model stops being 15 boxes. Read this BEFORE placing',
	'geometry for anything with a costume, armour, cloth, fur, plating or a weapon.',
	'',
	'WHY THIS EXISTS: asked for a hooded figure you emit one box for the torso, one for',
	'the cloak and one for the head, because computing 200 sets of [from,to] in your head',
	'is impossible. That is a tooling problem, not a taste problem. The generators below',
	'do the arithmetic; your job is the SHAPE and the LAYERS.',
	'',
	'1. CUBE BUDGET (audit_complexity enforces it):',
	'     simple prop / small item .......  30-60 cubes',
	'     standard mob / NPC ............. 100-180 cubes',
	'     hero model / boss / detailed ... 180-300+ cubes',
	'   A humanoid built from under ~70 cubes is a DRAFT, not a model, and must not go to',
	'   texturing. Cube count alone is not quality — but under budget is always a fail.',
	'',
	'2. THE 4-LAYER DOCTRINE. Build outward, one layer at a time.',
	'   Layer 0 — CORE FRAME: the skeleton and joint volumes (create_rig), plus the dark',
	'     cavities other layers sit over: the void under a hood, the gap between armour',
	'     plates, an open mouth. Cavities are what give depth; add_hollow_volume makes them.',
	'   Layer 1 — PRIMARY MASS: torso segmented into 2-3 blocks, every limb in at least 3',
	'     segments (upper / lower / hand-or-foot), neck, head. Never one cube per limb.',
	'   Layer 2 — SECONDARY VOLUMES: the outer shell — chest plate, pauldrons, bracers,',
	'     belt, hood, boots, collar. These are SEPARATE cubes standing 0.3-0.8 units proud',
	'     of Layer 1, not a recoloured part of it. add_hollow_volume for anything that',
	'     wraps (hood, helmet, cuff); plain cubes for slabs.',
	'   Layer 3 — FRINGES AND SILHOUETTE BREAKERS: torn hems, shingles, scales, feathers,',
	'     spikes, teeth, plate rows, and cubes rotated 15-45 degrees that break the square',
	'     outline. generate_array produces a whole row in one call. A silhouette with no',
	'     interruptions reads as a box no matter how good the texture is.',
	'   Layer 4 — MICRO-VOXELS AND PROPS: 1x1 and 1x2 details — studs, buckles, rivets,',
	'     stitches, gem settings, eyes — plus the held weapon or tool. voxelize_matrix',
	'     draws blades, emblems and flat detail from a character grid; extrude_chain',
	'     builds horns, tails, tentacles and braids.',
	'',
	'3. BANNED SHAPES. Each of these is an automatic rebuild:',
	'   - one cube for a cloak, cape or skirt. Segment it vertically, then close the bottom',
	'     with a generate_array fringe row (anchor "top", depth_stagger 0.05-0.2).',
	'   - one solid cube for a head that wears a hood, helmet or mask. The head is Layer 1;',
	'     the covering is add_hollow_volume with the face (north) and neck (down) open.',
	'   - one cube per limb. Three segments minimum, or every animation looks like cardboard.',
	'   - a large flat face with nothing on it. Overlay trim, a bevel cube at 45 degrees,',
	'     or a fringe row. audit_complexity reports these as undetailed_slab.',
	'',
	'4. THE GENERATORS (all universal — none of them knows what a hood or a scale is):',
	'   voxelize_matrix    draw the silhouette as rows of characters, get cubes. Blades,',
	'                      axe heads, bows, horn profiles, shield emblems, fins, wings,',
	'                      chevrons, gears, plate patterns. Set `palette` per character for',
	'                      depth / offset_z / name, and merge_adjacent for anything big.',
	'   add_hollow_volume  a shell with a cavity instead of a solid box. Hoods, helmets,',
	'                      masks, eye sockets, breastplates, pauldrons, cages, pipes,',
	'                      wheels, crates. `open_faces` decides what stays open.',
	'   generate_array     repeat an element along a line, around a ring or over a grid,',
	'                      with jitter, taper, per-element rotation and depth_stagger.',
	'                      Hems, scales, feathers, plates, teeth, spikes, rivets, links.',
	'   extrude_chain      a tapering, curving chain, one bone per segment by default.',
	'                      Horns, tails, tentacles, claws, branches, braids, cables.',
	'   Use them for the repetitive mass and add_cubes for the shapes only you can judge.',
	'',
	'5. DEPTH DISCIPLINE (this is what makes layers read as layers):',
	'   - Layer 2 stands 0.3-0.8 proud of Layer 1. Less and it looks like a texture; more',
	'     and it detaches.',
	'   - Overlapping decorative pieces must never share a plane: stagger neighbours by',
	'     0.05-0.2 (generate_array depth_stagger does it for you). Two coplanar faces',
	'     z-fight, which is the flickering "two squares inside each other" artefact.',
	'   - When two cubes overlap, let one clearly PENETRATE the other by >=0.1.',
	'   - check_model reports coplanar_overlap; fix every one. The generators also',
	'     report `z_fight_pairs` on their own output when they could not avoid it —',
	'     a row where each element overlaps two neighbours still lines up, and elements',
	'     at the same height share top/bottom planes. Fix it with jitter, spacing or',
	'     a small rotation_range, do not ship it.',
	'',
	'6. THE PIPELINE:',
	'   1  read the reference, split the silhouette into the four layers',
	'   2  create_rig                      (anatomy, joints, segmented limbs)',
	'   3  add_cubes                       (Layer 1 primary mass)',
	'   4  add_hollow_volume               (Layer 0 cavities + Layer 2 shells)',
	'   5  generate_array                  (Layer 3 fringes, plates, scales)',
	'   6  voxelize_matrix / extrude_chain (Layer 4 props, weapons, horns, micro-detail)',
	'   7  audit_complexity + compare_reference + check_model  -> FIX, then repeat',
	'   8  pack_uv -> create_texture -> detail_cubes -> paint_faces',
	'   9  request_review — the user, not you, decides it is done',
	'',
	'7. THE GATE: audit_complexity returns too_primitive / acceptable / high_detail plus',
	'   monolithic boxes, layering, micro-detail density and bare slabs. Verdict',
	'   too_primitive means keep building; it is not a suggestion. Texturing a blockout',
	'   wastes the whole texturing pass.',
].join('\n');

const GUIDES = {
	modeling: MODELING_GUIDE,
	detailing: DETAILING_GUIDE,
	texturing: TEXTURING_GUIDE,
	vfx: VFX_GUIDE,
	animation: ANIMATION_GUIDE,
	rigging: RIGGING_GUIDE,
	orientation: ORIENTATION_GUIDE,
	review: REVIEW_GUIDE,
	reference: REFERENCE_GUIDE,
};

// ---------------------------------------------------------------------------
// RIGGING
//
// Two-bone limbs are why AI animations look like cardboard: with only
// "arm" + "hand" there is no elbow, so nothing can bend. These helpers build
// and audit properly segmented skeletons (upper / lower / extremity), with the
// left/right convention baked in so a rig cannot come out mirrored.
// ---------------------------------------------------------------------------

/**
 * Canonical rig space: +x = the model's RIGHT, +y = UP, -z = FRONT. Templates
 * are authored there and mapped onto whatever axis the format actually faces.
 */
function rigFrame() {
	const o = orientation();
	const R = o.right_vec, U = o.up_vec, B = o.back_vec;
	return {
		orientation: o,
		point: (p) => [
			R[0] * p[0] + U[0] * p[1] + B[0] * p[2],
			R[1] * p[0] + U[1] * p[1] + B[1] * p[2],
			R[2] * p[0] + U[2] * p[1] + B[2] * p[2],
		],
		/** Canonical [rx,ry,rz] -> a rotation vector in world axes. */
		rot: (r) => {
			const out = [0, 0, 0];
			const put = (axis, val) => {
				const i = AXIS_INDEX[axis[1]];
				out[i] += axis[0] === '+' ? val : -val;
			};
			if (r[0]) put(o.right_axis, r[0]);
			if (r[1]) put(o.up_axis, r[1]);
			if (r[2]) put(o.back_axis, r[2]);
			return out;
		},
	};
}

const LIMB_WORDS = {
	arm: ['arm', 'arms', 'humerus', 'bicep', 'forearm', 'elbow', 'wing'],
	leg: ['leg', 'legs', 'thigh', 'femur', 'shin', 'calf', 'tibia', 'knee', 'haunch'],
};
const EXTREMITY_WORDS = ['hand', 'fist', 'foot', 'feet', 'paw', 'hoof', 'claw', 'talon', 'toe', 'finger', 'ankle', 'wrist'];

/** Coarse role of a bone name: 'arm' | 'leg' | 'tail' | 'head' | 'neck' | 'spine' | 'hips' | ... */
function boneRole(name) {
	const t = nameTokens(name);
	const has = (...w) => w.some((x) => t.includes(x));
	if (has('root', 'armature', 'rig', 'model')) return 'root';
	if (has('jaw', 'mandible')) return 'jaw';
	if (has('head', 'skull', 'cranium')) return 'head';
	if (has('neck')) return 'neck';
	if (has('tail')) return 'tail';
	if (has('wing')) return 'wing';
	if (has('ear', 'horn', 'antler')) return 'ear';
	if (has('hip', 'hips', 'pelvis', 'waist')) return 'hips';
	if (has('chest', 'thorax', 'ribcage', 'shoulders')) return 'chest';
	if (has('spine', 'torso', 'abdomen', 'body', 'belly')) return 'spine';
	if (LIMB_WORDS.leg.some((w) => t.includes(w))) return 'leg';
	if (LIMB_WORDS.arm.some((w) => t.includes(w))) return 'arm';
	if (has('foot', 'feet', 'paw', 'hoof', 'toe')) return 'leg';
	if (has('hand', 'fist', 'finger')) return 'arm';
	if (has('shoulder', 'clavicle')) return 'arm';
	return null;
}

/** 'front' | 'back' | null — which pair of legs a quadruped bone belongs to. */
function limbRow(name) {
	const t = nameTokens(name);
	if (t.some((x) => ['front', 'fore', 'forward', 'anterior'].includes(x))) return 'front';
	if (t.some((x) => ['back', 'hind', 'rear', 'posterior'].includes(x))) return 'back';
	return null;
}

function childGroups(g) {
	return (g && g.children ? g.children : []).filter((c) => c instanceof Group);
}

/** Follow a limb down the outliner: [upper, lower, extremity, ...] (max 5). */
function limbChain(rootBone) {
	const chain = [rootBone];
	let cur = rootBone;
	for (let i = 0; i < 4; i++) {
		const kids = childGroups(cur);
		if (!kids.length) break;
		// Prefer the child that continues the same limb (name overlap / extremity).
		const role = boneRole(rootBone.name);
		let next = kids.find((k) => boneRole(k.name) === role) ||
			kids.find((k) => EXTREMITY_WORDS.some((w) => nameTokens(k.name).includes(w))) ||
			(kids.length === 1 ? kids[0] : null);
		if (!next) break;
		chain.push(next);
		cur = next;
	}
	return chain;
}

/**
 * Work out the rig from the outliner: spine chain, head, tail and every limb
 * (with its segments), each tagged with the model's own left/right.
 */
function detectRig() {
	const rig = {
		kind: 'unknown',
		root: null, hips: null, spine: [], chest: null, neck: [], head: null, jaw: null,
		tail: [], ears: [],
		limbs: { arm: { left: null, right: null }, leg_front: { left: null, right: null }, leg_back: { left: null, right: null } },
		unmatched: [],
	};
	if (typeof Group === 'undefined' || !Project) return rig;
	const groups = Group.all.slice();
	const limbRoots = [];
	groups.forEach((g) => {
		const role = boneRole(g.name);
		const parentRole = g.parent instanceof Group ? boneRole(g.parent.name) : null;
		switch (role) {
			case 'root': if (!rig.root) rig.root = g; break;
			case 'hips': if (!rig.hips) rig.hips = g; break;
			case 'chest': if (!rig.chest) rig.chest = g; break;
			case 'spine': rig.spine.push(g); break;
			case 'neck': rig.neck.push(g); break;
			case 'head': if (!rig.head) rig.head = g; break;
			case 'jaw': if (!rig.jaw) rig.jaw = g; break;
			case 'tail': rig.tail.push(g); break;
			case 'ear': rig.ears.push(g); break;
			case 'arm': case 'leg': case 'wing':
				// A limb ROOT is a limb bone whose parent is not the same limb.
				if (parentRole !== role) limbRoots.push({ g, role });
				break;
			default: rig.unmatched.push(g.name);
		}
	});
	rig.tail.sort((a, b) => Math.abs(a.origin[2]) - Math.abs(b.origin[2]));
	rig.spine.sort((a, b) => a.origin[1] - b.origin[1]);
	rig.neck.sort((a, b) => a.origin[1] - b.origin[1]);

	limbRoots.forEach(({ g, role }) => {
		const side = sideFromName(g.name) || sideOfCoord(sideCoordOf(g));
		if (side !== 'left' && side !== 'right') return;
		let chain = limbChain(g);
		// A clavicle/shoulder bone is not the upper arm — if it leads the chain the
		// elbow would land one segment too high and bend the wrong joint.
		let shoulder = null;
		if (chain.length > 1 && /shoulder|clavicle|scapula|pelvis/i.test(chain[0].name)) {
			shoulder = chain[0];
			chain = chain.slice(1);
		}
		const row = limbRow(g.name);
		let slot;
		if (role === 'leg') slot = row === 'front' ? 'leg_front' : row === 'back' ? 'leg_back' : 'leg_main';
		else slot = row === 'front' ? 'arm' : row === 'back' ? 'leg_back' : 'arm';
		rig.limbs[slot] = rig.limbs[slot] || { left: null, right: null };
		const entry = {
			root: g, chain, side, shoulder,
			upper: chain[0] || null,
			lower: chain[1] || null,
			end: chain.length > 2 ? chain[2] : null,
			tip: chain[chain.length - 1] || null,
			segments: chain.length,
			names: (shoulder ? [shoulder.name] : []).concat(chain.map((c) => c.name)),
		};
		if (!rig.limbs[slot][side] || entry.segments > rig.limbs[slot][side].segments) rig.limbs[slot][side] = entry;
	});

	const hasArms = !!(rig.limbs.arm && (rig.limbs.arm.left || rig.limbs.arm.right));
	const hasMainLegs = !!(rig.limbs.leg_main && (rig.limbs.leg_main.left || rig.limbs.leg_main.right));
	const hasFront = !!(rig.limbs.leg_front && (rig.limbs.leg_front.left || rig.limbs.leg_front.right));
	const hasBack = !!(rig.limbs.leg_back && (rig.limbs.leg_back.left || rig.limbs.leg_back.right));
	if (hasFront && hasBack) rig.kind = 'quadruped';
	else if (hasArms && hasBack && !hasMainLegs) { rig.kind = 'quadruped'; rig.limbs.leg_front = rig.limbs.arm; rig.limbs.arm = { left: null, right: null }; }
	else if (hasArms && hasMainLegs) rig.kind = 'humanoid';
	else if (hasMainLegs) rig.kind = 'biped';
	else if (hasArms) rig.kind = 'armed';
	// Humanoid legs live in leg_main; normalise so generators can just read `legs`.
	rig.legs = rig.kind === 'quadruped'
		? { front: rig.limbs.leg_front || { left: null, right: null }, back: rig.limbs.leg_back || { left: null, right: null } }
		: { main: rig.limbs.leg_main || rig.limbs.leg_back || { left: null, right: null } };
	rig.arms = rig.limbs.arm || { left: null, right: null };
	rig.torso = rig.chest || rig.spine[rig.spine.length - 1] || rig.hips || null;
	return rig;
}

function summarizeRig(rig) {
	const limb = (l) => (l ? {
		bones: l.names, segments: l.segments, bendable: l.segments >= 3,
		upper: l.upper && l.upper.name, lower: l.lower && l.lower.name,
		extremity: l.end && l.end.name, side: l.side,
	} : null);
	const out = {
		kind: rig.kind,
		root: rig.root && rig.root.name,
		hips: rig.hips && rig.hips.name,
		spine: rig.spine.map((g) => g.name),
		chest: rig.chest && rig.chest.name,
		neck: rig.neck.map((g) => g.name),
		head: rig.head && rig.head.name,
		jaw: rig.jaw && rig.jaw.name,
		tail: rig.tail.map((g) => g.name),
		arms: { left: limb(rig.arms.left), right: limb(rig.arms.right) },
	};
	if (rig.kind === 'quadruped') {
		out.legs_front = { left: limb(rig.legs.front.left), right: limb(rig.legs.front.right) };
		out.legs_back = { left: limb(rig.legs.back.left), right: limb(rig.legs.back.right) };
	} else {
		out.legs = { left: limb(rig.legs.main.left), right: limb(rig.legs.main.right) };
	}
	return out;
}

// ---- rig templates ---------------------------------------------------------

/**
 * Humanoid skeleton in canonical space (height 32 = a Minecraft player).
 * Origins sit on the real joints: shoulder, elbow, wrist, hip, knee, ankle.
 */
function humanoidTemplate(o) {
	const armSeg = Math.max(2, Math.min(3, o.arm_segments == null ? 3 : o.arm_segments));
	const legSeg = Math.max(2, Math.min(3, o.leg_segments == null ? 3 : o.leg_segments));
	const spineSeg = Math.max(1, Math.min(3, o.spine_segments == null ? 2 : o.spine_segments));
	const bones = [];
	const cubes = [];
	const B = (name, origin, parent) => { bones.push({ name, origin, parent }); return name; };
	const C = (name, from, to, parent) => cubes.push({ name, from, to, parent });

	B('root', [0, 0, 0], null);
	B('hips', [0, 12, 0], 'root');
	let torso = 'hips';
	if (spineSeg >= 1) torso = B('spine', [0, 12.5, 0], 'hips');
	if (spineSeg >= 3) torso = B('spine2', [0, 16, 0], torso);
	const chest = B('chest', [0, 18.5, 0], torso);
	const neck = B('neck', [0, 23, 0], chest);
	const head = B('head', [0, 24, 0], neck);
	if (o.jaw) B('jaw', [0, 26.5, -2], head);

	C('body_lower', [-4, 12, -2], [4, 18.6, 2], torso);
	C('body_chest', [-4.2, 18.4, -2.2], [4.2, 24, 2.2], chest);
	C('head_box', [-4, 24, -4], [4, 32, 4], head);

	['right', 'left'].forEach((side) => {
		const m = side === 'right' ? 1 : -1;
		const sfx = '_' + side;
		const sh = B('shoulder' + sfx, [4 * m, 22, 0], chest);
		const up = B('arm_upper' + sfx, [5 * m, 22, 0], sh);
		C('arm_upper' + sfx, [m > 0 ? 4 : -8, 16.8, -2], [m > 0 ? 8 : -4, 22.6, 2], up);
		let last = up;
		if (armSeg >= 2) {
			last = B('arm_lower' + sfx, [5 * m, 17, 0], up);
			C('arm_lower' + sfx, [m > 0 ? 4.2 : -7.8, 12.8, -1.8], [m > 0 ? 7.8 : -4.2, 17.3, 1.8], last);
		}
		if (armSeg >= 3) {
			const hand = B('hand' + sfx, [5 * m, 13, 0], last);
			C('hand' + sfx, [m > 0 ? 4.1 : -7.9, 10.6, -2], [m > 0 ? 7.9 : -4.1, 13.2, 2], hand);
		}
		const hip = B('leg_upper' + sfx, [2 * m, 12, 0], 'hips');
		C('leg_upper' + sfx, [m > 0 ? 0.1 : -3.9, 6, -2], [m > 0 ? 3.9 : -0.1, 12.2, 2], hip);
		let lastLeg = hip;
		if (legSeg >= 2) {
			lastLeg = B('leg_lower' + sfx, [2 * m, 6.5, 0], hip);
			C('leg_lower' + sfx, [m > 0 ? 0.3 : -3.7, 1.4, -1.8], [m > 0 ? 3.7 : -0.3, 6.7, 1.8], lastLeg);
		}
		if (legSeg >= 3) {
			const foot = B('foot' + sfx, [2 * m, 1.5, 0], lastLeg);
			// Insets keep neighbouring segments from sharing a plane (z-fighting).
			C('foot' + sfx, [m > 0 ? 0.35 : -3.65, 0, -3.4], [m > 0 ? 3.65 : -0.35, 1.7, 1.6], foot);
		}
	});

	const tailSeg = Math.max(0, Math.min(6, o.tail_segments || 0));
	let tailParent = 'hips';
	for (let i = 1; i <= tailSeg; i++) {
		const z0 = 2 + (i - 1) * 3.8;
		const inset = i * 0.08;
		const n = B('tail' + i, [0, 12 - i * 0.6, z0], tailParent);
		C('tail' + i, [-1.5 + inset, 11 - i * 0.6, z0], [1.5 - inset, 13.5 - i * 0.6, z0 + 4.2], n);
		tailParent = n;
	}
	return { bones, cubes, height: 32 };
}

/** Quadruped skeleton in canonical space (shoulder height ~12, body along Z). */
function quadrupedTemplate(o) {
	const legSeg = Math.max(2, Math.min(3, o.leg_segments == null ? 3 : o.leg_segments));
	const bones = [];
	const cubes = [];
	const B = (name, origin, parent) => { bones.push({ name, origin, parent }); return name; };
	const C = (name, from, to, parent) => cubes.push({ name, from, to, parent });

	B('root', [0, 0, 0], null);
	B('hips', [0, 12, 5], 'root');
	const spine = B('spine', [0, 12, 1], 'hips');
	const chest = B('chest', [0, 12, -3], spine);
	const neck = B('neck', [0, 13, -6], chest);
	const head = B('head', [0, 15, -8.5], neck);
	if (o.jaw) B('jaw', [0, 14, -9.5], head);

	C('body_rear', [-4, 8, 1], [4, 15.5, 8], 'hips');
	C('body_mid', [-4.2, 8.2, -3.2], [4.2, 15.7, 1.4], spine);
	C('body_chest', [-4.5, 8, -7], [4.5, 16, -2.9], chest);
	C('neck', [-2.8, 11, -8.5], [2.8, 16.5, -5.6], neck);
	C('head', [-3.5, 12.5, -13], [3.5, 18.5, -8], head);
	if (o.jaw) C('snout', [-2, 12.6, -15.5], [2, 15.6, -12.6], 'jaw');

	[['front', -5, chest], ['back', 5, 'hips']].forEach(([row, z, parent]) => {
		['right', 'left'].forEach((side) => {
			const m = side === 'right' ? 1 : -1;
			const sfx = '_' + row + '_' + side;
			const top = row === 'front' ? 10.5 : 11;
			const up = B('leg_upper' + sfx, [3 * m, top, z], parent);
			C('leg_upper' + sfx, [m > 0 ? 1.6 : -4.4, 5.5, z - 2.1], [m > 0 ? 4.4 : -1.6, top + 0.4, z + 1.9], up);
			let last = up;
			if (legSeg >= 2) {
				last = B('leg_lower' + sfx, [3 * m, 5.8, z + (row === 'back' ? 0.6 : 0)], up);
				C('leg_lower' + sfx, [m > 0 ? 1.8 : -4.2, 1.6, z - 1.6 + (row === 'back' ? 0.6 : 0)], [m > 0 ? 4.2 : -1.8, 6, z + 1.6 + (row === 'back' ? 0.6 : 0)], last);
			}
			if (legSeg >= 3) {
				const paw = B('paw' + sfx, [3 * m, 1.7, z], last);
				C('paw' + sfx, [m > 0 ? 1.55 : -4.45, 0, z - 2.6], [m > 0 ? 4.45 : -1.55, 1.9, z + 1.4], paw);
			}
		});
	});

	const tailSeg = Math.max(0, Math.min(6, o.tail_segments == null ? 3 : o.tail_segments));
	let tailParent = 'hips';
	for (let i = 1; i <= tailSeg; i++) {
		const z0 = 7.5 + (i - 1) * 3.3;
		const n = B('tail' + i, [0, 13 - i * 0.4, z0], tailParent);
		C('tail' + i, [-1.4 + i * 0.1, 12 - i * 0.4, z0], [1.4 - i * 0.1, 14 - i * 0.4, z0 + 3.7], n);
		tailParent = n;
	}
	return { bones, cubes, height: 20 };
}

// ---------------------------------------------------------------------------
// ANIMATION ENGINE
//
// Procedural, direction-correct base cycles. Everything is authored in the
// canonical frame and mapped through rigFrame(), so "forward" really is the
// way the model faces — the reason hand-written attacks kept swinging into the
// model's back.
//
// SIGNS (canonical): +X rotation lifts a bone's front, so a DOWN-pointing bone
// (arm/leg) swings its tip FORWARD and an UP-pointing bone (torso/neck) tips
// BACK. Elbows bend +X (hand forward), knees bend -X (heel back).
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;

function makeKeyframeSink(frame) {
	const list = [];
	return {
		list,
		/** Canonical rotation in degrees on a bone (skipped when the bone is missing). */
		rot(bone, time, canonicalXYZ, interp) {
			if (!bone) return;
			list.push({
				bone: bone.name || bone, channel: 'rotation', time: +time.toFixed(4),
				value: frame.rot(canonicalXYZ).map((v) => +v.toFixed(3)),
				interpolation: interp || 'catmullrom',
			});
		},
		/** Canonical position offset in units. */
		pos(bone, time, canonicalXYZ, interp) {
			if (!bone) return;
			const p = frame.point(canonicalXYZ);
			list.push({
				bone: bone.name || bone, channel: 'position', time: +time.toFixed(4),
				value: p.map((v) => +v.toFixed(3)),
				interpolation: interp || 'catmullrom',
			});
		},
		scale(bone, time, xyz, interp) {
			if (!bone) return;
			list.push({
				bone: bone.name || bone, channel: 'scale', time: +time.toFixed(4),
				value: xyz.map((v) => +v.toFixed(3)), interpolation: interp || 'catmullrom',
			});
		},
	};
}

/** Phase tables tuned by hand — formulas alone give that flat, robotic swing. */
const KNEE_CURVE = [-5, -2, 0, -7, -32, -52, -36, -13];      // 0 = thigh fully forward
const ELBOW_CURVE = [26, 18, 12, 14, 22, 30, 34, 31];        // gentle, always slightly bent
const QUAD_KNEE = [-8, -4, -2, -10, -38, -50, -34, -16];

function limbOf(pair, side) { return pair && pair[side] ? pair[side] : null; }

/**
 * Build a walk/run cycle. `power` scales every amplitude, so run is walk with
 * bigger swing, more knee, a forward lean and real air time.
 */
function genGait(rig, frame, opts) {
	const K = makeKeyframeSink(frame);
	const L = opts.length;
	const steps = 8;
	const power = opts.power;
	const running = opts.type === 'run';
	const at = (p) => (p / steps) * L;
	const wrap = (p) => ((p % steps) + steps) % steps;

	const thighAmp = (running ? 42 : 26) * power;
	const armAmp = (running ? 46 : 22) * power;
	const kneeAmp = (running ? 1.45 : 1) * power;
	const bob = (running ? 1.1 : 0.45) * power;

	const legPair = rig.kind === 'quadruped' ? null : rig.legs.main;
	const closed = steps + 1; // repeat phase 0 at the end so the loop is seamless

	if (legPair) {
		['right', 'left'].forEach((side) => {
			const leg = limbOf(legPair, side);
			if (!leg) return;
			const offset = side === 'right' ? 0 : steps / 2;
			for (let p = 0; p < closed; p++) {
				const ph = wrap(p + offset);
				const t = at(p);
				const thigh = thighAmp * Math.cos((TAU * ph) / steps);
				const knee = KNEE_CURVE[ph] * kneeAmp;
				K.rot(leg.upper, t, [thigh, 0, 0]);
				if (leg.lower) K.rot(leg.lower, t, [knee, 0, 0]);
				if (leg.end) K.rot(leg.end, t, [-(thigh + knee) * 0.45, 0, 0]);
			}
		});
	}
	if (rig.kind === 'quadruped') {
		// Diagonal gait: front-right moves with back-left.
		const rows = [['front', rig.legs.front], ['back', rig.legs.back]];
		rows.forEach(([row, pair]) => {
			['right', 'left'].forEach((side) => {
				const leg = limbOf(pair, side);
				if (!leg) return;
				const diagonal = (row === 'front' && side === 'right') || (row === 'back' && side === 'left');
				const offset = diagonal ? 0 : steps / 2;
				const amp = (row === 'front' ? thighAmp * 0.9 : thighAmp) * (running ? 1 : 0.95);
				for (let p = 0; p < closed; p++) {
					const ph = wrap(p + offset);
					const t = at(p);
					const upper = amp * Math.cos((TAU * ph) / steps);
					const knee = QUAD_KNEE[ph] * kneeAmp * (row === 'front' ? 0.7 : 1);
					K.rot(leg.upper, t, [upper, 0, 0]);
					if (leg.lower) K.rot(leg.lower, t, [row === 'front' ? -knee * 0.8 : knee, 0, 0]);
					if (leg.end) K.rot(leg.end, t, [-(upper + knee) * 0.4, 0, 0]);
				}
			});
		});
	}

	// Arms swing opposite their same-side leg (right arm with left leg).
	['right', 'left'].forEach((side) => {
		const arm = limbOf(rig.arms, side);
		if (!arm) return;
		const offset = side === 'right' ? steps / 2 : 0;
		const out = side === 'right' ? 1 : -1;
		for (let p = 0; p < closed; p++) {
			const ph = wrap(p + offset);
			const t = at(p);
			const swing = armAmp * Math.cos((TAU * ph) / steps);
			K.rot(arm.upper, t, [swing, 0, out * (running ? 7 : 4)]);
			if (arm.lower) K.rot(arm.lower, t, [ELBOW_CURVE[ph] * (running ? 1.5 : 0.8) * power, 0, 0]);
			if (arm.end) K.rot(arm.end, t, [Math.sin((TAU * ph) / steps) * 6, 0, 0]);
		}
	});

	// Body: two bobs per cycle, hip/chest counter-rotation, head held steady.
	for (let p = 0; p < closed; p++) {
		const t = at(p);
		const ph = wrap(p);
		const a = (TAU * ph) / steps;
		const hipsY = -bob * Math.abs(Math.cos(a)) + bob * 0.5;
		const twist = (running ? 9 : 5) * power;
		K.pos(rig.hips || rig.root, t, [0, hipsY, 0]);
		if (rig.hips) K.rot(rig.hips, t, [running ? -4 * power : 0, twist * 0.6 * Math.sin(a), 2 * Math.sin(a) * power]);
		const chest = rig.chest || rig.spine[rig.spine.length - 1];
		if (chest) K.rot(chest, t, [running ? -10 * power : -2 * power, -twist * Math.sin(a), -1.5 * Math.sin(a) * power]);
		rig.neck.forEach((n) => K.rot(n, t, [running ? 6 * power : 1.5, twist * 0.4 * Math.sin(a), 0]));
		if (rig.head) K.rot(rig.head, t, [running ? 4 : 1 + 1.5 * Math.cos(2 * a), twist * 0.35 * Math.sin(a), 0]);
		rig.tail.forEach((tb, i) => {
			const lag = a - (i + 1) * 0.5;
			K.rot(tb, t, [Math.sin(lag) * 3 * power, Math.sin(lag) * (10 - i * 1.5) * power, 0]);
		});
	}
	return K.list;
}

/** Idle: breathing, weight shift, a slow head drift. Nothing static. */
function genIdle(rig, frame, opts) {
	const K = makeKeyframeSink(frame);
	const L = opts.length;
	const power = opts.power;
	const steps = 4;
	const at = (p) => (p / steps) * L;
	for (let p = 0; p <= steps; p++) {
		const t = at(p);
		const a = (TAU * p) / steps;
		const breathe = Math.sin(a);
		const sway = Math.sin(a / 2 + 0.4);
		K.pos(rig.hips || rig.root, t, [sway * 0.15 * power, breathe * 0.18 * power, 0]);
		if (rig.hips) K.rot(rig.hips, t, [0, sway * 1.5 * power, sway * 0.8 * power]);
		const chest = rig.chest || rig.spine[rig.spine.length - 1];
		if (chest) K.rot(chest, t, [-breathe * 2.2 * power, -sway * 1.2 * power, 0]);
		rig.neck.forEach((n) => K.rot(n, t, [breathe * 1.2 * power, sway * 1.5 * power, 0]));
		if (rig.head) K.rot(rig.head, t, [-breathe * 1.6 * power, sway * 3 * power, sway * 0.8 * power]);
		if (rig.jaw) K.rot(rig.jaw, t, [Math.max(0, breathe) * 1.5 * power, 0, 0]);
		['right', 'left'].forEach((side) => {
			const arm = limbOf(rig.arms, side);
			if (!arm) return;
			const s = side === 'right' ? 1 : -1;
			K.rot(arm.upper, t, [breathe * 1.8 * power, 0, s * (3 + breathe * 1.5) * power]);
			if (arm.lower) K.rot(arm.lower, t, [(6 + breathe * 3) * power, 0, 0]);
			if (arm.end) K.rot(arm.end, t, [breathe * 3 * power, 0, 0]);
		});
		const legPairs = rig.kind === 'quadruped' ? [rig.legs.front, rig.legs.back] : [rig.legs.main];
		legPairs.forEach((pair) => ['right', 'left'].forEach((side) => {
			const leg = limbOf(pair, side);
			if (!leg) return;
			K.rot(leg.upper, t, [sway * 0.8 * power * (side === 'right' ? 1 : -1), 0, 0]);
			if (leg.lower) K.rot(leg.lower, t, [-Math.abs(sway) * 1.2 * power, 0, 0]);
		}));
		rig.tail.forEach((tb, i) => {
			const lag = a - (i + 1) * 0.6;
			K.rot(tb, t, [Math.sin(lag) * 2 * power, Math.sin(lag) * 5 * power, 0]);
		});
	}
	return K.list;
}

/**
 * Melee attack: anticipation (wind back) -> strike THROUGH the front -> contact
 * hold -> recovery. The strike always travels toward the model's front.
 */
function genAttack(rig, frame, opts) {
	const K = makeKeyframeSink(frame);
	const L = opts.length;
	const power = opts.power;
	const hand = opts.hand === 'left' ? 'left' : 'right';
	const s = hand === 'right' ? 1 : -1;
	const arm = limbOf(rig.arms, hand);
	const offArm = limbOf(rig.arms, hand === 'right' ? 'left' : 'right');
	const chest = rig.chest || rig.spine[rig.spine.length - 1];
	// t0 rest, t1 wind-up, t2 strike, t3 contact hold, t4 back to rest
	const t0 = 0, t1 = L * 0.28, t2 = L * 0.46, t3 = L * 0.56, t4 = L;

	if (rig.kind === 'quadruped' || !arm) {
		// No arms: a lunge + bite instead of a swing.
		const body = rig.hips || rig.root;
		K.pos(body, t0, [0, 0, 0]); K.rot(body, t0, [0, 0, 0]);
		K.pos(body, t1, [0, 1.2 * power, 1.6 * power]); K.rot(body, t1, [6 * power, 0, 0]);
		K.pos(body, t2, [0, 0.4 * power, -3.4 * power]); K.rot(body, t2, [-8 * power, 0, 0]);
		K.pos(body, t3, [0, 0, -2.6 * power]);
		K.pos(body, t4, [0, 0, 0]); K.rot(body, t4, [0, 0, 0]);
		rig.neck.forEach((n) => {
			K.rot(n, t0, [0, 0, 0]); K.rot(n, t1, [10 * power, 0, 0]);
			K.rot(n, t2, [-18 * power, 0, 0]); K.rot(n, t4, [0, 0, 0]);
		});
		if (rig.head) {
			K.rot(rig.head, t0, [0, 0, 0]); K.rot(rig.head, t1, [8 * power, 0, 0]);
			K.rot(rig.head, t2, [-14 * power, 0, 0], 'linear'); K.rot(rig.head, t4, [0, 0, 0]);
		}
		if (rig.jaw) {
			K.rot(rig.jaw, t0, [0, 0, 0]); K.rot(rig.jaw, t1, [28 * power, 0, 0]);
			K.rot(rig.jaw, t2, [34 * power, 0, 0]); K.rot(rig.jaw, t3, [2, 0, 0], 'linear'); K.rot(rig.jaw, t4, [0, 0, 0]);
		}
		return K.list;
	}

	// Torso drives the swing: twist away, then through (+Y turns to the LEFT).
	if (chest) {
		K.rot(chest, t0, [0, 0, 0]);
		K.rot(chest, t1, [-6 * power, -22 * s * power, 0]);
		K.rot(chest, t2, [8 * power, 20 * s * power, 0], 'linear');
		K.rot(chest, t3, [6 * power, 16 * s * power, 0]);
		K.rot(chest, t4, [0, 0, 0]);
	}
	if (rig.hips) {
		K.rot(rig.hips, t0, [0, 0, 0]);
		K.rot(rig.hips, t1, [0, -10 * s * power, 0]);
		K.rot(rig.hips, t2, [0, 12 * s * power, 0], 'linear');
		K.rot(rig.hips, t4, [0, 0, 0]);
	}
	if (rig.head) {
		K.rot(rig.head, t0, [0, 0, 0]);
		K.rot(rig.head, t1, [0, -8 * s * power, 0]);
		K.rot(rig.head, t2, [6 * power, 4 * s * power, 0]);
		K.rot(rig.head, t4, [0, 0, 0]);
	}
	// Striking arm: back and up, then all the way through to the front.
	K.rot(arm.upper, t0, [0, 0, 0]);
	K.rot(arm.upper, t1, [-58 * power, 12 * s * power, s * 18 * power]);
	K.rot(arm.upper, t2, [88 * power, -6 * s * power, s * 6 * power], 'linear');
	K.rot(arm.upper, t3, [72 * power, 0, s * 4 * power]);
	K.rot(arm.upper, t4, [0, 0, 0]);
	if (arm.lower) {
		K.rot(arm.lower, t0, [8, 0, 0]);
		K.rot(arm.lower, t1, [72 * power, 0, 0]);
		K.rot(arm.lower, t2, [14 * power, 0, 0], 'linear');
		K.rot(arm.lower, t3, [20 * power, 0, 0]);
		K.rot(arm.lower, t4, [8, 0, 0]);
	}
	if (arm.end) {
		K.rot(arm.end, t0, [0, 0, 0]);
		K.rot(arm.end, t1, [-14 * power, 0, 0]);
		K.rot(arm.end, t2, [10 * power, 0, 0], 'linear');
		K.rot(arm.end, t4, [0, 0, 0]);
	}
	// Off arm counterbalances.
	if (offArm) {
		K.rot(offArm.upper, t0, [0, 0, 0]);
		K.rot(offArm.upper, t1, [26 * power, 0, -s * 10 * power]);
		K.rot(offArm.upper, t2, [-34 * power, 0, -s * 16 * power], 'linear');
		K.rot(offArm.upper, t4, [0, 0, 0]);
		if (offArm.lower) {
			K.rot(offArm.lower, t0, [8, 0, 0]);
			K.rot(offArm.lower, t1, [34 * power, 0, 0]);
			K.rot(offArm.lower, t2, [46 * power, 0, 0]);
			K.rot(offArm.lower, t4, [8, 0, 0]);
		}
	}
	// A step into the swing.
	const legs = rig.legs.main || {};
	const frontLeg = limbOf(legs, hand === 'right' ? 'left' : 'right');
	const backLeg = limbOf(legs, hand);
	if (frontLeg) {
		K.rot(frontLeg.upper, t0, [0, 0, 0]);
		K.rot(frontLeg.upper, t1, [-8 * power, 0, 0]);
		K.rot(frontLeg.upper, t2, [22 * power, 0, 0], 'linear');
		K.rot(frontLeg.upper, t4, [0, 0, 0]);
		if (frontLeg.lower) {
			K.rot(frontLeg.lower, t0, [0, 0, 0]);
			K.rot(frontLeg.lower, t2, [-16 * power, 0, 0]);
			K.rot(frontLeg.lower, t4, [0, 0, 0]);
		}
	}
	if (backLeg) {
		K.rot(backLeg.upper, t0, [0, 0, 0]);
		K.rot(backLeg.upper, t1, [10 * power, 0, 0]);
		K.rot(backLeg.upper, t2, [-18 * power, 0, 0], 'linear');
		K.rot(backLeg.upper, t4, [0, 0, 0]);
		if (backLeg.lower) {
			K.rot(backLeg.lower, t0, [0, 0, 0]);
			K.rot(backLeg.lower, t2, [-26 * power, 0, 0]);
			K.rot(backLeg.lower, t4, [0, 0, 0]);
		}
	}
	const body = rig.hips || rig.root;
	K.pos(body, t0, [0, 0, 0]);
	K.pos(body, t1, [0, 0.3 * power, 0.8 * power]);
	K.pos(body, t2, [0, -0.2 * power, -1.4 * power], 'linear');
	K.pos(body, t4, [0, 0, 0]);
	return K.list;
}

/** Both arms rise, glow bones pulse, the body floats. */
function genCast(rig, frame, opts) {
	const K = makeKeyframeSink(frame);
	const L = opts.length, power = opts.power;
	const t = (f) => L * f;
	['right', 'left'].forEach((side) => {
		const arm = limbOf(rig.arms, side);
		if (!arm) return;
		const s = side === 'right' ? 1 : -1;
		K.rot(arm.upper, t(0), [0, 0, 0]);
		K.rot(arm.upper, t(0.15), [-22 * power, 0, s * 14 * power]);
		K.rot(arm.upper, t(0.45), [128 * power, 0, s * 26 * power]);
		K.rot(arm.upper, t(0.7), [136 * power, 0, s * 20 * power]);
		K.rot(arm.upper, t(1), [0, 0, 0]);
		if (arm.lower) {
			K.rot(arm.lower, t(0), [8, 0, 0]);
			K.rot(arm.lower, t(0.45), [-34 * power, 0, 0]);
			K.rot(arm.lower, t(0.7), [-26 * power, 0, 0]);
			K.rot(arm.lower, t(1), [8, 0, 0]);
		}
		if (arm.end) {
			K.rot(arm.end, t(0), [0, 0, 0]);
			K.rot(arm.end, t(0.5), [-24 * power, 0, 0]);
			K.rot(arm.end, t(1), [0, 0, 0]);
		}
	});
	const chest = rig.chest || rig.spine[rig.spine.length - 1];
	if (chest) {
		K.rot(chest, t(0), [0, 0, 0]);
		K.rot(chest, t(0.5), [8 * power, 0, 0]);
		K.rot(chest, t(1), [0, 0, 0]);
	}
	if (rig.head) {
		K.rot(rig.head, t(0), [0, 0, 0]);
		K.rot(rig.head, t(0.5), [-14 * power, 0, 0]);
		K.rot(rig.head, t(1), [0, 0, 0]);
	}
	const body = rig.hips || rig.root;
	K.pos(body, t(0), [0, 0, 0]);
	K.pos(body, t(0.5), [0, 1.2 * power, 0]);
	K.pos(body, t(1), [0, 0, 0]);
	// Pulse anything named like a glowing core.
	Group.all.filter((g) => /_core$|_glow$|glow|crystal|gem/i.test(g.name)).slice(0, 8).forEach((g) => {
		K.scale(g, t(0), [1, 1, 1]);
		K.scale(g, t(0.5), [1.35, 1.35, 1.35]);
		K.scale(g, t(1), [1, 1, 1]);
	});
	return K.list;
}

/** Crouch, launch, tuck, land, settle. */
function genJump(rig, frame, opts) {
	const K = makeKeyframeSink(frame);
	const L = opts.length, power = opts.power;
	const t = (f) => L * f;
	const body = rig.hips || rig.root;
	const marks = [[0, 0], [0.18, -2.2], [0.35, 5.5], [0.6, 6.2], [0.82, -1.6], [1, 0]];
	marks.forEach(([f, y]) => K.pos(body, t(f), [0, y * power, 0]));
	const legPairs = rig.kind === 'quadruped' ? [rig.legs.front, rig.legs.back] : [rig.legs.main];
	legPairs.forEach((pair) => ['right', 'left'].forEach((side) => {
		const leg = limbOf(pair, side);
		if (!leg) return;
		K.rot(leg.upper, t(0), [0, 0, 0]);
		K.rot(leg.upper, t(0.18), [34 * power, 0, 0]);
		K.rot(leg.upper, t(0.35), [-16 * power, 0, 0], 'linear');
		K.rot(leg.upper, t(0.6), [30 * power, 0, 0]);
		K.rot(leg.upper, t(0.82), [26 * power, 0, 0]);
		K.rot(leg.upper, t(1), [0, 0, 0]);
		if (leg.lower) {
			K.rot(leg.lower, t(0), [0, 0, 0]);
			K.rot(leg.lower, t(0.18), [-62 * power, 0, 0]);
			K.rot(leg.lower, t(0.35), [-6 * power, 0, 0], 'linear');
			K.rot(leg.lower, t(0.6), [-54 * power, 0, 0]);
			K.rot(leg.lower, t(0.82), [-48 * power, 0, 0]);
			K.rot(leg.lower, t(1), [0, 0, 0]);
		}
		if (leg.end) {
			K.rot(leg.end, t(0), [0, 0, 0]);
			K.rot(leg.end, t(0.35), [24 * power, 0, 0]);
			K.rot(leg.end, t(0.82), [12 * power, 0, 0]);
			K.rot(leg.end, t(1), [0, 0, 0]);
		}
	}));
	['right', 'left'].forEach((side) => {
		const arm = limbOf(rig.arms, side);
		if (!arm) return;
		const s = side === 'right' ? 1 : -1;
		K.rot(arm.upper, t(0), [0, 0, 0]);
		K.rot(arm.upper, t(0.18), [-30 * power, 0, s * 6]);
		K.rot(arm.upper, t(0.35), [96 * power, 0, s * 12], 'linear');
		K.rot(arm.upper, t(0.6), [70 * power, 0, s * 16]);
		K.rot(arm.upper, t(1), [0, 0, 0]);
		if (arm.lower) {
			K.rot(arm.lower, t(0), [8, 0, 0]);
			K.rot(arm.lower, t(0.35), [30 * power, 0, 0]);
			K.rot(arm.lower, t(1), [8, 0, 0]);
		}
	});
	const chest = rig.chest || rig.spine[rig.spine.length - 1];
	if (chest) {
		K.rot(chest, t(0), [0, 0, 0]);
		K.rot(chest, t(0.18), [-14 * power, 0, 0]);
		K.rot(chest, t(0.35), [6 * power, 0, 0]);
		K.rot(chest, t(0.82), [-10 * power, 0, 0]);
		K.rot(chest, t(1), [0, 0, 0]);
	}
	return K.list;
}

/** A hit landing: snap back, then recover. */
function genHurt(rig, frame, opts) {
	const K = makeKeyframeSink(frame);
	const L = opts.length, power = opts.power;
	const t = (f) => L * f;
	const body = rig.hips || rig.root;
	K.pos(body, t(0), [0, 0, 0]);
	K.pos(body, t(0.15), [0, 0, 1.8 * power], 'linear');
	K.pos(body, t(0.45), [0, 0, 0.6 * power]);
	K.pos(body, t(1), [0, 0, 0]);
	const chest = rig.chest || rig.spine[rig.spine.length - 1];
	if (chest) {
		K.rot(chest, t(0), [0, 0, 0]);
		K.rot(chest, t(0.15), [16 * power, 6 * power, 0], 'linear');
		K.rot(chest, t(0.5), [-6 * power, -2 * power, 0]);
		K.rot(chest, t(1), [0, 0, 0]);
	}
	if (rig.head) {
		K.rot(rig.head, t(0), [0, 0, 0]);
		K.rot(rig.head, t(0.12), [22 * power, -8 * power, 6 * power], 'linear');
		K.rot(rig.head, t(0.5), [-8 * power, 2 * power, 0]);
		K.rot(rig.head, t(1), [0, 0, 0]);
	}
	if (rig.jaw) { K.rot(rig.jaw, t(0), [0, 0, 0]); K.rot(rig.jaw, t(0.15), [26 * power, 0, 0]); K.rot(rig.jaw, t(1), [0, 0, 0]); }
	['right', 'left'].forEach((side) => {
		const arm = limbOf(rig.arms, side);
		if (!arm) return;
		const s = side === 'right' ? 1 : -1;
		K.rot(arm.upper, t(0), [0, 0, 0]);
		K.rot(arm.upper, t(0.15), [-26 * power, 0, s * 22 * power], 'linear');
		K.rot(arm.upper, t(0.5), [6 * power, 0, s * 8]);
		K.rot(arm.upper, t(1), [0, 0, 0]);
		if (arm.lower) { K.rot(arm.lower, t(0), [8, 0, 0]); K.rot(arm.lower, t(0.15), [44 * power, 0, 0]); K.rot(arm.lower, t(1), [8, 0, 0]); }
	});
	return K.list;
}

/** Stagger, buckle, fall (backwards by default) and settle. */
function genDeath(rig, frame, opts) {
	const K = makeKeyframeSink(frame);
	const L = opts.length, power = opts.power;
	const t = (f) => L * f;
	const forward = opts.direction === 'forward';
	const fall = forward ? -88 : 84;   // +X tips an upright body BACKWARD
	const body = rig.root || rig.hips;
	K.rot(body, t(0), [0, 0, 0]);
	K.rot(body, t(0.2), [forward ? 8 : -10, 4, 3]);
	K.rot(body, t(0.55), [fall * 0.45, 3, -4], 'linear');
	K.rot(body, t(0.8), [fall, 2, -2]);
	K.rot(body, t(1), [fall, 2, -2]);
	K.pos(body, t(0), [0, 0, 0]);
	K.pos(body, t(0.2), [0, -1.4 * power, 0]);
	K.pos(body, t(0.55), [0, -3.5 * power, forward ? -2 : 2]);
	K.pos(body, t(0.8), [0, -6.5, forward ? -4 : 4]);
	K.pos(body, t(1), [0, -6.5, forward ? -4 : 4]);
	const chest = rig.chest || rig.spine[rig.spine.length - 1];
	if (chest) {
		K.rot(chest, t(0), [0, 0, 0]); K.rot(chest, t(0.3), [-14, 0, 6]);
		K.rot(chest, t(0.7), [18, 0, -4]); K.rot(chest, t(1), [12, 0, -2]);
	}
	if (rig.head) {
		K.rot(rig.head, t(0), [0, 0, 0]); K.rot(rig.head, t(0.25), [-18, 10, 0]);
		K.rot(rig.head, t(0.7), [26, -6, 8]); K.rot(rig.head, t(1), [30, -6, 10]);
	}
	if (rig.jaw) { K.rot(rig.jaw, t(0.2), [18, 0, 0]); K.rot(rig.jaw, t(1), [8, 0, 0]); }
	['right', 'left'].forEach((side) => {
		const arm = limbOf(rig.arms, side);
		if (!arm) return;
		const s = side === 'right' ? 1 : -1;
		K.rot(arm.upper, t(0), [0, 0, 0]);
		K.rot(arm.upper, t(0.3), [-18, 0, s * 26]);
		K.rot(arm.upper, t(0.75), [forward ? 44 : -36, 0, s * 40]);
		K.rot(arm.upper, t(1), [forward ? 40 : -32, 0, s * 44]);
		if (arm.lower) { K.rot(arm.lower, t(0), [8, 0, 0]); K.rot(arm.lower, t(0.75), [30, 0, 0]); K.rot(arm.lower, t(1), [26, 0, 0]); }
	});
	const legPairs = rig.kind === 'quadruped' ? [rig.legs.front, rig.legs.back] : [rig.legs.main];
	legPairs.forEach((pair) => ['right', 'left'].forEach((side) => {
		const leg = limbOf(pair, side);
		if (!leg) return;
		K.rot(leg.upper, t(0), [0, 0, 0]);
		K.rot(leg.upper, t(0.4), [22, 0, 0]);
		K.rot(leg.upper, t(0.8), [forward ? -30 : 46, 0, 0]);
		K.rot(leg.upper, t(1), [forward ? -28 : 44, 0, 0]);
		if (leg.lower) { K.rot(leg.lower, t(0), [0, 0, 0]); K.rot(leg.lower, t(0.8), [-52, 0, 0]); K.rot(leg.lower, t(1), [-50, 0, 0]); }
	}));
	return K.list;
}

/** Wing flap (uses arms as wings when no wing bones exist). */
function genFly(rig, frame, opts) {
	const K = makeKeyframeSink(frame);
	const L = opts.length, power = opts.power;
	const steps = 4;
	const at = (p) => (p / steps) * L;
	for (let p = 0; p <= steps; p++) {
		const t = at(p);
		const a = (TAU * p) / steps;
		const flap = Math.cos(a);
		['right', 'left'].forEach((side) => {
			const arm = limbOf(rig.arms, side);
			if (!arm) return;
			const s = side === 'right' ? 1 : -1;
			K.rot(arm.upper, t, [0, 0, s * (34 + flap * 46) * power]);
			if (arm.lower) K.rot(arm.lower, t, [0, 0, s * flap * 22 * power]);
			if (arm.end) K.rot(arm.end, t, [0, 0, s * flap * 14 * power]);
		});
		K.pos(rig.hips || rig.root, t, [0, flap * 0.9 * power, 0]);
		const chest = rig.chest || rig.spine[rig.spine.length - 1];
		if (chest) K.rot(chest, t, [-flap * 5 * power, 0, 0]);
		if (rig.head) K.rot(rig.head, t, [flap * 3 * power, 0, 0]);
		rig.tail.forEach((tb, i) => K.rot(tb, t, [Math.sin(a - i * 0.5) * 6 * power, 0, 0]));
		const legPairs = rig.kind === 'quadruped' ? [rig.legs.front, rig.legs.back] : [rig.legs.main];
		legPairs.forEach((pair) => ['right', 'left'].forEach((side) => {
			const leg = limbOf(pair, side);
			if (!leg) return;
			K.rot(leg.upper, t, [-24 + flap * 4, 0, 0]);
			if (leg.lower) K.rot(leg.lower, t, [-38 + flap * 5, 0, 0]);
		}));
	}
	return K.list;
}

const ANIMATION_GENERATORS = {
	idle: { fn: genIdle, length: 4, loop: 'loop' },
	walk: { fn: genGait, length: 1, loop: 'loop' },
	run: { fn: genGait, length: 0.62, loop: 'loop' },
	attack: { fn: genAttack, length: 0.85, loop: 'once' },
	cast: { fn: genCast, length: 2.2, loop: 'once' },
	jump: { fn: genJump, length: 1.1, loop: 'once' },
	hurt: { fn: genHurt, length: 0.45, loop: 'once' },
	death: { fn: genDeath, length: 1.8, loop: 'hold' },
	fly: { fn: genFly, length: 0.8, loop: 'loop' },
};

/** Write a list of {bone, channel, time, value, interpolation} into an animation. */
function putKeyframes(anim, list) {
	const created = [];
	let maxTime = 0;
	const missing = new Set();
	for (const k of list) {
		const group = findGroup(k.bone);
		if (!group) { missing.add(k.bone); continue; }
		const animator = anim.getBoneAnimator(group);
		if (!animator) { missing.add(k.bone); continue; }
		const value = k.value || [0, 0, 0];
		const kf = animator.addKeyframe({
			channel: k.channel || 'rotation',
			time: Number(k.time) || 0,
			interpolation: k.interpolation || 'linear',
			data_points: [{ x: value[0], y: value[1], z: value[2] }],
		});
		created.push({ uuid: kf && kf.uuid, bone: k.bone, channel: k.channel || 'rotation', time: kf && kf.time });
		maxTime = Math.max(maxTime, Number(k.time) || 0);
	}
	return { created, maxTime, missing: Array.from(missing) };
}

// ---- animation inspection (measure the motion instead of guessing) ---------

/** Run `fn` with the project in animation mode, then put everything back. */
async function withAnimationMode(fn) {
	if (typeof Modes === 'undefined' || !Modes.options || !Modes.options.animate) {
		throw new Error('This format has no animation mode.');
	}
	const previous = Mode.selected ? Mode.selected.id : 'edit';
	const switched = previous !== 'animate';
	if (switched) Modes.options.animate.select();
	try {
		return await fn();
	} finally {
		try { Timeline.setTime(0); } catch (e) {}
		try { Animator.showDefaultPose ? Animator.showDefaultPose() : Animator.preview(); } catch (e) {}
		if (switched && Modes.options[previous]) { try { Modes.options[previous].select(); } catch (e) {} }
	}
}

function boneWorldPos(group) {
	try {
		const v = new THREE.Vector3();
		group.mesh.getWorldPosition(v);
		return [v.x, v.y, v.z];
	} catch (e) { return null; }
}

/** The bones worth tracking when judging whether a motion goes the right way. */
function trackedBones(rig) {
	const out = [];
	const push = (slot, g) => { if (g) out.push({ slot, group: g }); };
	push('head', rig.head);
	push('hips', rig.hips);
	['right', 'left'].forEach((side) => {
		const arm = limbOf(rig.arms, side);
		if (arm) push('hand_' + side, arm.tip);
	});
	if (rig.kind === 'quadruped') {
		['front', 'back'].forEach((row) => ['right', 'left'].forEach((side) => {
			const leg = limbOf(rig.legs[row], side);
			if (leg) push('foot_' + row + '_' + side, leg.tip);
		}));
	} else {
		['right', 'left'].forEach((side) => {
			const leg = limbOf(rig.legs.main, side);
			if (leg) push('foot_' + side, leg.tip);
		});
	}
	if (rig.tail.length) push('tail_tip', rig.tail[rig.tail.length - 1]);
	return out;
}

/** Classify a displacement against the model's own axes. */
function describeDelta(delta, o) {
	const fwd = vecDot(delta, o.front_vec);
	const right = vecDot(delta, o.right_vec);
	const up = delta[1];
	const parts = [];
	if (Math.abs(fwd) > 0.4) parts.push((fwd > 0 ? 'forward ' : 'backward ') + Math.abs(fwd).toFixed(1));
	if (Math.abs(right) > 0.4) parts.push((right > 0 ? 'right ' : 'left ') + Math.abs(right).toFixed(1));
	if (Math.abs(up) > 0.4) parts.push((up > 0 ? 'up ' : 'down ') + Math.abs(up).toFixed(1));
	return {
		forward: +fwd.toFixed(2), right: +right.toFixed(2), up: +up.toFixed(2),
		text: parts.length ? parts.join(', ') : 'barely moves',
	};
}

/** Capture annotated renders of an animation at several times. */
async function animationPoseShots(anim, times, views, opts) {
	const L = anim.length || 1;
	const list = Array.isArray(times) && times.length
		? times.map(Number)
		: [0, L * 0.25, L * 0.5, L * 0.75].map((t) => +t.toFixed(3));
	const viewList = Array.isArray(views) && views.length ? views : ['front_right'];
	const shots = [];
	await withAnimationMode(async () => {
		anim.select();
		for (const t of list) {
			Timeline.setTime(Math.max(0, Math.min(L, t)));
			Animator.preview();
			const captured = await captureViews(viewList, Object.assign({ width: 420, height: 420 }, opts || {}, { stamp: `t=${(+t).toFixed(2)}s` }));
			captured.forEach((s) => shots.push(Object.assign({ time: +t }, s)));
		}
	});
	return shots;
}

// ---------------------------------------------------------------------------
// HUMAN REVIEW GATE
//
// An AI looking at its own screenshot is a bad judge — it will call a broken
// pose "great". These requests park in the MCP Copilot panel with the renders
// attached and the HTTP request stays open until the user presses a button, so
// the answer comes back inside the same tool call (the chat is never
// interrupted, the AI simply waits for a real human verdict).
// ---------------------------------------------------------------------------

/** Ring-buffer the answered requests so the panel can show a short history. */
function recordAnswer(entry, answer) {
	try {
		G.answers.push({
			id: entry.id, kind: entry.kind, question: entry.question,
			answer, t: Date.now(),
		});
		if (G.answers.length > 20) G.answers.splice(0, G.answers.length - 20);
	} catch (e) {}
}

function notifyPending(entry) {
	const text = entry.kind === 'review'
		? 'The AI is asking you to CHECK its work'
		: 'The AI is asking you a question';
	try { Blockbench.showQuickMessage(text + ' — see the MCP Copilot panel', 4000); } catch (e) {}
	try {
		if (mcpPanel && typeof mcpPanel.fold === 'function') mcpPanel.fold(false);
		else if (mcpPanel && mcpPanel.folded) mcpPanel.folded = false;
	} catch (e) {}
	// An OS-level toast, so it is seen even when Blockbench is in the background.
	try {
		if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
			new Notification('BlockbenchMCP', { body: text + ':\n' + String(entry.question || '').slice(0, 120) });
		}
	} catch (e) {}
	try { if (typeof G.onActivity === 'function') G.onActivity(); } catch (e) {}
}

/**
 * Park a request in the panel. The card lives until `timeoutSeconds`, but
 * nothing blocks on it for that long: callers wait in SHORT windows (see
 * waitForRequest) because MCP clients abort a tool call after ~30-60s. The
 * card and its answer outlive any individual wait, so polling resumes cleanly.
 */
function postRequest(entry, timeoutSeconds) {
	const timeout = Math.max(5, Math.min(3600, Number(timeoutSeconds) || 900));
	entry.id = 'ask-' + (++G.askSeq);
	entry.created = Date.now();
	entry.deadline = entry.created + timeout * 1000;
	entry.timeout_seconds = timeout;
	entry.waiters = [];
	G.pending.push(entry);
	G.requests[entry.id] = entry;
	notifyPending(entry);
	entry._timer = setInterval(() => {
		if (Date.now() >= entry.deadline) {
			settleRequest(entry, {
				answered: false,
				timed_out: true,
				waited_seconds: timeout,
				note:
					'The user did not answer before the card expired. Do NOT treat this as approval and do ' +
					'NOT claim the result is verified — say in chat that you are waiting for their check.',
			});
		}
	}, 500);
	return entry;
}

/** Final answer for a request: remove the card and wake every waiter. */
function settleRequest(entry, answer) {
	if (entry.done) return;
	entry.done = true;
	clearInterval(entry._timer);
	const i = G.pending.indexOf(entry);
	if (i >= 0) G.pending.splice(i, 1);
	entry.answer = answer;
	recordAnswer(entry, answer);
	(entry.waiters || []).splice(0).forEach((fn) => { try { fn(answer); } catch (e) {} });
	try { if (typeof G.onActivity === 'function') G.onActivity(); } catch (e) {}
}

/**
 * Wait a SHORT window for an answer. Resolves with the verdict, or with
 * `pending: true` so the caller polls again — which is what keeps a
 * minutes-long human review inside a client's per-request timeout.
 */
function waitForRequest(entry, waitSeconds) {
	const w = Math.max(1, Math.min(120, Number(waitSeconds) || 25));
	return new Promise((resolve) => {
		if (entry.answer) return resolve(entry.answer);
		let settled = false;
		const finish = (a) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const i = (entry.waiters || []).indexOf(finish);
			if (i >= 0) entry.waiters.splice(i, 1);
			resolve(a);
		};
		const timer = setTimeout(() => finish({
			answered: false,
			pending: true,
			review_id: entry.id,
			waited_seconds: w,
			seconds_left: Math.max(0, Math.round((entry.deadline - Date.now()) / 1000)),
			note:
				`Still waiting for the user — the card is open in the MCP Copilot panel. Call ` +
				`wait_review {review_id:"${entry.id}"} again to keep waiting. This is NOT approval; ` +
				`do not continue as if it were.`,
		}), w * 1000);
		entry.waiters.push(finish);
	});
}

/** Called from the panel when the user presses a button. */
function answerPending(id, answer) {
	const entry = G.requests[id] || G.pending.find((e) => e.id === id);
	if (!entry || entry.done) return false;
	settleRequest(entry, Object.assign(
		{ answered: true, waited_seconds: Math.round((Date.now() - entry.created) / 1000) }, answer));
	return true;
}
// Exposed so the round trip can be exercised without clicking (tests/debugging).
G.answerPending = answerPending;

/** Shape a raw answer into the result every asking tool returns. */
function formatAnswer(answer, entry) {
	if (answer.pending) {
		return {
			answered: false, pending: true, verdict: 'waiting',
			review_id: entry.id, waited_seconds: answer.waited_seconds,
			seconds_left: answer.seconds_left, note: answer.note,
		};
	}
	const answered = !!answer.answered;
	return {
		answered,
		pending: false,
		approved: answer.approved === true,
		verdict: answered ? (answer.approved ? 'approved' : (answer.choice ? 'answered' : 'changes_requested')) : 'no_answer',
		choice: answer.choice || null,
		comment: answer.comment || '',
		answer: answer.choice || answer.comment || '',
		review_id: entry.id,
		waited_seconds: answer.waited_seconds,
		timed_out: !!answer.timed_out,
		note: answer.note || (answer.approved
			? 'The user approved this step.'
			: 'The user is NOT happy — apply their comment and ask again. Do not move on.'),
	};
}

/** Capture a set of annotated views; shared by screenshots, reviews & animation previews. */
async function captureViews(views, options) {
	requireProject();
	const preview = Preview.selected;
	const opts = {};
	if (options && options.width) opts.width = options.width;
	if (options && options.height) opts.height = options.height;
	const annotate = !options || options.annotate !== false;
	const shotOne = () => new Promise((res) => Screencam.screenshotPreview(preview, opts, (d) => res(d)));
	const shots = [];
	for (const v of views) {
		let info;
		if (typeof v === 'string') {
			const dir = viewOffsetDir(v);
			if (dir) {
				info = applyAngleName(preview, v);
			} else {
				// Fall back to a Blockbench camera preset id, then to a default angle.
				const preset = (typeof DefaultCameraPresets !== 'undefined' && DefaultCameraPresets)
					? DefaultCameraPresets.find((x) => x.id === v || x.name === v) : null;
				if (preset && preview.loadAnglePreset) {
					preview.loadAnglePreset(preset);
					info = { view: v, looking_at: 'a Blockbench camera preset', model_right_on: 'unknown', note: '' };
				} else {
					info = applyAngleName(preview, 'front_right');
					info.view = v + ' (unknown view -> front_right)';
				}
			}
		} else if (v && typeof v === 'object') {
			if (Array.isArray(v.position)) preview.camera.position.set(v.position[0], v.position[1], v.position[2]);
			if (Array.isArray(v.target) && preview.controls) preview.controls.target.set(v.target[0], v.target[1], v.target[2]);
			const { center } = sceneBounds();
			const target = Array.isArray(v.target) ? v.target : center;
			const dir = vecNorm([
				preview.camera.position.x - target[0],
				preview.camera.position.y - target[1],
				preview.camera.position.z - target[2],
			]);
			info = describeView(v.name || 'custom', dir);
		} else {
			continue;
		}
		if (preview.controls && preview.controls.updateSceneScale) preview.controls.updateSceneScale();
		preview.render();
		let dataUrl = await shotOne();
		if (annotate) dataUrl = await annotateShot(dataUrl, info, options && options.stamp);
		shots.push({
			view: info.view,
			looking_at: info.looking_at,
			model_right_on: info.model_right_on,
			note: info.note,
			data_url: dataUrl,
			base64: dataUrl.replace(/^data:image\/png;base64,/, ''),
		});
	}
	return shots;
}

const DEFAULT_VIEWS = ['front_right', 'front', 'left', 'back'];

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// PROCEDURAL GEOMETRY
//
// Why this section exists: an LLM cannot hold a 3D coordinate system in its
// head, so asked for a hood it emits one big box, asked for a torn hem it
// emits one big box, and a "detailed" model collapses into 15 monoliths. Each
// generator below takes a description of a SHAPE — a pixel matrix, a shell, a
// repeated element, a tapering chain — and does the arithmetic itself, so
// detail density stops depending on the model's spatial memory.
//
// All of them are UNIVERSAL: nothing here knows what a hood, a scythe or a
// scale is. They are extrusion, shells, arrays and chains; the caller decides
// what those become.
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32) so a `seed` makes a jittered array repeatable. */
function makeRandom(seed) {
	if (seed == null || seed === '' || !isFinite(Number(seed))) return Math.random;
	let s = Number(seed) >>> 0 || 0x9e3779b9;
	return function () {
		s = (s + 0x6d2b79f5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Some MCP clients serialize array/object arguments as a JSON string. Parse
 * that back before anything tries to index it, so a dense 32x32 matrix sent as
 * a string does not fail with a useless "matrix is required".
 */
function maybeParse(v) {
	if (typeof v !== 'string') return v;
	const s = v.trim();
	if ((s[0] === '[' && s[s.length - 1] === ']') || (s[0] === '{' && s[s.length - 1] === '}')) {
		try { return JSON.parse(s); } catch (e) { /* fall through: it was just a string */ }
	}
	return v;
}

/** Coerce `v` into an array of exactly `n` finite numbers, filling from `fallback`. */
function numN(v, n, fallback) {
	const fb = Array.isArray(fallback) ? fallback : new Array(n).fill(0);
	const parsed = maybeParse(v);
	const src = Array.isArray(parsed)
		? parsed
		: typeof parsed === 'number' && isFinite(parsed) ? new Array(n).fill(parsed) : null;
	const out = [];
	for (let i = 0; i < n; i++) {
		const x = src ? Number(src[i]) : NaN;
		out.push(isFinite(x) ? x : (isFinite(fb[i]) ? fb[i] : 0));
	}
	return out;
}

/** A finite number or the fallback — never NaN, never a silent 0 from `Number(undefined)`. */
function numOr(v, fallback) {
	const x = Number(v);
	return isFinite(x) ? x : fallback;
}

/** Resolve an optional parent group reference, failing loudly when it is wrong. */
function resolveParent(ref) {
	if (ref === undefined || ref === null || ref === '' || ref === 'root') return null;
	const g = findGroup(ref);
	if (!g) {
		throw new Error(
			`Parent group not found: "${ref}". Use list_outliner to see the bones, ` +
			`or omit \`parent\` to build at the model root.`
		);
	}
	return g;
}

/**
 * Create one cube with the format's UV defaults and the default texture, the
 * same way add_cube(s) does. `from`/`to` are normalised, so a generator may
 * emit them in any order.
 */
function createCubeIn(parent, spec) {
	const a = num3(spec.from, [0, 0, 0]);
	const b = num3(spec.to, [a[0] + 1, a[1] + 1, a[2] + 1]);
	const from = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
	const to = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
	const cube = new Cube({
		name: spec.name || 'cube',
		from,
		to,
		origin: num3(spec.origin, from),
		rotation: num3(spec.rotation, [0, 0, 0]),
		inflate: numOr(spec.inflate, 0),
		autouv: Format.box_uv ? 0 : 1,
		box_uv: !!Format.box_uv,
	}).init();
	cube.addTo(parent || 'root');
	if (Texture.all.length) cube.applyTexture(Texture.getDefault(), true);
	return cube;
}

const R3 = (v) => Math.round(v * 1000) / 1000;

/** Axis-aligned bounds of a list of cubes (ignores rotation — fine for reporting). */
function boundsOfCubes(cubes) {
	if (!cubes || !cubes.length) return null;
	const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
	cubes.forEach((c) => {
		for (let i = 0; i < 3; i++) {
			min[i] = Math.min(min[i], c.from[i], c.to[i]);
			max[i] = Math.max(max[i], c.from[i], c.to[i]);
		}
	});
	return {
		min: min.map(R3), max: max.map(R3),
		size: [R3(max[0] - min[0]), R3(max[1] - min[1]), R3(max[2] - min[2])],
	};
}

/**
 * Compact report for a generator: hundreds of fully serialized cubes would
 * flood the model's context for no benefit, so return counts + bounds + a
 * sample and point at list_outliner for the rest.
 */
function generatedReport(cubes, extra, limit) {
	const lim = limit == null ? 12 : limit;
	const out = Object.assign({
		created: cubes.length,
		bounds: boundsOfCubes(cubes),
		sample: cubes.slice(0, lim).map((c) => ({
			name: c.name, uuid: c.uuid, from: c.from.map(R3), to: c.to.map(R3),
		})),
	}, extra || {});
	if (cubes.length > lim) {
		out.sample_note = `Showing ${lim} of ${cubes.length} cubes. Use list_outliner / get_element for the rest.`;
	}
	return out;
}

/** Guard against a runaway generator eating the project (and the UI thread). */
const MAX_GENERATED = 1500;
function assertBudget(count, what, max) {
	const cap = max || MAX_GENERATED;
	if (!isFinite(count) || count <= 0) {
		throw new Error(`${what} would create no geometry — check the parameters.`);
	}
	if (count > cap) {
		throw new Error(
			`${what} would create ${count} cubes, over the ${cap} safety cap. ` +
			`Split it into several calls, raise pixel_size / element size, or lower the count.`
		);
	}
}

// ---- face names -----------------------------------------------------------
// Blockbench face directions are WORLD-relative: north = -Z, south = +Z,
// east = +X, west = -X, up = +Y, down = -Y. Callers think in model-relative
// words ("open the front and the bottom"), so accept both.
const AXIS_TO_FACE = { '+x': 'east', '-x': 'west', '+y': 'up', '-y': 'down', '+z': 'south', '-z': 'north' };
const FACE_NAMES = ['north', 'south', 'east', 'west', 'up', 'down'];

function normalizeFaceName(name) {
	const n = String(name == null ? '' : name).toLowerCase().trim();
	if (FACE_NAMES.includes(n)) return n;
	const o = orientation();
	const alias = {
		front: AXIS_TO_FACE[o.front_axis],
		back: AXIS_TO_FACE[o.back_axis],
		right: AXIS_TO_FACE[o.right_axis],
		left: AXIS_TO_FACE[o.left_axis],
		top: 'up',
		bottom: 'down',
		'+x': 'east', '-x': 'west', '+y': 'up', '-y': 'down', '+z': 'south', '-z': 'north',
	};
	if (alias[n]) return alias[n];
	throw new Error(
		`Unknown face "${name}". Use north/south/east/west/up/down, or the model-relative ` +
		`words front/back/left/right/top/bottom.`
	);
}

// ---- small rotation maths -------------------------------------------------
// Blockbench (three.js) composes Euler angles in XYZ order: R = Rx·Ry·Rz.
// extrude_chain needs this to place un-parented segments along a curve, and to
// report where the tip of a bone chain actually ends up.
function eulerToMat(deg) {
	const rx = (deg[0] || 0) * Math.PI / 180, ry = (deg[1] || 0) * Math.PI / 180, rz = (deg[2] || 0) * Math.PI / 180;
	const a = Math.cos(rx), b = Math.sin(rx), c = Math.cos(ry), d = Math.sin(ry), e = Math.cos(rz), f = Math.sin(rz);
	return [
		[c * e, -c * f, d],
		[a * f + b * e * d, a * e - b * f * d, -b * c],
		[b * f - a * e * d, b * e + a * f * d, a * c],
	];
}

function matMul(m, n) {
	const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
	for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
		out[i][j] = m[i][0] * n[0][j] + m[i][1] * n[1][j] + m[i][2] * n[2][j];
	}
	return out;
}

function matApply(m, v) {
	return [
		m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
		m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
		m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
	];
}

function matToEuler(m) {
	const clamp = (v) => (v < -1 ? -1 : v > 1 ? 1 : v);
	const y = Math.asin(clamp(m[0][2]));
	let x, z;
	if (Math.abs(m[0][2]) < 0.99999) {
		x = Math.atan2(-m[1][2], m[2][2]);
		z = Math.atan2(-m[0][1], m[0][0]);
	} else {
		x = Math.atan2(m[2][1], m[1][1]);
		z = 0;
	}
	const deg = (r) => +(r * 180 / Math.PI).toFixed(4);
	return [deg(x), deg(y), deg(z)];
}

// ---- matrix voxelization --------------------------------------------------
// Which model axis each matrix axis maps to. u = columns (left to right),
// v = rows (FIRST row is the highest v), d = the extrusion/depth axis.
const VOXEL_PLANES = {
	xy: { u: 0, v: 1, d: 2, note: 'columns -> +X, rows descend -Y, depth along +Z (front view)' },
	xz: { u: 0, v: 2, d: 1, note: 'columns -> +X, rows descend -Z (first row at the back), depth along +Y (top view)' },
	yz: { u: 2, v: 1, d: 0, note: 'columns -> +Z (column 0 at the model\'s front), rows descend -Y, depth along +X (side view)' },
};

/**
 * Do any of these freshly generated cubes land a face on the same plane as
 * another cube's, overlapping in area? Those pairs flicker (z-fighting), and a
 * generator that quietly produced them would be worse than no generator. Same
 * rule as check_model, run over just this batch plus what it was built onto,
 * so the result can warn about itself.
 */
function coplanarPairsAmong(created) {
	const isFlat = (c) => c.rotation && c.rotation.every((r) => Math.abs(r) < 0.001);
	const fresh = created.filter(isFlat);
	if (!fresh.length) return { pairs: 0, examples: [] };
	const others = (typeof Cube !== 'undefined' && Cube.all ? Cube.all : []).filter(isFlat);
	const freshIndex = new Map();
	fresh.forEach((c, i) => freshIndex.set(c.uuid, i));
	const ov = (a1, a2, b1, b2) => Math.min(a2, b2) - Math.max(a1, b1);
	const eps = 0.02;
	const examples = [];
	let pairs = 0;
	for (let i = 0; i < fresh.length && pairs < 200; i++) {
		const a = fresh[i];
		for (let j = 0; j < others.length && pairs < 200; j++) {
			const b = others[j];
			if (a === b) continue;
			// Only compare each generated pair once; generated-vs-existing always counts.
			const bi = freshIndex.get(b.uuid);
			if (bi !== undefined && bi < i) continue;
			for (let ax = 0; ax < 3; ax++) {
				const o1 = (ax + 1) % 3, o2 = (ax + 2) % 3;
				if (ov(a.from[o1], a.to[o1], b.from[o1], b.to[o1]) <= 0.1) continue;
				if (ov(a.from[o2], a.to[o2], b.from[o2], b.to[o2]) <= 0.1) continue;
				if (Math.abs(a.from[ax] - b.from[ax]) < eps || Math.abs(a.to[ax] - b.to[ax]) < eps) {
					pairs++;
					if (examples.length < 5) examples.push({ cubes: [a.name, b.name], axis: ['x', 'y', 'z'][ax] });
					break;
				}
			}
		}
	}
	return { pairs, examples };
}

/** Fold a z-fighting report into a generator's result, with a fix to apply. */
function reportZFighting(res, created, fix) {
	const { pairs, examples } = coplanarPairsAmong(created);
	if (!pairs) return res;
	res.z_fight_pairs = pairs;
	res.z_fight_examples = examples;
	res.z_fight_hint =
		`${pairs} pair(s) of these cubes share a face plane and will flicker. ` + fix +
		' check_model lists every pair as coplanar_overlap.';
	return res;
}

// ---- array distribution ---------------------------------------------------
/** Turn an anchor word into the cube's min corner for a point + size. */
function anchorCorner(anchor, point, size) {
	const a = String(anchor || 'center').toLowerCase();
	if (a === 'min' || a === 'corner') return point.slice();
	if (a === 'top') return [point[0] - size[0] / 2, point[1] - size[1], point[2] - size[2] / 2];
	if (a === 'bottom' || a === 'base') return [point[0] - size[0] / 2, point[1], point[2] - size[2] / 2];
	if (a === 'center' || a === 'centre') return [point[0] - size[0] / 2, point[1] - size[1] / 2, point[2] - size[2] / 2];
	throw new Error(`Unknown anchor "${anchor}". Use 'center', 'top', 'bottom' or 'min'.`);
}

const commands = {

	// ---- status & info ----------------------------------------------------
	ping() {
		return {
			protocol: PROTOCOL_VERSION,
			blockbench_version: Blockbench.version,
			is_app: isApp,
			has_project: !!Project,
		};
	},

	get_status() {
		const status = {
			blockbench_version: Blockbench.version,
			has_project: !!Project,
		};
		if (Project) {
			status.project = {
				name: Project.name,
				format: Format ? Format.id : null,
				format_name: Format ? Format.name : null,
				texture_width: Project.texture_width,
				texture_height: Project.texture_height,
				cubes: Cube.all.length,
				groups: Group.all.length,
				textures: Texture.all.length,
				animations: (Animation.all || []).length,
				mode: Mode.selected ? Mode.selected.id : null,
			};
			// Left/right is the most-repeated mistake, so it is stated up front,
			// every time, instead of being left to memory.
			const o = orientation();
			status.orientation = {
				facing: o.facing,
				model_right_is: o.right_axis,
				model_left_is: o.left_axis,
				reminder:
					`The model faces ${o.front_axis}. Its own RIGHT hand/arm/leg is at ${o.right_axis}, its LEFT at ${o.left_axis}. ` +
					`On a front-view render you see it mirrored, so its right hand appears on the LEFT of the image. ` +
					`Use get_orientation / which_side / check_sides instead of judging by eye.`,
			};
			status.pending_user_requests = G.pending.length;
		}
		return status;
	},

	list_formats() {
		return Object.keys(Formats).map((id) => ({
			id,
			name: Formats[id].name,
			description: Formats[id].description,
			animation_mode: !!Formats[id].animation_mode,
			box_uv: !!Formats[id].box_uv,
		}));
	},

	// ---- project lifecycle ------------------------------------------------
	new_project(p) {
		const fmt = resolveFormat(p.format || 'free');
		if (!fmt) {
			throw new Error(
				`Unknown format "${p.format}". Use list_formats to see available ids. ` +
				`(GeckoLib/Bedrock formats require the matching plugin to be installed first.)`
			);
		}
		const created = newProject(fmt);
		if (!created) throw new Error('Failed to create project (a dialog may have been cancelled).');
		if (p.name) {
			Project.name = p.name;
			Project.geometry_name = p.geometry_name || p.name;
		}
		if (p.texture_width) Project.texture_width = p.texture_width | 0;
		if (p.texture_height) Project.texture_height = p.texture_height | 0;
		Canvas.updateAll();
		return commands.get_status().project;
	},

	close_project() {
		requireProject();
		if (Project.close) Project.close(true);
		return { closed: true };
	},

	set_project_meta(p) {
		requireProject();
		if (p.name !== undefined) Project.name = p.name;
		if (p.geometry_name !== undefined) Project.geometry_name = p.geometry_name;
		if (p.texture_width) Project.texture_width = p.texture_width | 0;
		if (p.texture_height) Project.texture_height = p.texture_height | 0;
		updateProjectResolution && updateProjectResolution();
		Canvas.updateAll();
		return commands.get_status().project;
	},

	save_project(p) {
		requireProject();
		return new Promise((resolve, reject) => {
			try {
				if (p && p.path && isApp) {
					Project.save_path = p.path;
				}
				BarItems.save_project.trigger();
				resolve({ saved: true, path: Project.save_path || null });
			} catch (e) {
				reject(e);
			}
		});
	},

	export_project(p) {
		requireProject();
		// Export through the format's own codec.
		const codec = Format.codec;
		if (!codec) throw new Error('Current format has no export codec.');
		if (p && p.path && isApp) {
			const content = codec.compile();
			require('fs').writeFileSync(p.path, typeof content === 'string' ? content : JSON.stringify(content));
			return { exported: true, path: p.path };
		}
		codec.export();
		return { exported: true, note: 'Export dialog opened in Blockbench.' };
	},

	/**
	 * Export through a NAMED codec (default glTF) and write it to `path`.
	 * Async codecs are awaited; glTF compiles to a self-contained .gltf with
	 * embedded buffers and textures, so it imports straight into Godot/Unity.
	 */
	async export_model(p) {
		requireProject();
		requireApp();
		if (!p || !p.path) throw new Error('path is required');
		const codecId = p.codec || 'gltf';
		const codec = (typeof Codecs !== 'undefined' && Codecs) ? Codecs[codecId] : null;
		if (!codec) {
			throw new Error(
				`Unknown codec "${codecId}". Available: ` +
				(typeof Codecs !== 'undefined' ? Object.keys(Codecs).join(', ') : '(none)')
			);
		}
		if (typeof codec.compile !== 'function') throw new Error(`Codec "${codecId}" cannot compile a model.`);
		const options = Object.assign({}, p.options || {});
		if (p.format) options.format = p.format;
		const data = await Promise.resolve(codec.compile(options));
		const content = typeof data === 'string' ? data
			: (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) ? Buffer.from(data.buffer || data)
			: JSON.stringify(data);
		require('fs').writeFileSync(p.path, content);
		return {
			exported: true, path: p.path, codec: codecId,
			bytes: typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.length,
		};
	},

	load_project(p) {
		requireApp();
		if (!p.path) throw new Error('path is required');
		const fs = require('fs');
		const content = fs.readFileSync(p.path, 'utf-8');
		const data = JSON.parse(content);
		// Codecs.project.load(model, file) sets up a fresh project from a .bbmodel
		// (the older .parse signature is what previously failed).
		Codecs.project.load(data, { path: p.path, content, name: p.path.split(/[\\/]/).pop() });
		Canvas.updateAll();
		return commands.get_status().project;
	},

	// ---- outliner / geometry ---------------------------------------------
	add_group(p) {
		requireProject();
		const parent = p.parent ? findGroup(p.parent) : null;
		if (p.parent && !parent) throw new Error('Parent group not found: ' + p.parent);
		const origin = num3(p.origin, [0, 0, 0]);
		const name = sideNameFor(p.name || 'group', p.side);
		assertSide(name, p.side, origin[orientation().side_index], 'bone');
		Undo.initEdit({ outliner: true });
		const group = new Group({
			name,
			origin,
			rotation: num3(p.rotation, [0, 0, 0]),
		}).init();
		group.addTo(parent || 'root');
		Undo.finishEdit('MCP: add group');
		Canvas.updateAll();
		const out = serializeGroup(group);
		const w = sideWarning(group);
		if (w) out.warning = w;
		return out;
	},

	add_cube(p) {
		requireProject();
		const parent = p.parent ? findGroup(p.parent) : null;
		if (p.parent && !parent) throw new Error('Parent group not found: ' + p.parent);
		const from = num3(p.from, [0, 0, 0]);
		const to = num3(p.to, [from[0] + 1, from[1] + 1, from[2] + 1]);
		const cubeName = sideNameFor(p.name || 'cube', p.side);
		const si = orientation().side_index;
		assertSide(cubeName, p.side, (from[si] + to[si]) / 2, 'cube');
		Undo.initEdit({ outliner: true, elements: [] });
		const cube = new Cube({
			name: cubeName,
			from,
			to,
			origin: num3(p.origin, from),
			rotation: num3(p.rotation, [0, 0, 0]),
			inflate: Number(p.inflate) || 0,
			autouv: typeof p.autouv === 'number' ? p.autouv : (Format.box_uv ? 0 : 1),
			box_uv: p.box_uv !== undefined ? !!p.box_uv : !!Format.box_uv,
			uv_offset: Array.isArray(p.uv_offset) ? p.uv_offset : undefined,
		}).init();
		cube.addTo(parent || 'root');
		if (p.faces) applyFaces(cube, p.faces);
		else if (Texture.all.length) cube.applyTexture(Texture.getDefault(), true);
		Undo.finishEdit('MCP: add cube');
		Canvas.updateAll();
		return serializeElement(cube);
	},

	// Build many bones at once. Parents may reference bones created earlier in
	// the same batch by name, so a whole skeleton can be authored in one call.
	add_groups(p) {
		requireProject();
		if (!Array.isArray(p.groups) || !p.groups.length) throw new Error('groups (array) is required');
		const si = orientation().side_index;
		// Validate the whole batch first — a half-created skeleton is worse than none.
		p.groups.forEach((spec) => {
			const nm = sideNameFor(spec.name || 'group', spec.side);
			assertSide(nm, spec.side, num3(spec.origin, [0, 0, 0])[si], 'bone');
		});
		Undo.initEdit({ outliner: true });
		const created = {};
		const out = [];
		const warnings = [];
		for (const spec of p.groups) {
			let parent = null;
			if (spec.parent) {
				parent = created[spec.parent] || findGroup(spec.parent);
				if (!parent) throw new Error('Parent group not found: ' + spec.parent);
			}
			const group = new Group({
				name: sideNameFor(spec.name || 'group', spec.side),
				origin: num3(spec.origin, [0, 0, 0]),
				rotation: num3(spec.rotation, [0, 0, 0]),
			}).init();
			group.addTo(parent || 'root');
			created[group.name] = group;
			out.push(serializeGroup(group));
			const w = sideWarning(group);
			if (w) warnings.push(w);
		}
		Undo.finishEdit('MCP: add groups');
		Canvas.updateAll();
		const res = { created: out.length, groups: out };
		if (warnings.length) res.warnings = warnings;
		return res;
	},

	// Build many cubes at once — the efficient way to author a detailed model.
	add_cubes(p) {
		requireProject();
		if (!Array.isArray(p.cubes) || !p.cubes.length) throw new Error('cubes (array) is required');
		const si = orientation().side_index;
		p.cubes.forEach((spec) => {
			const from = num3(spec.from, [0, 0, 0]);
			const to = num3(spec.to, [from[0] + 1, from[1] + 1, from[2] + 1]);
			assertSide(sideNameFor(spec.name || 'cube', spec.side), spec.side, (from[si] + to[si]) / 2, 'cube');
		});
		Undo.initEdit({ outliner: true, elements: [] });
		const out = [];
		const warnings = [];
		for (const spec of p.cubes) {
			const parent = spec.parent ? findGroup(spec.parent) : null;
			if (spec.parent && !parent) throw new Error('Parent group not found: ' + spec.parent);
			const from = num3(spec.from, [0, 0, 0]);
			const to = num3(spec.to, [from[0] + 1, from[1] + 1, from[2] + 1]);
			const cube = new Cube({
				name: sideNameFor(spec.name || 'cube', spec.side),
				from,
				to,
				origin: num3(spec.origin, from),
				rotation: num3(spec.rotation, [0, 0, 0]),
				inflate: Number(spec.inflate) || 0,
				autouv: typeof spec.autouv === 'number' ? spec.autouv : (Format.box_uv ? 0 : 1),
				box_uv: spec.box_uv !== undefined ? !!spec.box_uv : !!Format.box_uv,
				uv_offset: Array.isArray(spec.uv_offset) ? spec.uv_offset : undefined,
			}).init();
			cube.addTo(parent || 'root');
			if (spec.faces) applyFaces(cube, spec.faces);
			else if (Texture.all.length) cube.applyTexture(Texture.getDefault(), true);
			out.push(serializeElement(cube));
		}
		Undo.finishEdit('MCP: add cubes');
		Canvas.updateAll();
		return { created: out.length, cubes: out };
	},

	// ===== PROCEDURAL GENERATORS ==========================================
	// Universal shape builders. None of them knows what a hood, a blade or a
	// scale is — they do extrusion, shells, arrays and chains, and the caller
	// decides what those become. They exist because hand-computing [from,to]
	// for 200 cubes is exactly what an LLM is worst at.

	/**
	 * 2D pixel matrix -> 3D cubes. The model draws the shape as characters
	 * (which it is very good at) and this does the coordinate maths (which it
	 * is not). Works for any flat-ish part: blades, bows, horns, shield
	 * emblems, fins, wing panels, chevrons, keys, gears, plate silhouettes.
	 */
	voxelize_matrix(p) {
		requireProject();
		p = p || {};
		const raw = maybeParse(p.matrix);
		let matrix = Array.isArray(raw)
			? raw
			: typeof raw === 'string' ? raw.split(/\r?\n/) : null;
		if (!matrix || !matrix.length) {
			throw new Error(
				'matrix is required: an array of equal-length strings (or one string with newlines), ' +
				'e.g. ["  ##  ", " #### ", "  ##  "]. Blank cells are " " or ".".'
			);
		}
		matrix = matrix.map((row) => (row == null ? '' : String(row)));
		const rows = matrix.length;
		const cols = matrix.reduce((m, r) => Math.max(m, r.length), 0);
		if (!cols) throw new Error('matrix has no non-empty rows.');
		if (rows * cols > 20000) {
			throw new Error(`matrix is ${cols}x${rows} = ${rows * cols} cells, which is far past anything useful. Draw the shape at a lower resolution and raise pixel_size.`);
		}

		const planeKey = String(p.plane || 'xy').toLowerCase();
		const plane = VOXEL_PLANES[planeKey];
		if (!plane) throw new Error(`Unknown plane "${p.plane}". Use 'xy' (front), 'xz' (top) or 'yz' (side).`);

		const ps = numOr(p.pixel_size, 1);
		if (!(ps > 0)) throw new Error('pixel_size must be greater than 0.');
		const defaultDepth = numOr(p.default_depth, 1);
		const origin = num3(p.origin, [0, 0, 0]);
		const blank = String(p.blank == null ? ' .' : p.blank);
		const merge = !!p.merge_adjacent;
		const parent = resolveParent(p.parent);

		// palette keys are single characters; accept longer keys by first char.
		const paletteIn = maybeParse(p.palette);
		const palette = {};
		if (paletteIn && typeof paletteIn === 'object' && !Array.isArray(paletteIn)) {
			for (const key in paletteIn) {
				const entry = paletteIn[key];
				if (!key.length) continue;
				palette[key[0]] = (entry && typeof entry === 'object') ? entry : {};
			}
		}

		const baseName = sideNameFor(p.name || 'vox', p.side);
		const symbols = {};
		const unmapped = {};
		const specs = [];
		const skipped = [];

		for (let r = 0; r < rows; r++) {
			const line = matrix[r];
			let c = 0;
			while (c < cols) {
				const ch = c < line.length ? line[c] : ' ';
				if (c >= line.length || blank.indexOf(ch) !== -1) { c++; continue; }
				const entry = palette[ch] || {};
				// Run-length merge along the row: same character AND same style.
				let run = 1;
				if (merge) {
					while (c + run < cols && (line[c + run] || ' ') === ch) run++;
				}
				symbols[ch] = (symbols[ch] || 0) + run;
				if (!palette[ch]) unmapped[ch] = (unmapped[ch] || 0) + run;

				const depth = numOr(entry.depth, defaultDepth);
				const offset = numOr(entry.offset_z, 0);
				if (!depth) { skipped.push({ char: ch, row: r, col: c, why: 'depth is 0' }); c += run; continue; }

				const from = [0, 0, 0], to = [0, 0, 0];
				from[plane.u] = origin[plane.u] + c * ps;
				to[plane.u] = from[plane.u] + run * ps;
				from[plane.v] = origin[plane.v] + (rows - 1 - r) * ps;
				to[plane.v] = from[plane.v] + ps;
				from[plane.d] = origin[plane.d] + offset;
				to[plane.d] = from[plane.d] + depth;

				specs.push({
					name: (entry.name ? String(entry.name) : baseName) + '_' + (specs.length + 1),
					from, to,
					inflate: numOr(entry.inflate, 0),
					char: ch,
				});
				c += run;
			}
		}

		if (!specs.length) {
			throw new Error(
				'The matrix produced no cubes — every cell was blank. Blank characters are ' +
				`"${blank}"; anything else becomes a cube.`
			);
		}
		assertBudget(specs.length, 'voxelize_matrix', numOr(p.max_cubes, MAX_GENERATED));

		if (p.side) {
			const si = orientation().side_index;
			let lo = Infinity, hi = -Infinity;
			specs.forEach((s) => { lo = Math.min(lo, s.from[si]); hi = Math.max(hi, s.to[si]); });
			assertSide(baseName, p.side, (lo + hi) / 2, 'voxelized part');
		}

		Undo.initEdit({ outliner: true, elements: [] });
		const cubes = specs.map((s) => createCubeIn(parent, s));
		Undo.finishEdit('MCP: voxelize matrix');
		Canvas.updateAll();

		const res = generatedReport(cubes, {
			plane: planeKey,
			plane_mapping: plane.note,
			grid: { columns: cols, rows },
			pixel_size: ps,
			cells_filled: specs.length,
			symbols,
			parent: parent ? parent.name : 'root',
			merged: merge,
		});
		if (Object.keys(unmapped).length) {
			res.unmapped_chars = unmapped;
			res.unmapped_note = 'These characters had no palette entry and used default_depth. Add them to `palette` to give them their own depth/offset/name (the name is what detail_cubes colour rules match on).';
		}
		if (skipped.length) res.skipped = skipped.slice(0, 10);
		res.next = 'pack_uv after the last geometry call, then detail_cubes / paint_faces.';
		return reportZFighting(res, cubes,
			'Give the overlapping palette entries different `offset_z`/`depth` values so their faces do not line up, or move the whole grid by >=0.1 off whatever it sits on.');
	},

	/**
	 * A hollow shell instead of a solid box: up to six non-overlapping walls
	 * around an empty cavity. Universal for hoods, helmets, masks, eye
	 * sockets, breastplates, pauldrons, cages, wheels, pipes, cuffs, crates.
	 */
	add_hollow_volume(p) {
		requireProject();
		p = p || {};
		const bounds = maybeParse(p.bounds) || {};
		const fromRaw = bounds.from !== undefined ? bounds.from : p.from;
		const toRaw = bounds.to !== undefined ? bounds.to : p.to;
		if (fromRaw === undefined || toRaw === undefined) {
			throw new Error('bounds {from:[x,y,z], to:[x,y,z]} is required (the OUTER box of the shell).');
		}
		const a = num3(maybeParse(fromRaw), [0, 0, 0]);
		const b = num3(maybeParse(toRaw), [0, 0, 0]);
		const lo = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
		const hi = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
		const span = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
		if (span[0] <= 0 || span[1] <= 0 || span[2] <= 0) {
			throw new Error(`bounds must have a positive size on every axis (got ${span.join(' x ')}).`);
		}
		const t = numOr(p.wall_thickness, 1);
		if (!(t > 0)) throw new Error('wall_thickness must be greater than 0.');

		const open = {};
		let openIn = maybeParse(p.open_faces);
		if (typeof openIn === 'string') openIn = openIn.split(/[,\s]+/);
		toList(openIn || []).forEach((f) => {
			if (f === undefined || f === null || f === '') return;
			open[normalizeFaceName(f)] = true;
		});
		const has = { north: !open.north, south: !open.south, east: !open.east, west: !open.west, up: !open.up, down: !open.down };
		if (!FACE_NAMES.some((f) => has[f])) {
			throw new Error('Every face is in open_faces — that leaves nothing to build. Leave at least one closed.');
		}

		const warnings = [];
		const capThickness = (axisSpan, aOn, bOn, axisName) => {
			const n = (aOn ? 1 : 0) + (bOn ? 1 : 0);
			if (!n) return t;
			const max = axisSpan / n;
			if (t > max) {
				warnings.push(`wall_thickness ${t} does not fit on ${axisName} (span ${R3(axisSpan)}); clamped to ${R3(max)} there.`);
				return max;
			}
			return t;
		};
		const tX = capThickness(span[0], has.west, has.east, 'X');
		const tY = capThickness(span[1], has.down, has.up, 'Y');
		const tZ = capThickness(span[2], has.north, has.south, 'Z');

		// Walls tile the shell without overlapping: the Y slabs take the full
		// footprint, the Z walls take what is left between them, the X walls
		// what is left inside those. Overlapping slabs would z-fight.
		const yLo = lo[1] + (has.down ? tY : 0), yHi = hi[1] - (has.up ? tY : 0);
		const zLo = lo[2] + (has.north ? tZ : 0), zHi = hi[2] - (has.south ? tZ : 0);
		const name = sideNameFor(p.name || 'shell', p.side);
		if (p.side) assertSide(name, p.side, (lo[0] + hi[0]) / 2, 'hollow volume');

		const wallSpecs = [
			['down', [lo[0], lo[1], lo[2]], [hi[0], lo[1] + tY, hi[2]]],
			['up', [lo[0], hi[1] - tY, lo[2]], [hi[0], hi[1], hi[2]]],
			['north', [lo[0], yLo, lo[2]], [hi[0], yHi, lo[2] + tZ]],
			['south', [lo[0], yLo, hi[2] - tZ], [hi[0], yHi, hi[2]]],
			['west', [lo[0], yLo, zLo], [lo[0] + tX, yHi, zHi]],
			['east', [hi[0] - tX, yLo, zLo], [hi[0], yHi, zHi]],
		].filter(([dir, f, tt]) => has[dir] && tt[0] - f[0] > 1e-6 && tt[1] - f[1] > 1e-6 && tt[2] - f[2] > 1e-6);

		if (!wallSpecs.length) {
			throw new Error('The requested walls all came out empty — the bounds are smaller than wall_thickness.');
		}
		const parent = resolveParent(p.parent);
		Undo.initEdit({ outliner: true, elements: [] });
		const cubes = wallSpecs.map(([dir, f, tt]) => createCubeIn(parent, {
			name: `${name}_${dir}`, from: f, to: tt, inflate: numOr(p.inflate, 0),
		}));
		Undo.finishEdit('MCP: add hollow volume');
		Canvas.updateAll();

		const cavity = {
			from: [R3(lo[0] + (has.west ? tX : 0)), R3(yLo), R3(zLo)],
			to: [R3(hi[0] - (has.east ? tX : 0)), R3(yHi), R3(zHi)],
		};
		const cavitySize = [
			R3(cavity.to[0] - cavity.from[0]), R3(cavity.to[1] - cavity.from[1]), R3(cavity.to[2] - cavity.from[2]),
		];
		if (cavitySize.some((v) => v <= 0)) {
			warnings.push('The cavity has no volume: the walls meet in the middle, so this is effectively a solid box. Lower wall_thickness or grow the bounds.');
		}
		const res = generatedReport(cubes, {
			walls: wallSpecs.map(([dir]) => dir),
			open_faces: FACE_NAMES.filter((f) => open[f]),
			wall_thickness: { x: R3(tX), y: R3(tY), z: R3(tZ) },
			cavity, cavity_size: cavitySize,
			parent: parent ? parent.name : 'root',
		}, 6);
		if (warnings.length) res.warnings = warnings;
		res.note = 'Walls do not overlap each other, so they cannot z-fight. Anything you put INSIDE the cavity (a face, a skull, a glow core) should sit at least 0.1 clear of the walls.';
		return reportZFighting(res, cubes,
			'The walls cannot fight each other, so this is the shell against geometry that was already there: move the bounds by >=0.1 so no face lines up with the part underneath.');
	},

	/**
	 * Repeat one element along a line, around a ring or over a grid, with
	 * jitter, taper, per-element rotation and an alternating depth offset.
	 * Universal for torn hems, shingles, scales, feathers, plate armour,
	 * teeth, spinal spikes, fence posts, chain links, rivets, ribs.
	 */
	generate_array(p) {
		requireProject();
		p = p || {};
		const mode = String(p.mode || 'linear').toLowerCase();
		if (!['linear', 'radial', 'grid'].includes(mode)) {
			throw new Error(`Unknown mode "${p.mode}". Use 'linear', 'radial' or 'grid'.`);
		}
		const sizeIn = maybeParse(p.element_size);
		if (!Array.isArray(sizeIn) || sizeIn.length < 3) {
			throw new Error('element_size [width, height, depth] is required.');
		}
		const size0 = numN(sizeIn, 3, [1, 1, 1]);
		if (size0.some((v) => v <= 0)) throw new Error(`element_size must be positive on every axis (got ${size0.join(', ')}).`);

		const rand = makeRandom(p.seed);
		const jitter = numN(maybeParse(p.jitter), 3, [0, 0, 0]);
		const decay = numN(maybeParse(p.size_decay), 3, [0, 0, 0]);
		const stagger = numOr(p.depth_stagger, 0);
		const anchor = p.anchor || 'center';
		const distribution = String(p.distribution || 'span').toLowerCase();
		if (!['span', 'cells'].includes(distribution)) {
			throw new Error(`Unknown distribution "${p.distribution}". Use 'span' (first and last element land on start/end) or 'cells' (evenly tiled, nothing hangs off the ends).`);
		}
		const rotRange = maybeParse(p.rotation_range);
		const rotMin = rotRange && rotRange.min !== undefined ? num3(rotRange.min, [0, 0, 0]) : null;
		const rotMax = rotRange && rotRange.max !== undefined ? num3(rotRange.max, [0, 0, 0]) : null;
		const baseRot = num3(maybeParse(p.rotation), [0, 0, 0]);

		const at = (n, i) => (distribution === 'cells' ? (i + 0.5) / n : (n > 1 ? i / (n - 1) : 0));
		const points = [];
		let autoDepthAxis = 2;

		if (mode === 'linear') {
			const count = Math.round(numOr(p.count, 0));
			if (!(count > 0)) throw new Error('count (>0) is required for linear mode.');
			assertBudget(count, 'generate_array', numOr(p.max_cubes, MAX_GENERATED));
			if (p.start === undefined || p.end === undefined) {
				throw new Error('linear mode needs start:[x,y,z] and end:[x,y,z] (the two ends of the row).');
			}
			const start = num3(maybeParse(p.start), [0, 0, 0]);
			const end = num3(maybeParse(p.end), [0, 0, 0]);
			const dir = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
			autoDepthAxis = Math.abs(dir[0]) >= Math.abs(dir[2]) ? 2 : 0;
			for (let i = 0; i < count; i++) {
				const t = at(count, i);
				points.push({ point: [start[0] + dir[0] * t, start[1] + dir[1] * t, start[2] + dir[2] * t] });
			}
		} else if (mode === 'radial') {
			const count = Math.round(numOr(p.count, 0));
			if (!(count > 0)) throw new Error('count (>0) is required for radial mode.');
			assertBudget(count, 'generate_array', numOr(p.max_cubes, MAX_GENERATED));
			if (p.center === undefined) throw new Error('radial mode needs center:[x,y,z].');
			const center = num3(maybeParse(p.center), [0, 0, 0]);
			const radii = numN(maybeParse(p.radii), 2, [4, 4]);
			const arc = numOr(p.arc_degrees, 360);
			const startDeg = numOr(p.start_degrees, 0);
			const full = Math.abs(arc) >= 359.999;
			const step = full ? arc / count : (count > 1 ? arc / (count - 1) : 0);
			for (let i = 0; i < count; i++) {
				const th = (startDeg + step * i) * Math.PI / 180;
				const cs = Math.cos(th), sn = Math.sin(th);
				points.push({
					point: [center[0] + radii[0] * cs, center[1], center[2] + radii[1] * sn],
					outward: [cs, 0, sn],
					// Turn the element so its FRONT (north / -Z face) points away from the centre.
					face_y: Math.atan2(-cs, -sn) * 180 / Math.PI,
				});
			}
		} else {
			if (p.start === undefined || p.end === undefined) {
				throw new Error('grid mode needs start:[x,y,z] and end:[x,y,z] (opposite corners of the area).');
			}
			const start = num3(maybeParse(p.start), [0, 0, 0]);
			const end = num3(maybeParse(p.end), [0, 0, 0]);
			const span = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
			let counts = maybeParse(p.counts);
			if (Array.isArray(counts) && counts.length) {
				counts = numN(counts, 3, [1, 1, 1]).map((v) => Math.max(1, Math.round(v)));
			} else {
				const count = Math.round(numOr(p.count, 0));
				if (!(count > 0)) throw new Error('grid mode needs counts:[nx,ny,nz] or count.');
				// Lay `count` elements over the two axes with the largest span.
				const order = [0, 1, 2].sort((i, j) => Math.abs(span[j]) - Math.abs(span[i]));
				const a = Math.max(1, Math.round(Math.sqrt(count)));
				const b = Math.max(1, Math.ceil(count / a));
				counts = [1, 1, 1];
				counts[order[0]] = b; counts[order[1]] = a;
			}
			autoDepthAxis = [0, 1, 2].reduce((best, i) => (counts[i] < counts[best] ? i : best), 0);
			const limit = Math.round(numOr(p.count, 0)) || Infinity;
			assertBudget(Math.min(counts[0] * counts[1] * counts[2], limit), 'generate_array', numOr(p.max_cubes, MAX_GENERATED));
			for (let ix = 0; ix < counts[0] && points.length < limit; ix++) {
				for (let iy = 0; iy < counts[1] && points.length < limit; iy++) {
					for (let iz = 0; iz < counts[2] && points.length < limit; iz++) {
						const tx = at(counts[0], ix), ty = at(counts[1], iy), tz = at(counts[2], iz);
						points.push({ point: [start[0] + span[0] * tx, start[1] + span[1] * ty, start[2] + span[2] * tz] });
					}
				}
			}
		}

		assertBudget(points.length, 'generate_array', numOr(p.max_cubes, MAX_GENERATED));

		let depthAxis = -1;
		let radialDepth = false;
		const axisWord = String(p.depth_axis || 'auto').toLowerCase();
		if (axisWord === 'none') depthAxis = -1;
		else if (axisWord === 'radial') radialDepth = true;
		else if (axisWord === 'auto') { if (mode === 'radial') radialDepth = true; else depthAxis = autoDepthAxis; }
		else if (AXIS_INDEX[axisWord] !== undefined) depthAxis = AXIS_INDEX[axisWord];
		else throw new Error(`Unknown depth_axis "${p.depth_axis}". Use 'auto', 'x', 'y', 'z', 'radial' or 'none'.`);

		const prefix = String(p.name_prefix || 'element').replace(/[_\s]+$/, '');
		const baseName = sideNameFor(prefix, p.side);
		const alignOutward = p.align_to_center !== undefined ? !!p.align_to_center : mode === 'radial';
		const specs = [];
		points.forEach((entry, i) => {
			const size = [
				Math.max(0.05, size0[0] + decay[0] * i),
				Math.max(0.05, size0[1] + decay[1] * i),
				Math.max(0.05, size0[2] + decay[2] * i),
			];
			const point = entry.point.slice();
			for (let k = 0; k < 3; k++) if (jitter[k]) point[k] += (rand() * 2 - 1) * jitter[k];
			if (stagger && (i % 2) === 1) {
				if (radialDepth && entry.outward) {
					point[0] += entry.outward[0] * stagger;
					point[2] += entry.outward[2] * stagger;
				} else if (depthAxis >= 0) {
					point[depthAxis] += stagger;
				}
			}
			const rot = baseRot.slice();
			if (rotMin && rotMax) for (let k = 0; k < 3; k++) rot[k] += rotMin[k] + rand() * (rotMax[k] - rotMin[k]);
			else if (rotMin) for (let k = 0; k < 3; k++) rot[k] += rotMin[k];
			if (alignOutward && entry.face_y !== undefined) rot[1] += entry.face_y;
			const from = anchorCorner(anchor, point, size);
			specs.push({
				name: `${baseName}_${i + 1}`,
				from,
				to: [from[0] + size[0], from[1] + size[1], from[2] + size[2]],
				origin: point,
				rotation: rot.map((v) => +v.toFixed(4)),
				inflate: numOr(p.inflate, 0),
			});
		});

		if (p.side) {
			const si = orientation().side_index;
			let lo = Infinity, hi = -Infinity;
			specs.forEach((s) => { lo = Math.min(lo, s.from[si]); hi = Math.max(hi, s.to[si]); });
			assertSide(baseName, p.side, (lo + hi) / 2, 'array');
		}

		const parent = resolveParent(p.parent);
		Undo.initEdit({ outliner: true, elements: [] });
		const cubes = specs.map((s) => createCubeIn(parent, s));
		Undo.finishEdit('MCP: generate array');
		Canvas.updateAll();

		const res = generatedReport(cubes, {
			mode, distribution, anchor,
			depth_stagger: stagger,
			depth_axis: radialDepth ? 'radial' : depthAxis >= 0 ? ['x', 'y', 'z'][depthAxis] : 'none',
			seeded: p.seed != null && p.seed !== '',
			parent: parent ? parent.name : 'root',
		});
		// Only nag about the stagger when neighbours actually overlap — a spaced
		// row of fence posts does not need one.
		const neighboursOverlap = specs.some((a, i) => {
			const b = specs[i + 1];
			return b && [0, 1, 2].every((k) => Math.min(a.to[k], b.to[k]) - Math.max(a.from[k], b.from[k]) > 0);
		});
		if (stagger === 0 && neighboursOverlap) {
			res.hint = 'depth_stagger was 0 and neighbouring elements overlap, so they sit at the same depth and will z-fight. Pass depth_stagger 0.05-0.2 for overlapping rows (scales, shingles, plates).';
		}
		return reportZFighting(res, cubes,
			'depth_stagger only alternates neighbours, so a row where each element overlaps two or more others still lines up (i and i+2 share a depth), and elements at the same height share their top/bottom planes. Fix: raise `jitter` above 0.05 on the axes that align, space the elements about one element_size apart, or add a small `rotation_range`.');
	},

	/**
	 * A chain of tapering segments that curves as it goes — optionally one
	 * bone per segment so it can be animated. Universal for tentacles, horns,
	 * claws, curved tails, branches, snake bodies, braids, cables, antennae.
	 */
	extrude_chain(p) {
		requireProject();
		p = p || {};
		const segments = Math.round(numOr(p.segments, 4));
		if (!(segments >= 1)) throw new Error('segments must be at least 1.');
		if (segments > 64) throw new Error(`segments ${segments} is over the 64 cap — a chain that long is almost never what you want.`);
		const base = num3(maybeParse(p.base_origin), [0, 0, 0]);
		const segLen = numOr(p.segment_length, 4);
		if (!(segLen > 0)) throw new Error('segment_length must be greater than 0.');
		const sizeIn = numN(maybeParse(p.initial_size), 2, [4, 4]);
		if (sizeIn.some((v) => v <= 0)) throw new Error('initial_size [width, depth] must be positive.');
		const taper = Math.min(0.98, Math.max(0, numOr(p.taper, 0.35)));
		const lengthTaper = Math.min(0.9, Math.max(0, numOr(p.length_taper, 0)));
		const curvature = num3(maybeParse(p.curvature), [0, 0, 0]);
		const baseRot = num3(maybeParse(p.base_rotation), [0, 0, 0]);
		const createBones = p.create_bones !== false;

		const o = orientation();
		const DIRECTIONS = {
			up: [0, 1, 0], down: [0, -1, 0],
			forward: o.front_vec, back: o.back_vec,
			left: o.left_vec, right: o.right_vec,
		};
		const dirWord = String(p.direction || 'up').toLowerCase();
		const grow = DIRECTIONS[dirWord];
		if (!grow) throw new Error(`Unknown direction "${p.direction}". Use up, down, forward, back, left or right.`);
		const gi = grow.findIndex((v) => v !== 0);
		// Cross-section axes: width first, then depth.
		const cross = gi === 1 ? [0, 2] : gi === 0 ? [2, 1] : [0, 1];

		const parent = resolveParent(p.parent);
		const name = sideNameFor(p.name || 'chain', p.side);
		if (p.side) assertSide(name, p.side, base[o.side_index], 'chain');

		// Segment sizes and lengths up front, so a bad taper fails before any
		// geometry exists.
		const plan = [];
		for (let i = 0; i < segments; i++) {
			const t = segments > 1 ? i / (segments - 1) : 0;
			const shrink = Math.max(0.05, 1 - taper * t);
			plan.push({
				w: Math.max(0.05, sizeIn[0] * shrink),
				d: Math.max(0.05, sizeIn[1] * shrink),
				len: Math.max(0.05, segLen * Math.max(0.05, 1 - lengthTaper * t)),
			});
		}

		// Rotation accumulates: segment i ends up at base_rotation * curvature^i.
		// With bones that happens for free (each bone adds its own rotation on
		// top of its parent's); without them we do the maths here.
		const rotations = [];
		let acc = eulerToMat(baseRot);
		const curveMat = eulerToMat(curvature);
		for (let i = 0; i < segments; i++) {
			rotations.push(acc);
			acc = matMul(acc, curveMat);
		}

		// Joint positions along the real (curved) path — used for un-parented
		// cubes and, either way, to report where the tip lands.
		const joints = [base.slice()];
		for (let i = 0; i < segments; i++) {
			const step = matApply(rotations[i], [grow[0] * plan[i].len, grow[1] * plan[i].len, grow[2] * plan[i].len]);
			const prev = joints[i];
			joints.push([prev[0] + step[0], prev[1] + step[1], prev[2] + step[2]]);
		}

		Undo.initEdit({ outliner: true, elements: [] });
		const bones = [];
		const cubes = [];
		let straightAt = base.slice(); // rest-pose position when bones carry the curve
		let holder = parent;
		for (let i = 0; i < segments; i++) {
			const seg = plan[i];
			// Where this segment's box lives BEFORE its own rotation is applied.
			const jointPoint = createBones ? straightAt.slice() : joints[i].slice();
			const from = jointPoint.slice();
			const to = jointPoint.slice();
			to[gi] = jointPoint[gi] + grow[gi] * seg.len;
			const half = [seg.w / 2, seg.d / 2];
			cross.forEach((axis, k) => {
				from[axis] = jointPoint[axis] - half[k];
				to[axis] = jointPoint[axis] + half[k];
			});

			if (createBones) {
				const bone = new Group({
					name: `${name}${i + 1}`,
					origin: jointPoint.map(R3),
					rotation: (i === 0 ? baseRot : curvature).map(R3),
				}).init();
				bone.addTo(holder || 'root');
				bones.push(bone);
				holder = bone;
				cubes.push(createCubeIn(bone, {
					name: `${name}${i + 1}_seg`, from, to, origin: jointPoint, inflate: numOr(p.inflate, 0),
				}));
				straightAt = straightAt.slice();
				straightAt[gi] += grow[gi] * seg.len;
			} else {
				cubes.push(createCubeIn(parent, {
					name: `${name}${i + 1}_seg`, from, to, origin: jointPoint,
					rotation: matToEuler(rotations[i]), inflate: numOr(p.inflate, 0),
				}));
			}
		}
		Undo.finishEdit('MCP: extrude chain');
		Canvas.updateAll();

		const res = generatedReport(cubes, {
			segments,
			direction: dirWord,
			create_bones: createBones,
			bones: bones.map((b) => ({ name: b.name, origin: b.origin, rotation: b.rotation })),
			tip: joints[segments].map(R3),
			total_length: R3(plan.reduce((s, seg) => s + seg.len, 0)),
			end_thickness: [R3(plan[segments - 1].w), R3(plan[segments - 1].d)],
			parent: parent ? parent.name : 'root',
		}, 8);
		res.note = createBones
			? 'Each segment has its own bone, nested; `curvature` is the bend ADDED per segment, so segment i sits at base_rotation + i x curvature. Animate the bones for whip/follow-through. `tip` is where the last segment ends.'
			: 'No bones: the segments carry baked rotations and cannot be animated. Some formats (java_block) only allow one rotation axis per cube — use create_bones:true there.';
		if (!createBones && Format && Format.animation_mode) {
			res.warning = 'This is an animated format and the chain has no bones. Pass create_bones:true unless the chain is meant to be rigid.';
		}
		return reportZFighting(res, cubes,
			'Segments meet end to end, so this is the chain against what it grows out of: move `base_origin` by >=0.1 so the first segment penetrates its base instead of sitting flush on it.');
	},

	/**
	 * Is this model actually detailed, or 15 boxes wearing a costume?
	 * Measures cube budget, monolithic masses, layering, micro-detail density
	 * and bone depth, and returns a verdict you are expected to act on before
	 * spending a texturing pass on a blockout.
	 */
	audit_complexity(p) {
		requireProject();
		p = p || {};
		const cubes = Cube.all.slice();
		const groups = Group.all.slice();
		const rig = detectRig();

		let target = String(p.target || 'auto').toLowerCase();
		if (target === 'auto') {
			target = rig.kind === 'unknown' ? 'prop' : (rig.kind === 'quadruped' || rig.kind === 'humanoid' || rig.kind === 'biped') ? 'character' : 'creature';
		}
		const BUDGETS = {
			prop: { minimum: 30, acceptable_from: 30, high_detail_from: 80, label: 'simple prop / small item' },
			character: { minimum: 80, acceptable_from: 100, high_detail_from: 180, label: 'standard mob / NPC' },
			creature: { minimum: 80, acceptable_from: 100, high_detail_from: 180, label: 'creature' },
			hero: { minimum: 120, acceptable_from: 180, high_detail_from: 300, label: 'hero model / boss' },
		};
		const budget = BUDGETS[target];
		if (!budget) {
			throw new Error(`Unknown target "${p.target}". Use 'auto', 'prop', 'character', 'creature' or 'hero'.`);
		}
		const minimum = Math.round(numOr(p.min_cubes, budget.minimum));

		if (!cubes.length) {
			return {
				verdict: 'too_primitive', ready_for_texturing: false, target,
				budget: Object.assign({ target }, budget, { minimum }),
				cubes: 0, groups: groups.length,
				issues: [{ issue: 'empty_model', hint: 'There is no geometry yet. Build the rig (create_rig) and the primary masses first.' }],
				recommendations: ['create_rig, then add_cubes / add_hollow_volume for the primary masses.'],
			};
		}

		const volOf = (c) => Math.abs((c.to[0] - c.from[0]) * (c.to[1] - c.from[1]) * (c.to[2] - c.from[2]));
		const sizeOf = (c) => [Math.abs(c.to[0] - c.from[0]), Math.abs(c.to[1] - c.from[1]), Math.abs(c.to[2] - c.from[2])];
		const info = cubes.map((c) => ({ cube: c, size: sizeOf(c), vol: volOf(c) }));
		const totalVol = info.reduce((s, e) => s + e.vol, 0) || 1;

		const monolithShare = Math.min(0.9, Math.max(0.05, numOr(p.monolith_share, 0.3)));
		const minOverlays = Math.round(numOr(p.min_overlays, 4));
		const pairCap = 2200; // O(n^2) neighbour pass; skip it on absurd models
		const doPairs = cubes.length <= pairCap;

		const overlaps = new Array(info.length).fill(0);
		const nearBy = new Array(info.length).fill(0);
		// Per-cube face coverage: is there anything sitting on this face, or is it
		// a bare wall? Faces are indexed [+x,-x,+y,-y,+z,-z].
		const bareFaces = info.map(() => [true, true, true, true, true, true]);
		let touchingPairs = 0;
		if (doPairs) {
			const pad = 0.6, band = 0.75, tol = 0.25;
			// Does b sit on the face of a that points `sign` along axis k?
			const covers = (a, b, k, sign) => {
				const o1 = (k + 1) % 3, o2 = (k + 2) % 3;
				if (Math.min(a.to[o1], b.to[o1]) - Math.max(a.from[o1], b.from[o1]) <= 0.05) return false;
				if (Math.min(a.to[o2], b.to[o2]) - Math.max(a.from[o2], b.from[o2]) <= 0.05) return false;
				return sign > 0
					? (b.from[k] < a.to[k] + band && b.to[k] > a.to[k] - tol)
					: (b.to[k] > a.from[k] - band && b.from[k] < a.from[k] + tol);
			};
			for (let i = 0; i < info.length; i++) {
				const a = info[i].cube;
				for (let j = i + 1; j < info.length; j++) {
					const b = info[j].cube;
					let intersect = true, near = true;
					for (let k = 0; k < 3; k++) {
						if (Math.min(a.to[k], b.to[k]) - Math.max(a.from[k], b.from[k]) <= 0) intersect = false;
						if (Math.min(a.to[k], b.to[k]) + pad - Math.max(a.from[k], b.from[k]) <= 0) near = false;
					}
					if (intersect) { overlaps[i]++; overlaps[j]++; touchingPairs++; }
					if (near) {
						nearBy[i]++; nearBy[j]++;
						for (let k = 0; k < 3; k++) {
							if (bareFaces[i][k * 2] && covers(a, b, k, 1)) bareFaces[i][k * 2] = false;
							if (bareFaces[i][k * 2 + 1] && covers(a, b, k, -1)) bareFaces[i][k * 2 + 1] = false;
							if (bareFaces[j][k * 2] && covers(b, a, k, 1)) bareFaces[j][k * 2] = false;
							if (bareFaces[j][k * 2 + 1] && covers(b, a, k, -1)) bareFaces[j][k * 2 + 1] = false;
						}
					}
				}
			}
		}

		const issues = [];
		const monoliths = [];
		info.forEach((e, i) => {
			const share = e.vol / totalVol;
			if (share <= monolithShare) return;
			// A big mass is only a problem when nothing is layered on top of it.
			const overlays = doPairs ? nearBy[i] : 0;
			monoliths.push({
				cube: e.cube.name, volume_share_pct: Math.round(share * 100),
				size: e.size.map(R3), overlays,
			});
			if (!doPairs || overlays < minOverlays) {
				issues.push({
					issue: 'monolithic_box', cube: e.cube.name,
					volume_share_pct: Math.round(share * 100), size: e.size.map(R3), overlays,
					hint: `"${e.cube.name}" is ${Math.round(share * 100)}% of the whole model's volume with ${overlays} neighbouring detail piece(s). Split it into segments and layer secondary volumes on top (add_hollow_volume for a shell, generate_array for plates/fringes, small cubes for trim).`,
				});
			}
		});

		const micro = info.filter((e) => e.size.every((v) => v <= 2)).length;
		const small = info.filter((e) => Math.max.apply(null, e.size) <= 4).length;
		const overlapping = overlaps.filter((n) => n > 0).length;
		const rotated = cubes.filter((c) => (c.rotation || []).some((r) => Math.abs(r) > 0.001)).length +
			groups.filter((g) => (g.rotation || []).some((r) => Math.abs(r) > 0.001)).length;
		const inflated = cubes.filter((c) => Math.abs(Number(c.inflate) || 0) > 0.001).length;

		let depth = 0;
		groups.forEach((g) => {
			let d = 1, node = g;
			while (node.parent instanceof Group) { d++; node = node.parent; }
			depth = Math.max(depth, d);
		});

		// Big BARE faces: a large surface with nothing on or near it reads as a
		// flat wall no matter how good the texture is.
		const flatArea = numOr(p.flat_face_area, 48);
		const FACE_LABELS = ['east', 'west', 'up', 'down', 'south', 'north'];
		const flatSlabs = [];
		if (doPairs) {
			info.forEach((e, i) => {
				const [w, h, d] = e.size;
				const areaOf = [h * d, h * d, w * d, w * d, w * h, w * h];
				let worst = -1;
				for (let f = 0; f < 6; f++) {
					if (bareFaces[i][f] && areaOf[f] >= flatArea && (worst < 0 || areaOf[f] > areaOf[worst])) worst = f;
				}
				if (worst >= 0) {
					flatSlabs.push({
						cube: e.cube.name, face: FACE_LABELS[worst],
						bare_face_area: R3(areaOf[worst]), size: e.size.map(R3),
					});
				}
			});
			flatSlabs.sort((x, y) => y.bare_face_area - x.bare_face_area);
		}

		const detailRatio = micro / cubes.length;
		const layerRatio = doPairs ? overlapping / cubes.length : null;

		if (cubes.length < minimum) {
			issues.push({
				issue: 'below_cube_budget', cubes: cubes.length, minimum,
				hint: `${cubes.length} cubes for a ${budget.label} is a rough blockout, not a model. Budget: acceptable from ${budget.acceptable_from}, high detail from ${budget.high_detail_from}. Add secondary volumes, fringes and micro-detail before texturing.`,
			});
		}
		if (layerRatio !== null && layerRatio < 0.25 && cubes.length >= 8) {
			issues.push({
				issue: 'no_layering', overlapping_pct: Math.round(layerRatio * 100),
				hint: 'Almost nothing overlaps anything else, so the model is a set of separate boxes rather than layered forms. Push secondary volumes (armour, cloth, plating) 0.3-0.8 out of the primary mass so they read as separate layers.',
			});
		}
		if (detailRatio < 0.15 && cubes.length >= 20) {
			issues.push({
				issue: 'low_micro_detail', micro_cubes: micro, micro_pct: Math.round(detailRatio * 100),
				hint: 'Fewer than 15% of cubes are small (<=2 units). Silhouette-breaking detail — studs, buckles, teeth, trim, rivets — is what stops a model reading as boxes. voxelize_matrix and generate_array produce it quickly.',
			});
		}
		if (flatSlabs.length) {
			issues.push({
				issue: 'undetailed_slab', count: flatSlabs.length, cubes: flatSlabs.slice(0, 8),
				hint: 'These cubes have a large face with nothing on or near it — a bare flat wall (the named face is the worst one). Break it with an overlay, a bevel cube at 45 degrees, or a generate_array row.',
			});
		}
		if (depth < 3 && groups.length > 2) {
			issues.push({
				issue: 'shallow_hierarchy', bone_depth: depth,
				hint: 'The bone tree is only ' + depth + ' deep. Segmented limbs and chains need root -> hips -> spine -> chest -> limb upper -> lower -> hand, i.e. 5+ levels. check_rig has the details.',
			});
		}
		if (rotated === 0 && cubes.length >= 20) {
			issues.push({
				issue: 'no_rotated_elements',
				hint: 'Nothing is rotated anywhere, so every edge is axis-aligned and the model reads as a grid. Rotate accents 15-45 degrees (or parent them to rotated bones) to break the silhouette.',
			});
		}

		const verdict = cubes.length < minimum ? 'too_primitive'
			: cubes.length >= budget.high_detail_from ? 'high_detail'
				: 'acceptable';
		const blocking = issues.filter((i) => ['below_cube_budget', 'monolithic_box', 'empty_model'].includes(i.issue));

		const recommendations = [];
		if (verdict === 'too_primitive') recommendations.push(`Add at least ${Math.max(0, minimum - cubes.length)} more cubes of real detail before texturing.`);
		if (issues.some((i) => i.issue === 'monolithic_box')) recommendations.push('Split every monolithic box: segment it, then layer secondary volumes with add_hollow_volume / generate_array.');
		if (issues.some((i) => i.issue === 'low_micro_detail')) recommendations.push('voxelize_matrix for emblems, blades and plate patterns; generate_array for rivets, teeth, scales.');
		if (issues.some((i) => i.issue === 'undetailed_slab')) recommendations.push('Break bare slabs with overlapping trim, 45-degree bevel cubes, or a fringe row.');
		if (!recommendations.length) recommendations.push('Density looks good — run check_model for z-fighting and untextured faces, then pack_uv and texture.');

		return {
			verdict,
			ready_for_texturing: blocking.length === 0,
			target,
			budget: Object.assign({ target }, budget, { minimum }),
			cubes: cubes.length,
			groups: groups.length,
			rig_kind: rig.kind,
			metrics: {
				micro_cubes: micro, micro_pct: Math.round(detailRatio * 100),
				small_cubes: small,
				overlapping_cubes: overlapping,
				overlapping_pct: layerRatio === null ? null : Math.round(layerRatio * 100),
				overlapping_pairs: doPairs ? touchingPairs : null,
				rotated_elements: rotated, inflated_cubes: inflated,
				bone_depth: depth,
				cubes_per_bone: groups.length ? R3(cubes.length / groups.length) : null,
				largest_cube_share_pct: Math.round(Math.max.apply(null, info.map((e) => e.vol)) / totalVol * 100),
				total_cube_volume: R3(totalVol),
				pairwise_analysis: doPairs,
			},
			monoliths,
			issue_count: issues.length,
			issues,
			recommendations,
			note: 'Density is necessary, not sufficient: a high cube count with no layering still looks flat. Pair this with compare_reference (silhouette) and check_model (z-fighting, untextured faces).',
		};
	},

	// Shelf-pack box UVs so every cube gets its own region (box-UV cubes are all
	// created at uv_offset [0,0] and otherwise share the same pixels). REQUIRED
	// before texturing a box_uv model, and re-run after adding/resizing cubes.
	// Grows the texture (preserving any paint) if the layout overflows.
	pack_uv(p) {
		requireProject();
		let cubes;
		if (!p.cubes || p.cubes === 'all') cubes = Cube.all.slice();
		else cubes = toList(p.cubes).map(findElement).filter((c) => c instanceof Cube);
		if (!cubes.length) throw new Error('No cubes to pack.');
		const pad = p.padding != null ? p.padding | 0 : 1;
		Undo.initEdit({ elements: cubes, uv_only: true });
		let res = packBoxUV(cubes, Project.texture_width, pad);
		if (p.auto_resize !== false && res.used[1] > Project.texture_height) {
			let newH = Project.texture_height || 16;
			while (newH < res.used[1]) newH *= 2;
			const newW = Project.texture_width;
			Project.texture_height = newH;
			Texture.all.forEach((t) => {
				const c = document.createElement('canvas');
				c.width = newW; c.height = newH;
				const x = c.getContext('2d'); x.imageSmoothingEnabled = false;
				if (t.img) { try { x.drawImage(t.img, 0, 0); } catch (e) {} }
				t.updateSource(c.toDataURL()); t.width = newW; t.height = newH;
			});
			res = packBoxUV(cubes, newW, pad);
			updateProjectResolution && updateProjectResolution();
		}
		Undo.finishEdit('MCP: pack UV');
		Canvas.updateAll();
		return { packed: res.packed, used: res.used, texture_size: [Project.texture_width, Project.texture_height] };
	},

	// Create a flat 2-sided plane (billboard) — the building block of pixel VFX:
	// flames, energy sheets, slashes, motion trails. Implemented as a zero-depth
	// cube whose two large faces share the texture; set the VFX texture's
	// render_sides to 'double' so it shows from both sides. `crossed` makes an
	// X of two perpendicular planes for a volumetric particle look.
	add_plane(p) {
		requireProject();
		const parent = p.parent ? findGroup(p.parent) : null;
		if (p.parent && !parent) throw new Error('Parent group not found: ' + p.parent);
		const from = num3(p.from, [0, 0, 0]);
		const facing = (p.facing || 'z').toLowerCase();
		const W = p.width != null ? Number(p.width) : 16;
		const H = p.height != null ? Number(p.height) : 16;
		const tex = p.texture ? findTexture(p.texture) : (Texture.getDefault ? Texture.getDefault() : Texture.all[0]);
		const bigFaces = facing === 'x' ? ['east', 'west'] : facing === 'y' ? ['up', 'down'] : ['north', 'south'];
		const dims = () => {
			if (facing === 'z') return [from[0] + W, from[1] + H, from[2]];
			if (facing === 'x') return [from[0], from[1] + H, from[2] + W];
			return [from[0] + W, from[1], from[2] + H]; // y-facing (flat horizontal): W x H on x/z
		};
		const buildOne = (f, t, name, rot) => {
			const cube = new Cube({
				name: name || (p.name || 'plane'),
				from: f, to: t,
				origin: num3(p.origin, [(f[0] + t[0]) / 2, (f[1] + t[1]) / 2, (f[2] + t[2]) / 2]),
				rotation: num3(rot || p.rotation, [0, 0, 0]),
				box_uv: false, autouv: 1,
			}).init();
			cube.addTo(parent || 'root');
			if (tex) {
				for (const dir in cube.faces) {
					const face = cube.faces[dir];
					if (!face) continue;
					if (bigFaces.indexOf(dir) >= 0) { face.texture = tex.uuid; face.uv = [0, 0, Project.texture_width, Project.texture_height]; }
					else { face.texture = null; face.uv = [0, 0, 0, 0]; }
				}
			}
			return cube;
		};
		Undo.initEdit({ outliner: true, elements: [] });
		const made = [];
		const to = dims();
		made.push(buildOne(from, to, p.name || 'plane'));
		if (p.crossed) {
			// second plane perpendicular to the first, same centre
			const cxv = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2];
			let f2, t2, big2;
			if (facing === 'z') { f2 = [cxv[0], from[1], from[2] - W / 2]; t2 = [cxv[0], to[1], from[2] + W / 2]; }
			else if (facing === 'x') { f2 = [from[0] - W / 2, from[1], cxv[2]]; t2 = [from[0] + W / 2, to[1], cxv[2]]; }
			else { f2 = [cxv[0], from[1], from[2]]; t2 = [cxv[0], to[1], to[2]]; }
			const c2 = buildOne(f2, t2, (p.name || 'plane') + '_x');
			made.push(c2);
		}
		Undo.finishEdit('MCP: add plane');
		Canvas.updateAll();
		return { created: made.length, planes: made.map(serializeElement) };
	},

	// Create a non-cuboid MESH primitive (crystal/gem/shard, pyramid, wedge,
	// cone, cylinder, plane) so models aren't limited to axis-aligned boxes —
	// great for crystals, blades, horns, teeth, gems and stylised VFX cores.
	// Requires a mesh-capable format (free/generic/bedrock); GeckoLib/Java export
	// cubes only, so for those build crystals from rotated cubes instead.
	add_mesh(p) {
		requireProject();
		if (typeof Mesh === 'undefined') throw new Error('Meshes are not available in this Blockbench build.');
		if (Format && Format.meshes === false) throw new Error('Current format does not support meshes. Use a free/generic project, or build the shape from rotated cubes.');
		const parent = p.parent ? findGroup(p.parent) : null;
		if (p.parent && !parent) throw new Error('Parent group not found: ' + p.parent);
		const shape = (p.shape || 'crystal').toLowerCase();
		const size = num3(p.size, [8, 8, 8]);
		const from = num3(p.from, [-size[0] / 2, 0, -size[2] / 2]);
		const prim = meshPrimitive(shape, size[0], size[1], size[2], p.segments);
		const tex = p.texture ? findTexture(p.texture) : (Texture.getDefault ? Texture.getDefault() : Texture.all[0]);
		const uvRect = Array.isArray(p.uv) ? p.uv : [0, 0, Project.texture_width, Project.texture_height];
		Undo.initEdit({ outliner: true, elements: [] });
		const mesh = new Mesh({
			name: p.name || shape,
			origin: num3(p.origin, [from[0] + size[0] / 2, from[1] + size[1] / 2, from[2] + size[2] / 2]),
			rotation: num3(p.rotation, [0, 0, 0]),
		});
		const keys = prim.verts.map((v) => mesh.addVertices([from[0] + v[0], from[1] + v[1], from[2] + v[2]])[0]);
		prim.faces.forEach((face) => {
			const f = new MeshFace(mesh, { vertices: face.map((i) => keys[i]) });
			if (tex) f.texture = tex.uuid;
			mesh.addFaces(f);
			setMeshFaceUV(mesh, f, uvRect);
		});
		mesh.init().addTo(parent || 'root');
		Undo.finishEdit('MCP: add mesh');
		Canvas.updateAll();
		return { uuid: mesh.uuid, name: mesh.name, type: 'mesh', shape, vertices: Object.keys(mesh.vertices).length, faces: Object.keys(mesh.faces).length };
	},

	// Mirror a cube or group across an axis about a pivot (default x=0) — build
	// one side, then mirror it for perfect symmetry. Returns the clones.
	mirror_element(p) {
		requireProject();
		const axis = ({ x: 0, y: 1, z: 2 })[(p.axis || 'x').toLowerCase()];
		const pivot = p.pivot != null ? Number(p.pivot) : 0;
		const targets = (p.elements ? toList(p.elements) : [p.element]).map(findNode).filter(Boolean);
		if (!targets.length) throw new Error('No element(s) found to mirror.');
		Undo.initEdit({ outliner: true, elements: [] });
		const out = [];
		const reflect = (v) => { const r = v.slice(); r[axis] = 2 * pivot - r[axis]; return r; };
		const cloneCube = (cube, parent) => {
			const f = reflect(cube.from), t = reflect(cube.to);
			const lo = f.slice(), hi = t.slice();
			if (lo[axis] > hi[axis]) { const tmp = lo[axis]; lo[axis] = hi[axis]; hi[axis] = tmp; }
			const rot = cube.rotation.slice();
			// flip the two rotation components not on the mirror axis
			[0, 1, 2].forEach((i) => { if (i !== axis) rot[i] = -rot[i]; });
			const c = new Cube({
				name: cube.name.replace(/left/i, 'right').replace(/_l$/i, '_r') + (/(left|_l$|right|_r$)/i.test(cube.name) ? '' : '_m'),
				from: lo, to: hi, origin: reflect(cube.origin), rotation: rot,
				inflate: cube.inflate, box_uv: cube.box_uv, uv_offset: cube.uv_offset ? cube.uv_offset.slice() : undefined,
			}).init();
			c.addTo(parent || 'root');
			for (const dir in cube.faces) { if (c.faces[dir] && cube.faces[dir]) c.faces[dir].texture = cube.faces[dir].texture; }
			return c;
		};
		targets.forEach((el) => {
			if (el instanceof Group) {
				const ng = new Group({ name: el.name.replace(/left/i, 'right'), origin: reflect(el.origin), rotation: el.rotation.map((r, i) => i === axis ? r : -r) }).init();
				ng.addTo(el.parent && el.parent !== 'root' ? el.parent : 'root');
				el.children.forEach((ch) => { if (ch instanceof Cube) cloneCube(ch, ng); });
				out.push(serializeGroup(ng));
			} else if (el instanceof Cube) {
				out.push(serializeElement(cloneCube(el, el.parent && el.parent !== 'root' ? el.parent : 'root')));
			}
		});
		Undo.finishEdit('MCP: mirror');
		Canvas.updateAll();
		return { created: out.length, elements: out };
	},

	edit_element(p) {
		requireProject();
		const el = findNode(p.element || p.uuid || p.name);
		if (!el) throw new Error('Element not found: ' + (p.element || p.uuid || p.name));
		const isGroup = el instanceof Group;
		Undo.initEdit(isGroup ? { group: el } : { elements: [el] });
		if (p.new_name !== undefined) el.name = p.new_name;
		if (p.origin) el.origin = num3(p.origin, el.origin);
		if (p.rotation) el.rotation = num3(p.rotation, el.rotation);
		if (!isGroup) {
			if (p.from) el.from = num3(p.from, el.from);
			if (p.to) el.to = num3(p.to, el.to);
			if (p.inflate !== undefined) el.inflate = Number(p.inflate);
		}
		if (p.visibility !== undefined) el.visibility = !!p.visibility;
		if (p.parent !== undefined) {
			const parent = p.parent === 'root' ? 'root' : findGroup(p.parent);
			if (p.parent !== 'root' && !parent) throw new Error('Parent group not found: ' + p.parent);
			el.addTo(parent);
		}
		Undo.finishEdit('MCP: edit element');
		Canvas.updateAll();
		return isGroup ? serializeGroup(el) : serializeElement(el);
	},

	delete_element(p) {
		requireProject();
		const el = findNode(p.element || p.uuid || p.name);
		if (!el) throw new Error('Element not found: ' + (p.element || p.uuid || p.name));
		Undo.initEdit({ outliner: true, elements: el instanceof Group ? [] : [el] });
		el.remove(false);
		Undo.finishEdit('MCP: delete element');
		Canvas.updateAll();
		return { deleted: true };
	},

	list_outliner() {
		requireProject();
		return outlinerTree();
	},

	get_element(p) {
		requireProject();
		const el = findNode(p.element || p.uuid || p.name);
		if (!el) throw new Error('Element not found: ' + (p.element || p.uuid || p.name));
		return el instanceof Group ? serializeGroup(el, true) : serializeElement(el);
	},

	// Audit the model for common problems that make results look broken: faces
	// with no texture (the untextured "gaps"), zero-area or out-of-bounds UVs,
	// degenerate cube sizes, and (for animated formats) cubes not parented to a
	// bone. Run this before screenshotting to fix issues proactively.
	check_model() {
		requireProject();
		const tw = Project.texture_width, th = Project.texture_height;
		const animMode = !!(Format && Format.animation_mode);
		const issues = [];
		Cube.all.forEach((cube) => {
			for (const dir in cube.faces) {
				const f = cube.faces[dir];
				if (!f) continue;
				if (!f.texture) issues.push({ cube: cube.name, face: dir, issue: 'no_texture' });
				const u = f.uv || [0, 0, 0, 0];
				const w = Math.abs(u[2] - u[0]), h = Math.abs(u[3] - u[1]);
				if (w <= 0 || h <= 0) issues.push({ cube: cube.name, face: dir, issue: 'zero_uv', uv: u });
				else if (Math.max(u[0], u[2]) > tw + 0.01 || Math.max(u[1], u[3]) > th + 0.01 ||
					Math.min(u[0], u[1], u[2], u[3]) < -0.01)
					issues.push({ cube: cube.name, face: dir, issue: 'uv_out_of_bounds', uv: u });
			}
			const s = [cube.to[0] - cube.from[0], cube.to[1] - cube.from[1], cube.to[2] - cube.from[2]];
			if (s[0] <= 0 || s[1] <= 0 || s[2] <= 0) issues.push({ cube: cube.name, issue: 'degenerate_size', size: s });
			if (animMode && (!cube.parent || cube.parent === 'root'))
				issues.push({ cube: cube.name, issue: 'no_bone_parent' });
		});

		// Z-FIGHTING / clipping detection: two faces sharing the same plane and
		// overlapping in area will flicker (the "two squares inside one another"
		// texture-clip). We flag unrotated cube pairs that share a min- or max-
		// plane on an axis AND overlap by real area on the other two axes (their
		// coplanar faces point the SAME way, so both render and fight). Fix by
		// offsetting one cube by >=0.1 (or insetting it) so the faces aren't coplanar.
		const ortho = Cube.all.filter((c) => c.rotation && c.rotation.every((r) => Math.abs(r) < 0.001));
		const ov = (a1, a2, b1, b2) => Math.min(a2, b2) - Math.max(a1, b1);
		const zEps = 0.02;
		let zFights = 0;
		for (let i = 0; i < ortho.length && zFights < 80; i++) {
			for (let j = i + 1; j < ortho.length && zFights < 80; j++) {
				const a = ortho[i], b = ortho[j];
				for (let ax = 0; ax < 3; ax++) {
					const o1 = (ax + 1) % 3, o2 = (ax + 2) % 3;
					if (ov(a.from[o1], a.to[o1], b.from[o1], b.to[o1]) <= 0.1) continue;
					if (ov(a.from[o2], a.to[o2], b.from[o2], b.to[o2]) <= 0.1) continue;
					const sameMin = Math.abs(a.from[ax] - b.from[ax]) < zEps;
					const sameMax = Math.abs(a.to[ax] - b.to[ax]) < zEps;
					if (sameMin || sameMax) {
						issues.push({
							issue: 'coplanar_overlap', cubes: [a.name, b.name],
							axis: ['x', 'y', 'z'][ax], plane: sameMin ? a.from[ax] : a.to[ax],
							hint: 'faces coplanar -> z-fight; offset one cube by >=0.1 on this axis',
						});
						zFights++;
						break;
					}
				}
			}
		}

		// Left/right sanity is part of "is this model broken?", so fold it in.
		try { commands.check_sides().issues.forEach((i) => issues.push(i)); } catch (e) {}

		const byType = {};
		issues.forEach((i) => { byType[i.issue] = (byType[i.issue] || 0) + 1; });
		return {
			cubes: Cube.all.length, groups: Group.all.length, textures: Texture.all.length,
			texture_size: [tw, th], animation_format: animMode,
			orientation: orientationReport().summary,
			issue_count: issues.length, by_type: byType, issues,
		};
	},

	// ---- UV / textures on faces ------------------------------------------
	set_cube_uv(p) {
		requireProject();
		const cube = findElement(p.cube || p.uuid || p.name);
		if (!cube || !(cube instanceof Cube)) throw new Error('Cube not found: ' + (p.cube || p.uuid || p.name));
		Undo.initEdit({ elements: [cube], uv_only: true });
		for (const dir in p.faces || {}) {
			const face = cube.faces[dir];
			if (!face) continue;
			const fd = p.faces[dir];
			if (fd.uv) face.uv = fd.uv;
			if (fd.rotation !== undefined) face.rotation = fd.rotation;
			if (fd.texture !== undefined) {
				const tex = findTexture(fd.texture);
				face.texture = tex ? tex.uuid : false;
			}
		}
		Undo.finishEdit('MCP: set UV');
		Canvas.updateAll();
		return serializeElement(cube);
	},

	apply_texture(p) {
		requireProject();
		const tex = findTexture(p.texture);
		if (!tex) throw new Error('Texture not found: ' + p.texture);
		let targets;
		if (p.element) {
			const el = findElement(p.element);
			if (!el) throw new Error('Element not found: ' + p.element);
			targets = [el];
		} else {
			targets = Cube.all;
		}
		Undo.initEdit({ elements: targets });
		targets.forEach((el) => el.applyTexture && el.applyTexture(tex, true));
		Undo.finishEdit('MCP: apply texture');
		Canvas.updateAll();
		return { applied_to: targets.length };
	},

	// ---- textures ---------------------------------------------------------
	create_texture(p) {
		requireProject();
		const width = p.width || Project.texture_width || 16;
		const height = p.height || Project.texture_height || 16;
		const dataURL = p.data_url || blankTextureDataURL(width, height, p.fill || null);
		Undo.initEdit({ textures: [] });
		const tex = new Texture({ name: p.name || 'texture', width, height }).fromDataURL(dataURL).add(false);
		if (p.particle) tex.enableParticle();
		Undo.finishEdit('MCP: create texture');
		// fromDataURL loads the bitmap asynchronously; if a later tool edits the
		// texture before that load finishes, the canvas is still the default 16x16
		// and the paint is clipped/corrupted. Wait for the image so the texture is
		// guaranteed to be the requested size and ready to paint.
		return new Promise((resolve) => {
			const finish = () => { tex.width = width; tex.height = height; resolve(serializeTexture(tex)); };
			if (tex.img && tex.img.complete && tex.img.naturalWidth) return finish();
			if (tex.img && tex.img.addEventListener) {
				tex.img.addEventListener('load', finish, { once: true });
				setTimeout(finish, 400); // safety net
			} else {
				finish();
			}
		});
	},

	// Generate a pixelated VFX texture: a bright hot core fading to cool edges in
	// quantized colour bands with jagged transparent edges. `style` picks the
	// shape (flame, energy, orb, spark, smoke, trail, beam, bolt, ring,
	// shockwave, crystal). With frames>1 it bakes a vertical FLIPBOOK and starts
	// the texture animator so the effect loops. Defaults to an emissive/additive
	// render mode and 2-sided rendering so it glows on a plane. Use a `preset`
	// or explicit `palette` to colour it (e.g. energy/ice/fire/arcane/poison).
	create_vfx_texture(p) {
		requireProject();
		const style = (p.style || 'energy').toLowerCase();
		const w = (p.width | 0) || 16;
		const h = (p.height | 0) || ((style === 'flame' || style === 'fire' || style === 'beam' || style === 'beam_v') ? 24 : 16);
		const frames = Math.max(1, (p.frames | 0) || 1);
		const palette = Array.isArray(p.palette) ? p.palette
			: (VFX_PALETTES[p.preset] || VFX_PALETTES[style] || VFX_PALETTES.energy);
		const seed = p.seed != null ? Number(p.seed) : (Math.random() * 1000) | 0;
		const softEdge = p.soft_edge != null ? !!p.soft_edge : (style === 'orb' || style === 'glow' || style === 'smoke');
		const canvas = buildVfxCanvas(w, h, frames, style, palette, seed, softEdge);
		Undo.initEdit({ textures: [] });
		const tex = new Texture({ name: p.name || (style + '_vfx'), width: w, height: h * frames })
			.fromDataURL(canvas.toDataURL()).add(false);
		// One frame tall per UV island so Blockbench counts frames correctly.
		try { tex.uv_width = w; tex.uv_height = h; } catch (e) {}
		const rm = p.render_mode || (VFX_OPAQUE[style] ? 'emissive' : 'additive');
		try { tex.render_mode = rm; } catch (e) {}
		try { tex.render_sides = p.render_sides || 'double'; } catch (e) {}
		if (frames > 1) {
			tex.frame_time = p.frame_time != null ? Number(p.frame_time) : 2;
			tex.frame_interpolate = !!p.frame_interpolate;
			tex.frame_order_type = p.frame_order_type || 'loop';
		}
		if (p.particle) tex.enableParticle();
		try { tex.updateMaterial && tex.updateMaterial(); } catch (e) {}
		if (frames > 1) { try { TextureAnimator.start(); } catch (e) {} }
		Undo.finishEdit('MCP: create vfx texture');
		Canvas.updateAll && Canvas.updateAll();
		return Object.assign(serializeTexture(tex), { style, frames, palette });
	},

	// Set a texture's render mode (default | emissive | additive | layered |
	// normal | height | mer), 2-sided rendering, flipbook frame timing, or
	// particle flag. Use emissive/additive to make VFX (flames/energy/glow) light
	// up and ignore scene shading; render_sides 'double' shows planes from both
	// sides. `animate:true` starts the texture-animation player for flipbooks.
	set_texture_render_mode(p) {
		requireProject();
		const tex = findTexture(p.texture);
		if (!tex) throw new Error('Texture not found: ' + p.texture);
		if (p.render_mode) tex.render_mode = p.render_mode;
		if (p.render_sides) tex.render_sides = p.render_sides;
		if (p.frame_time != null) tex.frame_time = Number(p.frame_time);
		if (p.frame_interpolate != null) tex.frame_interpolate = !!p.frame_interpolate;
		if (p.frame_order_type) tex.frame_order_type = p.frame_order_type;
		if (p.particle === true) tex.enableParticle();
		try { tex.updateMaterial && tex.updateMaterial(); } catch (e) {}
		if (p.animate) { try { TextureAnimator.start(); } catch (e) {} }
		Canvas.updateAll && Canvas.updateAll();
		return serializeTexture(tex);
	},

	import_texture(p) {
		requireProject();
		requireApp();
		if (!p.path) throw new Error('path is required');
		Undo.initEdit({ textures: [] });
		const tex = new Texture({ name: p.name }).fromPath(p.path).add(false);
		Undo.finishEdit('MCP: import texture');
		return serializeTexture(tex);
	},

	list_textures() {
		requireProject();
		return Texture.all.map(serializeTexture);
	},

	get_texture(p) {
		requireProject();
		const tex = findTexture(p.texture);
		if (!tex) throw new Error('Texture not found: ' + p.texture);
		return {
			texture: serializeTexture(tex),
			data_url: tex.getDataURL(),
		};
	},

	paint_texture(p) {
		requireProject();
		const tex = findTexture(p.texture);
		if (!tex) throw new Error('Texture not found: ' + p.texture);
		if (!Array.isArray(p.ops) || !p.ops.length) throw new Error('ops (array) is required');
		tex.edit((canvas) => {
			const ctx = canvas.getContext('2d');
			ctx.imageSmoothingEnabled = false;
			applyPaintOps(ctx, p.ops);
		}, { edit_name: p.edit_name || 'MCP: paint texture', no_undo: false });
		return { painted: true, ops: p.ops.length, texture: serializeTexture(tex) };
	},

	// High-level SMOOTH base coat (the "@volmur / Hytale" look). Assigns the
	// texture to every chosen face (no untextured gaps), then per face bakes a
	// soft vertical gradient in the region's base colour + gentle directional
	// shading (top lighter, underside darker) + a SUBTLE low-contrast mottle,
	// and finally a 3x3 box blur per UV island (the "smooth brush"). Cubes whose
	// name matches `glow_regex` are filled bright with no shading/blur so they
	// read as emissive. NO harsh per-pixel noise and NO dark per-face outline by
	// default — that is the dirty/blocky look to avoid. Paint crisp features with
	// paint_faces AFTER this.
	detail_cubes(p) {
		requireProject();
		let tex = p.texture ? findTexture(p.texture) : null;
		if (!tex && Texture.getDefault) tex = Texture.getDefault();
		if (!tex) tex = Texture.all[0];
		if (!tex) throw new Error('No texture to paint on. Create one first with create_texture.');

		let cubes;
		if (!p.cubes || p.cubes === 'all') cubes = Cube.all.slice();
		else cubes = toList(p.cubes).map(findElement).filter((c) => c instanceof Cube);
		if (!cubes.length) throw new Error('No matching cubes.');

		const base = p.base || '#9c9c9c';
		const colors = p.colors || null;                              // region colour map
		const mottle = p.noise != null ? Number(p.noise) : 0.06;       // subtle, low default
		const blurAmt = p.blur != null ? Number(p.blur) : 0.55;        // the smooth brush
		const topLight = p.top_light != null ? Number(p.top_light) : 0.12;
		const bottomDark = p.bottom_dark != null ? Number(p.bottom_dark) : 0.22;
		const edgeDark = p.edge_darken != null ? Number(p.edge_darken) : 0; // OFF by default
		const streaks = !!p.streaks;                                   // fur/grain streaks
		const glowRe = p.glow_regex ? new RegExp(p.glow_regex, 'i') : /_core$|_glow$/i;
		const faceMul = {
			up: 1 + topLight, down: 1 - bottomDark,
			north: 0.95, south: 1.0, east: 1.06, west: 0.88,
		};
		const scale = tex.width / (Project.texture_width || tex.width);

		const jobs = [];
		Undo.initEdit({ elements: cubes });
		cubes.forEach((cube) => {
			const baseCol = regionColorFor(cube.name, colors, base);
			const glow = glowRe.test(cube.name);
			for (const dir in cube.faces) {
				const face = cube.faces[dir];
				if (!face) continue;
				face.texture = tex.uuid;
				const r = faceRect(face, scale);
				if (r.w <= 0 || r.h <= 0) continue;
				jobs.push({ r, dir, base: baseCol, glow, mul: faceMul[dir] != null ? faceMul[dir] : 1 });
			}
		});
		Undo.finishEdit('MCP: assign texture');

		tex.edit((canvas) => {
			const ctx = canvas.getContext('2d');
			ctx.imageSmoothingEnabled = false;
			// 1) gradient base coat per face
			jobs.forEach(({ r, base, glow, mul }) => {
				const g = ctx.createLinearGradient(0, r.y, 0, r.y + r.h);
				if (glow) {
					g.addColorStop(0, shadeHex(base, 1.12));
					g.addColorStop(0.5, shadeHex(base, 1.42));
					g.addColorStop(1, shadeHex(base, 1.05));
				} else {
					g.addColorStop(0, shadeHex(base, mul * 1.1));
					g.addColorStop(1, shadeHex(base, mul * 0.84));
				}
				ctx.fillStyle = g;
				ctx.fillRect(r.x, r.y, r.w, r.h);
				if (edgeDark > 0 && r.w > 2 && r.h > 2 && !glow) {
					ctx.fillStyle = shadeHex(base, mul * (1 - edgeDark));
					ctx.fillRect(r.x, r.y, r.w, 1);
					ctx.fillRect(r.x, r.y + r.h - 1, r.w, 1);
					ctx.fillRect(r.x, r.y, 1, r.h);
					ctx.fillRect(r.x + r.w - 1, r.y, 1, r.h);
				}
			});
			// 2) subtle low-contrast mottle (skip glow)
			if (mottle > 0) jobs.forEach(({ r, base, glow, mul }) => {
				if (glow) return;
				const count = Math.max(1, Math.floor(r.w * r.h * 0.10));
				for (let i = 0; i < count; i++) {
					const px = r.x + (Math.random() * r.w | 0);
					const py = r.y + (Math.random() * r.h | 0);
					ctx.fillStyle = shadeHex(base, mul * (1 - mottle + Math.random() * mottle * 2));
					ctx.fillRect(px, py, 1, Math.random() < 0.5 ? 2 : 1);
				}
			});
			// 3) optional grain streaks on top / back faces (fur, wood, stone)
			if (streaks) jobs.forEach(({ r, dir, base, glow, mul }) => {
				if (glow || (dir !== 'up' && dir !== 'north')) return;
				const lines = Math.max(1, Math.floor(r.w / 4));
				for (let i = 0; i < lines; i++) {
					const px = r.x + (Math.random() * r.w | 0);
					ctx.fillStyle = shadeHex(base, mul * (0.78 + Math.random() * 0.12));
					ctx.fillRect(px, r.y + 1, 1, Math.max(1, r.h - 2));
				}
			});
			// 4) smooth-brush blur per island (skip glow for crisp glow edges)
			if (blurAmt > 0) jobs.forEach(({ r, glow }) => {
				if (!glow) blurRect(ctx, r.x, r.y, r.w, r.h, blurAmt);
			});
		}, { edit_name: 'MCP: detail cubes (smooth)', no_undo: false });

		Canvas.updateAll();
		return { textured: cubes.length, faces: jobs.length, smooth: true, texture: serializeTexture(tex) };
	},

	// Paint specific cube faces using coordinates RELATIVE to each face's UV
	// rect (so [0,0] is the top-left of that face). No need to compute absolute
	// UVs by hand — this is how you place eyes, nostrils, stripes, patterns, etc.
	paint_faces(p) {
		requireProject();
		const items = p.faces
			? toList(p.faces)
			: [{ cube: p.cube, face: p.face, base: p.base, ops: p.ops, texture: p.texture }];
		const byTex = new Map();
		for (const it of items) {
			const cube = findElement(it.cube);
			if (!cube || !(cube instanceof Cube)) throw new Error('Cube not found: ' + it.cube);
			const dirs = (!it.face || it.face === 'all') ? Object.keys(cube.faces) : toList(it.face);
			for (const dir of dirs) {
				const face = cube.faces[dir];
				if (!face) continue;
				let tex = it.texture ? findTexture(it.texture) : (p.texture ? findTexture(p.texture) : null);
				if (!tex && face.texture) tex = findTexture(face.texture);
				if (!tex && Texture.getDefault) tex = Texture.getDefault();
				if (!tex) tex = Texture.all[0];
				if (!tex) throw new Error('No texture available; create one first with create_texture.');
				if (face.texture !== tex.uuid) face.texture = tex.uuid;
				if (!byTex.has(tex)) byTex.set(tex, []);
				byTex.get(tex).push({ face, base: it.base, ops: it.ops || [] });
			}
		}
		let painted = 0;
		byTex.forEach((list, tex) => {
			const scale = tex.width / (Project.texture_width || tex.width);
			tex.edit((canvas) => {
				const ctx = canvas.getContext('2d');
				ctx.imageSmoothingEnabled = false;
				for (const { face, base, ops } of list) {
					const r = faceRect(face, scale);
					if (r.w <= 0 || r.h <= 0) continue;
					if (base) { ctx.fillStyle = base; ctx.fillRect(r.x, r.y, r.w, r.h); }
					if (ops && ops.length) applyPaintOps(ctx, offsetOps(ops, r.x, r.y, r.w, r.h));
					painted++;
				}
			}, { edit_name: 'MCP: paint faces', no_undo: false });
		});
		Canvas.updateAll();
		return { painted };
	},

	resize_texture(p) {
		requireProject();
		const tex = findTexture(p.texture);
		if (!tex) throw new Error('Texture not found: ' + p.texture);
		const w = p.width | 0, h = p.height | 0;
		if (!w || !h) throw new Error('width and height are required');
		Undo.initEdit({ textures: [tex], bitmap: true });
		const c = document.createElement('canvas');
		c.width = w; c.height = h;
		const ctx = c.getContext('2d');
		ctx.imageSmoothingEnabled = false;
		ctx.drawImage(tex.img, 0, 0, w, h);
		tex.updateSource(c.toDataURL());
		tex.width = w; tex.height = h;
		Undo.finishEdit('MCP: resize texture');
		return serializeTexture(tex);
	},

	// ---- animations -------------------------------------------------------
	create_animation(p) {
		requireProject();
		if (typeof Animation === 'undefined') throw new Error('Animations are not supported in this format.');
		Undo.initEdit({ animations: [] });
		const anim = new Animation({
			name: p.name || 'animation',
			loop: p.loop || 'loop',
			length: p.length || 0,
		}).add();
		if (p.length) anim.setLength(p.length);
		Undo.finishEdit('MCP: create animation');
		anim.select();
		return serializeAnimation(anim);
	},

	list_animations() {
		requireProject();
		return (Animation.all || []).map(serializeAnimation);
	},

	add_keyframe(p) {
		requireProject();
		const anim = findAnimation(p.animation);
		if (!anim) throw new Error('Animation not found: ' + p.animation);
		const group = findGroup(p.bone);
		if (!group) throw new Error('Bone (group) not found: ' + p.bone);
		const channel = p.channel || 'rotation';
		anim.select();
		const animator = anim.getBoneAnimator(group);
		if (!animator) throw new Error('Cannot animate bone in this animation scope: ' + p.bone);
		Undo.initEdit({ keyframes: [] });
		const value = p.value || [0, 0, 0];
		const kf = animator.addKeyframe({
			channel,
			time: Number(p.time) || 0,
			interpolation: p.interpolation || 'linear',
			data_points: [{ x: value[0], y: value[1], z: value[2] }],
		});
		if (anim.length < (Number(p.time) || 0)) anim.setLength(Number(p.time));
		Undo.finishEdit('MCP: add keyframe');
		updateKeyframeSelection && updateKeyframeSelection();
		return { uuid: kf && kf.uuid, channel, time: kf && kf.time };
	},

	add_keyframes(p) {
		// Bulk variant: [{bone, channel, time, value, interpolation}, ...]
		requireProject();
		const anim = findAnimation(p.animation);
		if (!anim) throw new Error('Animation not found: ' + p.animation);
		anim.select();
		const input = Array.isArray(p.keyframes) ? p.keyframes.slice() : [];
		// Every bone must exist before anything is written, so a typo cannot
		// leave half an animation behind.
		const unknown = input.map((k) => k.bone).filter((b) => !findGroup(b));
		if (unknown.length) throw new Error('Bone (group) not found: ' + Array.from(new Set(unknown)).join(', '));

		let length = Math.max(anim.length || 0, ...input.map((k) => Number(k.time) || 0));
		if (Number(p.length) > 0) length = Number(p.length);

		// close_loop: repeat each bone/channel's t=0 pose at the end of the cycle
		// so the loop does not pop — the #1 defect in hand-written cycles.
		let closed = 0;
		if (p.close_loop) {
			const seen = {};
			input.forEach((k) => {
				const key = (k.bone || '') + '|' + (k.channel || 'rotation');
				seen[key] = seen[key] || { zero: null, last: -1 };
				const t = Number(k.time) || 0;
				if (t <= 0.0001 && !seen[key].zero) seen[key].zero = k;
				seen[key].last = Math.max(seen[key].last, t);
			});
			for (const key in seen) {
				const s = seen[key];
				if (s.zero && s.last < length - 0.0001) {
					input.push(Object.assign({}, s.zero, { time: length }));
					closed++;
				}
			}
		}

		Undo.initEdit({ keyframes: [] });
		const res = putKeyframes(anim, input);
		anim.setLength(Math.max(length, res.maxTime));
		Undo.finishEdit('MCP: add keyframes');
		if (typeof updateKeyframeSelection === 'function') updateKeyframeSelection();
		return {
			created: res.created.length,
			loop_keyframes_added: closed,
			keyframes: res.created,
			animation: serializeAnimation(anim),
			reminder: 'Now run analyze_animation — it measures where the limbs really travel and catches motion that goes the wrong way.',
		};
	},

	remove_animation(p) {
		requireProject();
		const anim = findAnimation(p.animation);
		if (!anim) throw new Error('Animation not found: ' + p.animation);
		anim.remove(true);
		return { removed: true };
	},

	// ---- rigging -----------------------------------------------------------
	/**
	 * Build a properly segmented skeleton: every limb gets upper + lower +
	 * extremity so elbows and knees can actually bend, joints sit on the real
	 * pivot, and left/right follow the model's own anatomy.
	 */
	create_rig(p) {
		requireProject();
		const type = String(p.type || 'humanoid').toLowerCase();
		if (!['humanoid', 'biped', 'quadruped'].includes(type)) {
			throw new Error('Unknown rig type: ' + type + ' (humanoid | quadruped)');
		}
		const tpl = type === 'quadruped' ? quadrupedTemplate(p) : humanoidTemplate(p);
		const scale = (p.height ? Number(p.height) / tpl.height : 1) * (Number(p.scale) || 1);
		const frame = rigFrame();
		const offset = num3(p.offset, [0, 0, 0]);
		const prefix = p.name_prefix ? String(p.name_prefix) : '';
		const mapPoint = (pt) => {
			const w = frame.point([pt[0] * scale, pt[1] * scale, pt[2] * scale]);
			return [+(w[0] + offset[0]).toFixed(4), +(w[1] + offset[1]).toFixed(4), +(w[2] + offset[2]).toFixed(4)];
		};
		const parentGroup = p.parent ? findGroup(p.parent) : null;
		if (p.parent && !parentGroup) throw new Error('Parent group not found: ' + p.parent);

		Undo.initEdit({ outliner: true, elements: [] });
		const created = {};
		const bones = [];
		tpl.bones.forEach((b) => {
			const g = new Group({ name: prefix + b.name, origin: mapPoint(b.origin), rotation: [0, 0, 0] }).init();
			g.addTo(b.parent ? created[b.parent] : (parentGroup || 'root'));
			created[b.name] = g;
			bones.push({ name: g.name, origin: g.origin, parent: b.parent ? prefix + b.parent : (parentGroup ? parentGroup.name : 'root') });
		});
		const cubes = [];
		if (p.placeholder_cubes !== false) {
			tpl.cubes.forEach((c) => {
				const a = mapPoint(c.from), b = mapPoint(c.to);
				const from = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
				const to = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
				const cube = new Cube({
					name: prefix + c.name, from, to, origin: created[c.parent] ? created[c.parent].origin.slice() : from,
					autouv: Format.box_uv ? 0 : 1, box_uv: !!Format.box_uv,
				}).init();
				cube.addTo(created[c.parent] || parentGroup || 'root');
				if (Texture.all.length) cube.applyTexture(Texture.getDefault(), true);
				cubes.push(cube.name);
			});
		}
		Undo.finishEdit('MCP: create rig');
		Canvas.updateAll();

		const o = orientation();
		return {
			type, bones_created: bones.length, cubes_created: cubes.length,
			orientation: orientationReport().summary,
			bones, cubes,
			rig: summarizeRig(detectRig()),
			next_steps: [
				`The skeleton is built with the model's RIGHT on ${o.right_axis} — keep it that way.`,
				p.placeholder_cubes === false
					? 'Now add_cubes into these bones (parent every cube to a bone).'
					: 'The cubes are a blocked-out placeholder: reshape them with edit_element, then add detail cubes into the same bones.',
				'Run check_rig before animating, then generate_animation {type:"idle"|"walk"|...} for a correct base cycle and refine it.',
			],
		};
	},

	/** Is this skeleton good enough to animate? Catches 2-bone "cardboard" limbs. */
	check_rig() {
		requireProject();
		const rig = detectRig();
		const issues = [];
		const o = orientation();

		const checkLimb = (label, limb, kindWord) => {
			if (!limb) {
				issues.push({ issue: 'missing_limb', limb: label, hint: `No ${label} found. Bones must contain "arm"/"leg" and "left"/"right" in their names to be animatable.` });
				return;
			}
			if (limb.segments < 3) {
				issues.push({
					issue: 'limb_too_few_segments', limb: label, segments: limb.segments, bones: limb.names,
					hint: `${label} has ${limb.segments} bone(s). With fewer than 3 (upper / lower / ${kindWord}) there is no ${kindWord === 'hand' ? 'elbow' : 'knee'} to bend and every animation will look stiff. Split it: upper + lower + ${kindWord}.`,
				});
			}
			limb.chain.forEach((g) => {
				const cubes = [];
				g.children.forEach((c) => { if (c instanceof Cube) cubes.push(c); });
				if (!cubes.length) return;
				let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
				cubes.forEach((c) => { for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], c.from[i]); max[i] = Math.max(max[i], c.to[i]); } });
				const h = max[1] - min[1];
				if (h > 2 && g.origin[1] < max[1] - h * 0.3 && g.origin[1] > min[1] + h * 0.3) {
					issues.push({
						issue: 'origin_not_at_joint', bone: g.name, origin: g.origin, cube_span_y: [+min[1].toFixed(2), +max[1].toFixed(2)],
						hint: `"${g.name}" pivots around its middle, so it will spin in place instead of swinging. Move its origin to the joint (the TOP of the segment for arms/legs: y≈${max[1].toFixed(1)}).`,
					});
				}
			});
		};

		if (rig.kind === 'unknown') {
			issues.push({ issue: 'no_rig_detected', hint: 'No arm/leg bones were recognised. Name bones like arm_upper_right / leg_lower_left, or build one with create_rig.' });
		}
		if (!rig.hips && !rig.root) issues.push({ issue: 'no_root_bone', hint: 'Add a root/hips bone that parents everything — you need it for whole-body motion (bob, lunge, death fall).' });
		if (!rig.head) issues.push({ issue: 'no_head_bone', hint: 'A separate head bone is needed for looking, nodding and impact reactions.' });
		if (!rig.chest && !rig.spine.length) issues.push({ issue: 'no_spine', hint: 'Add spine/chest bones — torso counter-rotation is what stops walks looking robotic.' });

		if (rig.kind === 'quadruped') {
			['front', 'back'].forEach((row) => ['right', 'left'].forEach((side) =>
				checkLimb(`${row} ${side} leg`, limbOf(rig.legs[row], side), 'paw')));
		} else {
			['right', 'left'].forEach((side) => checkLimb(`${side} arm`, limbOf(rig.arms, side), 'hand'));
			['right', 'left'].forEach((side) => checkLimb(`${side} leg`, limbOf(rig.legs.main, side), 'foot'));
		}

		const animMode = !!(Format && Format.animation_mode);
		if (animMode) {
			const loose = Cube.all.filter((c) => !(c.parent instanceof Group));
			if (loose.length) issues.push({ issue: 'cubes_without_bone', count: loose.length, cubes: loose.slice(0, 10).map((c) => c.name), hint: 'Every cube must live under a bone or it cannot be animated.' });
		}
		const sides = commands.check_sides();
		sides.issues.forEach((i) => issues.push(i));

		const boneCount = Group.all.length;
		if (boneCount < 8) issues.push({ issue: 'low_bone_count', bones: boneCount, hint: 'Fewer than 8 bones is rarely enough for a creature. Aim for 15-30: segmented limbs, spine, neck, head, jaw, tail.' });

		const byType = {};
		issues.forEach((i) => { byType[i.issue] = (byType[i.issue] || 0) + 1; });
		const blocking = issues.filter((i) => ['limb_too_few_segments', 'no_rig_detected', 'wrong_side', 'pair_on_same_side', 'cubes_without_bone'].includes(i.issue));
		return {
			rig: summarizeRig(rig),
			orientation: orientationReport().summary,
			bone_count: boneCount,
			issue_count: issues.length,
			by_type: byType,
			issues,
			ready_to_animate: blocking.length === 0,
			verdict: blocking.length
				? 'NOT ready to animate — fix the blocking issues above first (especially limb segmentation and left/right).'
				: (issues.length ? 'Animatable, but the notes above will improve the result.' : 'Rig looks good.'),
			right_axis: o.right_axis,
		};
	},

	get_rig() {
		requireProject();
		const rig = detectRig();
		return { rig: summarizeRig(rig), orientation: orientationReport().summary, unmatched_bones: rig.unmatched };
	},

	// ---- animation generation & inspection ---------------------------------
	/**
	 * Generate a full, direction-correct base cycle from the rig: correct signs,
	 * bent elbows/knees, overlap and follow-through, seamless loops.
	 */
	generate_animation(p) {
		requireProject();
		if (typeof Animation === 'undefined') throw new Error('Animations are not supported in this format.');
		const type = String(p.type || 'idle').toLowerCase();
		const gen = ANIMATION_GENERATORS[type];
		if (!gen) throw new Error('Unknown animation type: ' + type + '. Available: ' + Object.keys(ANIMATION_GENERATORS).join(', '));
		const rig = detectRig();
		if (rig.kind === 'unknown') {
			throw new Error('No rig detected — cannot generate. Run check_rig (or create_rig) first: bones need names like arm_upper_right / leg_lower_left.');
		}
		const length = Number(p.length) > 0 ? Number(p.length) : gen.length;
		const opts = {
			type, length,
			power: p.intensity == null ? 1 : Math.max(0.2, Math.min(2.5, Number(p.intensity))),
			hand: p.hand === 'left' ? 'left' : 'right',
			direction: p.direction || 'backward',
		};
		const frame = rigFrame();
		const list = gen.fn(rig, frame, opts);
		if (!list.length) throw new Error('The rig has no bones this animation can drive. Run check_rig.');

		const baseName = (Project.name || 'model').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'model';
		const name = p.name || `animation.${baseName}.${type}`;
		let anim = findAnimation(name);
		if (anim && p.replace !== false) { anim.remove(true); anim = null; }
		Undo.initEdit({ animations: [], keyframes: [] });
		if (!anim) {
			anim = new Animation({ name, loop: p.loop || gen.loop, length }).add();
		}
		anim.select();
		const res = putKeyframes(anim, list);
		anim.setLength(length);
		anim.loop = p.loop || gen.loop;
		Undo.finishEdit('MCP: generate animation');
		if (typeof updateKeyframeSelection === 'function') updateKeyframeSelection();

		const warnings = [];
		const limbWarn = (label, limb) => {
			if (!limb) warnings.push(`No ${label} bone found — that part of the motion is missing.`);
			else if (limb.segments < 3) warnings.push(`${label} only has ${limb.segments} segment(s): no ${label.includes('arm') ? 'elbow' : 'knee'} bend, so it will read as stiff. Split the limb and re-generate.`);
		};
		if (rig.kind === 'quadruped') {
			['front', 'back'].forEach((row) => ['right', 'left'].forEach((s) => limbWarn(`${row} ${s} leg`, limbOf(rig.legs[row], s))));
		} else {
			['right', 'left'].forEach((s) => limbWarn(`${s} arm`, limbOf(rig.arms, s)));
			['right', 'left'].forEach((s) => limbWarn(`${s} leg`, limbOf(rig.legs.main, s)));
		}
		if (!rig.tail.length && type !== 'attack') warnings.push('No tail bones — nothing to carry follow-through. Optional, but tails/cloaks sell motion.');
		if (res.missing.length) warnings.push('Bones not found in the animation scope: ' + res.missing.join(', '));

		return {
			animation: serializeAnimation(anim),
			type, length, loop: anim.loop,
			keyframes_created: res.created.length,
			bones_animated: Array.from(new Set(res.created.map((k) => k.bone))),
			rig_kind: rig.kind,
			hand: type === 'attack' ? opts.hand : undefined,
			warnings,
			next_steps: [
				'Run analyze_animation to MEASURE where the limbs actually travel (it catches strikes that swing into the model\'s back).',
				'Then preview_animation to see the poses, and request_review so the user confirms it before you call it done.',
				'Refine with add_keyframes — this is a solid base, not a finished animation.',
			],
		};
	},

	/** Render an animation's poses as annotated images (the honest way to check it). */
	async preview_animation(p) {
		requireProject();
		const anim = findAnimation(p.animation);
		if (!anim) throw new Error('Animation not found: ' + p.animation);
		const shots = await animationPoseShots(anim, p.times, p.views, p);
		return { animation: anim.name, length: anim.length, count: shots.length, shots };
	},

	/**
	 * MEASURE an animation by evaluating it and tracking where the hands, feet
	 * and head actually go — the check that catches "the attack swings
	 * backwards" and "the limbs never bend".
	 */
	async analyze_animation(p) {
		requireProject();
		const anim = findAnimation(p.animation);
		if (!anim) throw new Error('Animation not found: ' + p.animation);
		const rig = detectRig();
		const o = orientation();
		const L = anim.length || 1;
		const n = Math.max(4, Math.min(48, Number(p.samples) || 16));
		const tracked = trackedBones(rig);
		const times = [];
		for (let i = 0; i <= n; i++) times.push(+((i / n) * L).toFixed(4));

		const rest = {};
		const tracks = {};
		await withAnimationMode(async () => {
			anim.select();
			if (Animator.showDefaultPose) Animator.showDefaultPose();
			tracked.forEach((t) => { rest[t.slot] = boneWorldPos(t.group); tracks[t.slot] = []; });
			for (const t of times) {
				Timeline.setTime(t);
				Animator.preview();
				tracked.forEach((tb) => {
					const pos = boneWorldPos(tb.group);
					const r = rest[tb.slot];
					tracks[tb.slot].push(pos && r ? [pos[0] - r[0], pos[1] - r[1], pos[2] - r[2]] : [0, 0, 0]);
				});
			}
		});

		// Per-bone extremes, in the model's own directions.
		const motion = {};
		let biggest = 0;
		for (const slot in tracks) {
			const list = tracks[slot];
			let maxFwd = { v: -Infinity, t: 0 }, maxBack = { v: -Infinity, t: 0 }, maxUp = -Infinity, minUp = Infinity, span = 0;
			list.forEach((d, i) => {
				const f = vecDot(d, o.front_vec);
				if (f > maxFwd.v) maxFwd = { v: f, t: times[i] };
				if (-f > maxBack.v) maxBack = { v: -f, t: times[i] };
				maxUp = Math.max(maxUp, d[1]); minUp = Math.min(minUp, d[1]);
				span = Math.max(span, Math.hypot(d[0], d[1], d[2]));
			});
			biggest = Math.max(biggest, span);
			const last = list[list.length - 1], first = list[0];
			motion[slot] = {
				travel: +span.toFixed(2),
				max_forward: +Math.max(0, maxFwd.v).toFixed(2), at_forward_time: maxFwd.t,
				max_backward: +Math.max(0, maxBack.v).toFixed(2), at_backward_time: maxBack.t,
				rise: +Math.max(0, maxUp).toFixed(2), drop: +Math.min(0, minUp).toFixed(2),
				loop_gap: +Math.hypot(last[0] - first[0], last[1] - first[1], last[2] - first[2]).toFixed(2),
			};
		}

		// Keyframe statistics straight off the animators.
		const perBone = [];
		let totalKeyframes = 0;
		let allLinear = true;
		for (const uuid in (anim.animators || {})) {
			const a = anim.animators[uuid];
			if (!a || !a.keyframes) continue;
			const kfs = a.keyframes;
			if (!kfs.length) continue;
			totalKeyframes += kfs.length;
			kfs.forEach((k) => { if (k.interpolation && k.interpolation !== 'linear') allLinear = false; });
			perBone.push({ bone: a.name, keyframes: kfs.length, channels: Array.from(new Set(kfs.map((k) => k.channel))) });
		}
		const animatedNames = new Set(perBone.map((b) => b.bone));

		const issues = [];
		const isCycle = anim.loop === 'loop';
		if (!totalKeyframes) issues.push({ issue: 'empty_animation', hint: 'No keyframes at all.' });
		if (biggest < 0.5) issues.push({ issue: 'no_visible_motion', hint: 'Nothing moves more than half a unit — the amplitudes are far too small to read in game.' });
		if (allLinear && totalKeyframes > 4) {
			issues.push({ issue: 'all_linear', hint: 'Every keyframe is linear, which is what makes motion look mechanical. Use catmullrom for swings and settles; keep linear only for snappy impacts.' });
		}
		perBone.forEach((b) => {
			if (isCycle && b.keyframes < 3) issues.push({ issue: 'too_few_keyframes', bone: b.bone, keyframes: b.keyframes, hint: 'A cycle needs at least 4-8 keyframes per moving bone; 2 gives a linear back-and-forth.' });
		});

		// Cardboard check: an upper limb that moves while its lower segment does not.
		const stiff = [];
		const limbList = [];
		if (rig.kind === 'quadruped') {
			['front', 'back'].forEach((row) => ['right', 'left'].forEach((s) => limbList.push([`${row}_${s}_leg`, limbOf(rig.legs[row], s)])));
		} else {
			['right', 'left'].forEach((s) => limbList.push([`${s}_arm`, limbOf(rig.arms, s)]));
			['right', 'left'].forEach((s) => limbList.push([`${s}_leg`, limbOf(rig.legs.main, s)]));
		}
		limbList.forEach(([label, limb]) => {
			if (!limb) return;
			if (limb.segments < 3) stiff.push(`${label}: only ${limb.segments} segment(s) — it physically cannot bend.`);
			else if (limb.upper && animatedNames.has(limb.upper.name) && limb.lower && !animatedNames.has(limb.lower.name)) {
				stiff.push(`${label}: "${limb.lower.name}" (the ${label.includes('arm') ? 'elbow' : 'knee'}) has no keyframes while the upper segment swings — that is the cardboard look.`);
			}
		});
		if (stiff.length) issues.push({ issue: 'stiff_limbs', details: stiff, hint: 'Animate the lower segments too: elbows bend forward, knees bend backward.' });

		// Whole-body participation: real motion is never one bone doing all the work.
		const movableBones = Group.all.length;
		if (totalKeyframes && perBone.length <= 2 && movableBones >= 6) {
			issues.push({
				issue: 'only_part_of_the_body_moves', animated: perBone.map((b) => b.bone), bones_available: movableBones,
				hint: 'Only ' + perBone.length + ' bone(s) move out of ' + movableBones + '. Even a single-arm action needs the hips, chest, head and the opposite limb to react, or it reads as a puppet with one working joint.',
			});
		}

		if (isCycle) {
			const gaps = Object.keys(motion).filter((s) => motion[s].loop_gap > 0.4);
			if (gaps.length) issues.push({ issue: 'loop_not_closed', bones: gaps, hint: 'The pose at the end does not match the pose at t=0, so the loop will pop. Duplicate the t=0 keyframes at t=length.' });
		}

		// Direction sanity for strikes: the reach must go toward the model's FRONT.
		const nameHint = (p.expect || anim.name || '').toLowerCase();
		const strike = /attack|punch|swing|strike|slash|bite|stab|kick|thrust/.test(nameHint);
		let directionVerdict = null;
		if (strike) {
			const candidates = Object.keys(motion).filter((s) => /hand|foot/.test(s));
			const best = candidates.sort((a, b) => motion[b].travel - motion[a].travel)[0];
			if (best) {
				const m = motion[best];
				// A strike winds up BEHIND first and then reaches IN FRONT. If the
				// deepest reach is backward, or comes last, the swing is reversed —
				// magnitudes alone miss that, so the ordering is what decides.
				const neverReaches = m.max_forward < 1.5 && m.max_backward > 1.5;
				const endsBehind = m.at_backward_time > m.at_forward_time &&
					m.max_backward > Math.max(1.5, m.max_forward * 0.9);
				if (neverReaches || endsBehind) {
					issues.push({
						issue: 'strike_goes_backwards', bone: best, measured: m,
						hint: neverReaches
							? `"${best}" travels ${m.max_backward} units BEHIND the model and never reaches in front. The model faces ${o.front_axis}: a strike must end with the hand forward. For a hanging arm, +X rotation swings the tip FORWARD — flip the sign of the strike keyframe.`
							: `"${best}" reaches its furthest point BEHIND the model (${m.max_backward} back at t=${m.at_backward_time}s, after only ${m.max_forward} forward at t=${m.at_forward_time}s). The swing is reversed: the wind-up must come FIRST and go backward, then the strike goes forward (+X on a hanging arm). Swap the signs of the wind-up and strike keyframes.`,
					});
					directionVerdict = 'WRONG DIRECTION — the strike ends behind the model.';
				} else if (m.max_forward < 1.5) {
					issues.push({ issue: 'weak_reach', bone: best, measured: m, hint: 'The strike barely reaches forward. Increase the swing-through rotation.' });
					directionVerdict = 'The strike reaches forward but weakly.';
				} else {
					directionVerdict = `OK — "${best}" reaches ${m.max_forward} units forward at t=${m.at_forward_time}s (wind-up ${m.max_backward} back at t=${m.at_backward_time}s).`;
				}
			}
		}

		const byType = {};
		issues.forEach((i) => { byType[i.issue] = (byType[i.issue] || 0) + 1; });
		return {
			animation: anim.name, length: L, loop: anim.loop,
			orientation: orientationReport().summary,
			samples: times.length,
			bones_with_keyframes: perBone.length,
			total_keyframes: totalKeyframes,
			per_bone: perBone,
			motion,
			motion_legend: `Distances are in model units along the model's own axes. "forward" = ${o.front_axis} (the way it faces).`,
			direction_check: directionVerdict,
			issue_count: issues.length,
			by_type: byType,
			issues,
			verdict: issues.length
				? 'Fix the issues above, then re-run analyze_animation — do not show this to the user yet.'
				: 'The motion measures clean. Now preview_animation and request_review so a human confirms it.',
		};
	},

	// ---- view / camera / screenshot --------------------------------------
	set_camera_angle(p) {
		requireProject();
		const preview = Preview.selected;
		if (p.angle && typeof preview.setProjectionMode === 'function' && p.angle === 'ortho') {
			preview.setProjectionMode(true);
		}
		if (Array.isArray(p.position)) preview.camera.position.set(p.position[0], p.position[1], p.position[2]);
		if (Array.isArray(p.target) && preview.controls) preview.controls.target.set(p.target[0], p.target[1], p.target[2]);
		if (p.preset && preview.loadAnglePreset && DefaultCameraPresets) {
			const preset = DefaultCameraPresets.find((x) => x.id === p.preset);
			if (preset) preview.loadAnglePreset(preset);
		}
		preview.controls.updateSceneScale && preview.controls.updateSceneScale();
		preview.render();
		return { camera: preview.camera.position.toArray() };
	},

	async screenshot(p) {
		requireProject();
		p = p || {};
		if (p.view) {
			const shots = await captureViews([p.view], p);
			return Object.assign({ mime: 'image/png' }, shots[0]);
		}
		// Current camera: still work out (and stamp) which way we are looking.
		const preview = Preview.selected;
		const { center } = sceneBounds();
		const dir = vecNorm([
			preview.camera.position.x - center[0],
			preview.camera.position.y - center[1],
			preview.camera.position.z - center[2],
		]);
		const info = describeView('current view', dir);
		const options = {};
		if (p.width) options.width = p.width;
		if (p.height) options.height = p.height;
		let dataUrl = await new Promise((resolve) => Screencam.screenshotPreview(preview, options, resolve));
		if (p.annotate !== false) dataUrl = await annotateShot(dataUrl, info, p.stamp);
		return {
			mime: 'image/png',
			view: info.view,
			looking_at: info.looking_at,
			model_right_on: info.model_right_on,
			note: info.note,
			data_url: dataUrl,
			base64: dataUrl.replace(/^data:image\/png;base64,/, ''),
		};
	},

	// Capture several camera angles in one call so you can see the whole model
	// at once and spot problems (gaps, wrong rotations, missing detail) from
	// every side. `views` is a list of preset ids ('front','back','left',
	// 'right','top','bottom','isometric_right_front',...) or {position,target}.
	async screenshot_views(p) {
		requireProject();
		const views = (p && Array.isArray(p.views) && p.views.length) ? p.views : DEFAULT_VIEWS;
		const shots = await captureViews(views, p || {});
		return { count: shots.length, orientation: orientationReport().summary, shots };
	},

	// ---- orientation / sides ----------------------------------------------
	get_orientation() {
		const o = orientation();
		const report = orientationReport();
		const views = ['front', 'back', 'left', 'right', 'front_right', 'front_left'].map((v) => {
			const d = describeView(v);
			return { view: v, looking_at: d.looking_at, model_right_on: d.model_right_on };
		});
		return Object.assign(report, {
			side_index: o.side_index,
			side_sign: o.side_sign,
			examples: {
				right_hand_bone: `name it "*_right" and place it at ${o.right_axis}`,
				left_hand_bone: `name it "*_left" and place it at ${o.left_axis}`,
				sword_in_right_hand: `parent the sword to the bone on the ${o.right_axis} side (named *_right)`,
				shield_in_left_hand: `parent the shield to the bone on the ${o.left_axis} side (named *_left)`,
			},
			views,
		});
	},

	/**
	 * Cross-check every left/right name in the model against the geometry, so
	 * "the shield ended up in the wrong hand" is caught by a tool instead of by
	 * the user. Reports mismatches, swapped pairs and unpaired limbs.
	 */
	check_sides() {
		requireProject();
		const o = orientation();
		const issues = [];
		const nodes = [];
		Group.all.forEach((g) => nodes.push(g));
		Cube.all.forEach((c) => nodes.push(c));

		const pairs = {};
		nodes.forEach((n) => {
			const claimed = sideFromName(n.name);
			const coord = sideCoordOf(n);
			const actual = sideOfCoord(coord);
			if (claimed) {
				const base = String(n.name).toLowerCase().replace(/(right|left|_r_|_l_)/g, '#');
				(pairs[base] = pairs[base] || []).push({ name: n.name, claimed, actual, coord });
				if (actual === 'center') {
					issues.push({
						issue: 'side_name_on_centred_part', element: n.name, claimed_side: claimed,
						side_coord: +coord.toFixed(2),
						hint: `"${n.name}" claims to be ${claimed} but sits on the centre line. Move it to ${claimed === 'right' ? o.right_axis : o.left_axis} or drop the side from the name.`,
					});
				} else if (actual !== claimed) {
					issues.push({
						issue: 'wrong_side', element: n.name, claimed_side: claimed, actual_side: actual,
						side_coord: +coord.toFixed(2),
						hint: `"${n.name}" is named ${claimed} but its geometry is on the model's ${actual} (${actual === 'right' ? o.right_axis : o.left_axis}). Either rename it "${swapSideInName(n.name)}" or mirror it to the other side. The model's RIGHT is ${o.right_axis}.`,
					});
				}
			}
		});

		// Pairs where both halves ended up on the same side (a mirror gone wrong).
		for (const base in pairs) {
			const list = pairs[base];
			const r = list.filter((x) => x.claimed === 'right');
			const l = list.filter((x) => x.claimed === 'left');
			if (r.length && l.length) {
				const rc = r.reduce((a, x) => a + x.coord, 0) / r.length;
				const lc = l.reduce((a, x) => a + x.coord, 0) / l.length;
				if (rc * lc > 0) {
					issues.push({
						issue: 'pair_on_same_side', elements: [r[0].name, l[0].name],
						hint: 'Both halves of this pair are on the same side of the model — mirror one of them across the centre line.',
					});
				}
			} else if (r.length !== l.length && list.some((x) => PAIRED_PART_RE.test(x.name))) {
				// Only body parts are expected in pairs — a one-handed prop like a
				// sword is not a mistake, and flagging it would just add noise.
				issues.push({
					issue: 'unpaired_side', elements: list.map((x) => x.name),
					hint: 'A left/right body part exists without its counterpart. Mirror it (mirror_element {axis:"x"}) unless the asymmetry is intentional.',
				});
			}
		}

		const unmarked = Group.all.filter((g) => !sideFromName(g.name) && Math.abs(sideCoordOf(g)) > 1.5);
		const byType = {};
		issues.forEach((i) => { byType[i.issue] = (byType[i.issue] || 0) + 1; });
		return {
			orientation: orientationReport().summary,
			right_axis: o.right_axis, left_axis: o.left_axis,
			checked: nodes.length,
			issue_count: issues.length,
			by_type: byType,
			issues,
			unmarked_off_centre_bones: unmarked.slice(0, 24).map((g) => ({
				name: g.name, side: sideOfCoord(sideCoordOf(g)),
				hint: `Consider renaming to "${g.name}_${sideOfCoord(sideCoordOf(g))}" so animations and item attachment pick the right one.`,
			})),
			verdict: issues.length
				? 'FIX THESE — left/right is wrong somewhere in the model.'
				: 'Left/right naming matches the geometry.',
		};
	},

	/** Which side is this element on? The question to ask before attaching an item. */
	which_side(p) {
		requireProject();
		const ref = p.element || p.bone || p.name;
		const node = findNode(ref);
		if (!node) throw new Error('Element not found: ' + ref);
		const o = orientation();
		const coord = sideCoordOf(node);
		const side = sideOfCoord(coord);
		return {
			element: node.name,
			side,
			side_coord: +coord.toFixed(2),
			name_claims: sideFromName(node.name),
			matches_name: !sideFromName(node.name) || sideFromName(node.name) === side,
			explanation: `"${node.name}" sits on the model's ${side.toUpperCase()} (${o.right_axis} is the model's right).`,
			right_axis: o.right_axis,
		};
	},

	// ---- human review gate -------------------------------------------------
	/**
	 * Show the user what was just built and WAIT for their verdict. The HTTP
	 * request stays open until they press a button in the MCP Copilot panel.
	 */
	async request_review(p) {
		requireProject();
		let shots = [];
		if (p.animation) {
			const anim = findAnimation(p.animation);
			if (!anim) throw new Error('Animation not found: ' + p.animation);
			shots = await animationPoseShots(anim, p.times, p.views, p);
		} else if (p.views !== 'none') {
			shots = await captureViews(
				Array.isArray(p.views) && p.views.length ? p.views : DEFAULT_VIEWS,
				Object.assign({ width: 480, height: 480 }, p)
			);
		}
		const entry = postRequest({
			kind: 'review',
			title: p.title || 'Please check this',
			question: p.question || 'Does this look right?',
			details: p.details || p.context || '',
			options: Array.isArray(p.options) && p.options.length ? p.options.map(String) : null,
			shots,
		}, p.timeout_seconds);
		const answer = await waitForRequest(entry, p.wait_seconds);
		return Object.assign(formatAnswer(answer, entry), { shots });
	},

	/**
	 * Keep waiting on a review the user has not answered yet. Called in a loop:
	 * each call is short enough to fit inside the MCP client's request timeout,
	 * while the card itself stays open in Blockbench for as long as it needs.
	 */
	async wait_review(p) {
		const id = p.review_id || p.id || (G.pending.length ? G.pending[G.pending.length - 1].id : null);
		if (!id) return { answered: false, note: 'There is no open review to wait for.' };
		const entry = G.requests[id];
		if (!entry) throw new Error('No such review: ' + id + '. Open ones: ' + (G.pending.map((e) => e.id).join(', ') || 'none'));
		const answer = await waitForRequest(entry, p.wait_seconds);
		return formatAnswer(answer, entry);
	},

	/** Ask the user a plain question (optionally with choices) and wait for the answer. */
	async ask_user(p) {
		if (!p.question) throw new Error('question is required');
		let shots = [];
		if (p.views && p.views !== 'none' && Project) {
			shots = await captureViews(toList(p.views), Object.assign({ width: 420, height: 420 }, p));
		}
		const entry = postRequest({
			kind: 'question',
			title: p.title || 'Question from the AI',
			question: String(p.question),
			details: p.details || '',
			options: Array.isArray(p.options) && p.options.length ? p.options.map(String) : null,
			shots,
		}, p.timeout_seconds);
		const answer = await waitForRequest(entry, p.wait_seconds);
		return Object.assign(formatAnswer(answer, entry), { shots });
	},

	/** Non-blocking status of the review queue (for debugging / the panel). */
	list_pending_reviews() {
		return {
			pending: G.pending.map((e) => ({
				id: e.id, kind: e.kind, question: e.question,
				waiting_seconds: Math.round((Date.now() - e.created) / 1000),
				seconds_left: Math.max(0, Math.round((e.deadline - Date.now()) / 1000)),
			})),
			recent_answers: G.answers.slice(-5),
		};
	},

	// A compact playbook the AI can read before building, so models come out
	// detailed and rotated rather than a few flat axis-aligned boxes.
	get_guide(p) {
		const topic = (p && p.topic ? String(p.topic) : 'modeling').toLowerCase();
		const guide = GUIDES[topic];
		if (!guide) {
			return { topic: 'modeling', guide: MODELING_GUIDE, available_topics: Object.keys(GUIDES) };
		}
		return { topic, guide, available_topics: Object.keys(GUIDES) };
	},

	// ---- reference images & comparison ------------------------------------
	// The grounded-modeling engine: keep the reference in the workspace and turn
	// "does it match?" from an opinion into a measured number.

	async load_reference(p) {
		let dataURL = p.data_url;
		if (!dataURL && p.path) {
			requireApp();
			const fs = require('fs');
			const buf = fs.readFileSync(p.path);
			const ext = String(p.path).split('.').pop().toLowerCase();
			const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
			dataURL = `data:${mime};base64,` + buf.toString('base64');
		}
		if (!dataURL) throw new Error('Provide a reference `path` (desktop) or `data_url`.');
		const name = p.name || (p.path ? String(p.path).split(/[\\/]/).pop() : undefined);
		const entry = await addReference(dataURL, name, p.path ? 'path' : 'data', p);
		return {
			id: entry.id, name: entry.name,
			width: entry.width, height: entry.height,
			overlay_added: !!entry.overlay_added,
			total_references: G.references.length,
		};
	},

	list_references() {
		return {
			count: G.references.length,
			references: G.references.map((r) => ({
				id: r.id, name: r.name, width: r.width, height: r.height,
				source: r.source, overlay: !!r.ref_image,
			})),
		};
	},

	get_reference(p) {
		if (!G.references.length) {
			return { count: 0, note: 'No reference loaded. Drop an image into the BlockbenchMCP panel, or call load_reference.' };
		}
		const which = (p && (p.name != null || p.id != null)) ? pickReference(p.id != null ? p.id : p.name) : null;
		const list = which ? [which] : G.references;
		return {
			count: list.length,
			references: list.map((r) => ({
				id: r.id, name: r.name, width: r.width, height: r.height, source: r.source,
				data_url: r.data_url,
			})),
		};
	},

	clear_references() {
		const n = G.references.length;
		G.references.forEach(removeReferenceOverlay);
		G.references = [];
		return { cleared: n };
	},

	measure_model() {
		requireProject();
		let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
		Cube.all.forEach((c) => { for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], c.from[i], c.to[i]); max[i] = Math.max(max[i], c.from[i], c.to[i]); } });
		if (!isFinite(min[0])) return { cubes: 0, note: 'Model has no cubes yet.' };
		const dim = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
		const round2 = (v) => Math.round(v * 100) / 100;
		const cubeBoundsUnder = (group) => {
			let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity], count = 0;
			const walk = (node) => (node.children || []).forEach((ch) => {
				if (ch instanceof Cube) { count++; for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], ch.from[i], ch.to[i]); mx[i] = Math.max(mx[i], ch.from[i], ch.to[i]); } }
				else if (ch.children) walk(ch);
			});
			walk(group);
			if (!isFinite(mn[0])) return null;
			return { w: round2(mx[0] - mn[0]), h: round2(mx[1] - mn[1]), d: round2(mx[2] - mn[2]), cubes: count, top: round2(mx[1]), bottom: round2(mn[1]) };
		};
		const bones = Group.all
			.filter((g) => g.parent === 'root' || !(g.parent instanceof Group))
			.map((g) => ({ name: g.name, origin: g.origin.map(round2), bounds: cubeBoundsUnder(g) }))
			.filter((b) => b.bounds);
		const headBone = Group.all.find((g) => /head|skull|cranium/i.test(g.name));
		const headBounds = headBone ? cubeBoundsUnder(headBone) : null;
		return {
			cubes: Cube.all.length,
			groups: Group.all.length,
			total: { width: round2(dim[0]), height: round2(dim[1]), depth: round2(dim[2]), min: min.map(round2), max: max.map(round2) },
			ratios: {
				width_to_height: round2(dim[0] / (dim[1] || 1)),
				depth_to_height: round2(dim[2] / (dim[1] || 1)),
				head_height_fraction: headBounds ? round2(headBounds.h / (dim[1] || 1)) : null,
			},
			bones,
			note: 'Compare these proportions to the reference. Bounds are axis-aligned (ignore rotation); good enough for proportion checks.',
		};
	},

	async compare_reference(p) {
		requireProject();
		const entry = pickReference(p && (p.reference != null ? p.reference : (p.name != null ? p.name : p.id)));
		if (!entry) throw new Error('No reference loaded. Drop one into the BlockbenchMCP panel or call load_reference first.');
		if (!Cube.all.length) throw new Error('The model has no cubes yet — build the silhouette before comparing.');
		const preview = Preview.selected;
		const threshold = p && p.threshold != null ? p.threshold : 0.45;

		// Aim the camera if the caller specified a view; otherwise compare the current view.
		let changedCam = false, savedPos, savedTarget;
		if (p && (p.view || Array.isArray(p.position) || Array.isArray(p.target))) {
			savedPos = preview.camera.position.toArray();
			savedTarget = preview.controls ? preview.controls.target.toArray() : [0, 0, 0];
			changedCam = true;
			if (typeof p.view === 'string') {
				const preset = (typeof DefaultCameraPresets !== 'undefined' && DefaultCameraPresets) ? DefaultCameraPresets.find((x) => x.id === p.view || x.name === p.view) : null;
				if (preset && preview.loadAnglePreset) preview.loadAnglePreset(preset);
				else applyAngleName(preview, p.view);
			}
			if (Array.isArray(p.position)) preview.camera.position.set(p.position[0], p.position[1], p.position[2]);
			if (Array.isArray(p.target) && preview.controls) preview.controls.target.set(p.target[0], p.target[1], p.target[2]);
			if (preview.controls && preview.controls.updateSceneScale) preview.controls.updateSceneScale();
		}

		// Capture the model silhouette (transparent background, helpers hidden).
		const shot = withSilhouetteCapture(preview, (cap) => cap);

		if (changedCam) {
			preview.camera.position.set(savedPos[0], savedPos[1], savedPos[2]);
			if (preview.controls) preview.controls.target.set(savedTarget[0], savedTarget[1], savedTarget[2]);
			if (preview.controls && preview.controls.updateSceneScale) preview.controls.updateSceneScale();
			preview.render();
		}

		const modelMask = modelSilhouette(shot.image_data, threshold);
		if (!modelMask.area) {
			throw new Error('Captured model silhouette was empty. Make sure the model is on-screen in the preview before comparing.');
		}
		const refData = await imageDataFromSource(entry.data_url, 512);
		const refMask = referenceSilhouette(refData);

		// Normalize both to a common box (shape/proportion, independent of viewport scale).
		const W = 256, H = 256;
		const normM = normalizeMaskToBox(modelMask, W, H);
		const normR = normalizeMaskToBox(refMask, W, H);
		let inter = 0, uni = 0, mOnly = 0, rOnly = 0, mArea = 0, rArea = 0;
		for (let i = 0; i < W * H; i++) {
			const a = normM[i], b = normR[i];
			if (a) mArea++; if (b) rArea++;
			if (a && b) inter++;
			if (a || b) uni++;
			if (a && !b) mOnly++;
			if (b && !a) rOnly++;
		}
		const iou = uni ? inter / uni : 0;
		const matchPercent = Math.round(iou * 100);
		const mAspect = modelMask.bbox.w / modelMask.bbox.h;
		const rAspect = refMask.bbox.w / refMask.bbox.h;
		const aspectDelta = rAspect ? (mAspect - rAspect) / rAspect : 0;
		const cM = maskCentroid(normM, W, H), cR = maskCentroid(normR, W, H);

		// Build the side-by-side + overlay composite so the AI can SEE the divergence.
		const PW = 256, PH = 256, LBL = 22;
		const comp = document.createElement('canvas');
		comp.width = PW * 3; comp.height = PH + LBL;
		const cx = comp.getContext('2d');
		cx.fillStyle = '#1c1f23'; cx.fillRect(0, 0, comp.width, comp.height);
		const [refImg, modelImg] = await Promise.all([
			loadImageElement(entry.data_url),
			loadImageElement(shot.data_url),
		]);
		drawFitted(cx, refImg, 0, LBL, PW, PH);
		// Model render over a checkered-ish neutral panel so transparency is visible.
		cx.fillStyle = '#2a2f35'; cx.fillRect(PW, LBL, PW, PH);
		drawFitted(cx, modelImg, PW, LBL, PW, PH);
		// Overlay panel: ref=red, model=blue, overlap=white.
		const ov = cx.createImageData(PW, PH);
		for (let i = 0; i < PW * PH; i++) {
			const r = normR[i], m = normM[i], o = i * 4;
			if (r && m) { ov.data[o] = 255; ov.data[o + 1] = 255; ov.data[o + 2] = 255; ov.data[o + 3] = 255; }
			else if (r) { ov.data[o] = 235; ov.data[o + 1] = 70; ov.data[o + 2] = 70; ov.data[o + 3] = 255; }
			else if (m) { ov.data[o] = 70; ov.data[o + 1] = 130; ov.data[o + 2] = 245; ov.data[o + 3] = 255; }
			else { ov.data[o] = 28; ov.data[o + 1] = 31; ov.data[o + 2] = 35; ov.data[o + 3] = 255; }
		}
		const ovc = document.createElement('canvas'); ovc.width = PW; ovc.height = PH;
		ovc.getContext('2d').putImageData(ov, 0, 0);
		cx.drawImage(ovc, PW * 2, LBL);
		cx.fillStyle = '#e8e8e8'; cx.font = 'bold 13px sans-serif'; cx.textBaseline = 'middle';
		cx.fillText('REFERENCE', 8, LBL / 2);
		cx.fillText('YOUR MODEL', PW + 8, LBL / 2);
		cx.fillText(`OVERLAY  ${matchPercent}%  (red=ref only, blue=model only, white=match)`, PW * 2 + 8, LBL / 2);

		// Turn the numbers into actionable advice.
		const advice = [];
		if (aspectDelta < -0.12) advice.push(`Model is ~${Math.round(-aspectDelta * 100)}% too NARROW for its height — widen it (or it is too tall).`);
		else if (aspectDelta > 0.12) advice.push(`Model is ~${Math.round(aspectDelta * 100)}% too WIDE for its height — narrow it (or make it taller).`);
		const rOnlyPct = rArea ? Math.round((rOnly / rArea) * 100) : 0;
		const mOnlyPct = mArea ? Math.round((mOnly / mArea) * 100) : 0;
		if (rOnlyPct > 12) advice.push(`${rOnlyPct}% of the reference shape (RED in the overlay) has NO model under it — you are MISSING mass there. Add/enlarge parts to fill the red.`);
		if (mOnlyPct > 12) advice.push(`${mOnlyPct}% of the model (BLUE in the overlay) sticks out beyond the reference — trim/move those parts.`);
		if (cM && cR) {
			const dy = cM.y - cR.y, dx = cM.x - cR.x;
			if (dy > 0.06) advice.push('Model mass sits LOWER than the reference (bottom-heavy) — raise mass upward.');
			else if (dy < -0.06) advice.push('Model mass sits HIGHER than the reference (top-heavy) — lower mass / shorten the top.');
			if (Math.abs(dx) > 0.06) advice.push('Model is left/right-asymmetric vs the reference — check mirroring.');
		}
		let verdict;
		if (matchPercent >= 93) verdict = 'EXCELLENT — silhouette matches. Move on to texture/detail.';
		else if (matchPercent >= 85) verdict = 'GOOD — minor shape refinements left.';
		else if (matchPercent >= 70) verdict = 'CLOSE — proportions roughly right but visibly off; keep fixing the deltas below.';
		else if (matchPercent >= 50) verdict = 'ROUGH — the silhouette is noticeably wrong. Fix proportions before texturing.';
		else verdict = 'POOR — the shape does not match. Rework the proportions from the reference; do not texture yet.';
		if (!advice.length) advice.push('No single large delta — chase remaining mismatch by eye against the overlay panel.');

		G.lastCompare = { match_percent: matchPercent, view: (p && p.view) || 'current', reference: entry.name, time: Date.now() };
		if (typeof G.onActivity === 'function') G.onActivity();

		const composite = comp.toDataURL('image/png');
		return {
			reference: entry.name,
			view: (p && p.view) || 'current view',
			match_percent: matchPercent,
			iou: Math.round(iou * 1000) / 1000,
			model_only_pct: mOnlyPct,
			ref_only_pct: rOnlyPct,
			model_aspect: Math.round(mAspect * 100) / 100,
			reference_aspect: Math.round(rAspect * 100) / 100,
			aspect_delta_pct: Math.round(aspectDelta * 100),
			verdict,
			advice,
			composite_data_url: composite,
			composite_base64: composite.replace(/^data:image\/png;base64,/, ''),
		};
	},

	// ---- plugins ----------------------------------------------------------
	list_plugins(p) {
		const list = (Plugins.all || []).map((pl) => ({
			id: pl.id,
			title: pl.title,
			author: pl.author,
			version: pl.version,
			installed: pl.installed,
			disabled: pl.disabled,
			tags: pl.tags,
			description: pl.description,
		}));
		if (p && p.installed_only) return list.filter((x) => x.installed);
		if (p && p.query) {
			const q = String(p.query).toLowerCase();
			return list.filter(
				(x) =>
					x.id.toLowerCase().includes(q) ||
					(x.title || '').toLowerCase().includes(q) ||
					(x.description || '').toLowerCase().includes(q)
			);
		}
		return list;
	},

	async install_plugin(p) {
		if (Plugins.loading_promise) await Plugins.loading_promise;
		if (p.url) {
			await new Plugin().loadFromURL(p.url, true);
			return { installed: true, source: 'url', url: p.url };
		}
		if (p.path) {
			requireApp();
			await new Plugin().loadFromFile({ path: p.path, name: p.path, content: '' }, true);
			return { installed: true, source: 'file', path: p.path };
		}
		if (!p.id) throw new Error('Provide a plugin id, url, or path.');
		let plugin = Plugins.all.find((x) => x.id === p.id);
		if (!plugin) {
			// The store list may still be loading; give it one shot.
			if (typeof loadInstalledPlugins === 'function') await loadInstalledPlugins().catch(() => {});
			plugin = Plugins.all.find((x) => x.id === p.id);
		}
		if (!plugin) throw new Error(`Plugin "${p.id}" not found in the store. Use list_plugins query to search.`);
		if (plugin.installed) return { installed: true, already: true, id: p.id };
		await plugin.install();
		return { installed: !!plugin.installed, id: p.id, title: plugin.title };
	},

	async uninstall_plugin(p) {
		if (!p.id) throw new Error('id is required');
		const plugin = Plugins.all.find((x) => x.id === p.id);
		if (!plugin || !plugin.installed) throw new Error('Plugin not installed: ' + p.id);
		plugin.uninstall();
		return { uninstalled: true, id: p.id };
	},

	// ---- escape hatch -----------------------------------------------------
	execute_script(p) {
		if (!p.code) throw new Error('code is required');
		const fn = new Function('params', 'Blockbench', '"use strict";\n' + p.code);
		const result = fn(p.params || {}, Blockbench);
		return Promise.resolve(result).then((r) => {
			// Best-effort safe serialization.
			try {
				JSON.stringify(r);
				return r;
			} catch (e) {
				return { value: String(r) };
			}
		});
	},
};

function applyFaces(cube, faces) {
	for (const dir in faces) {
		const face = cube.faces[dir];
		if (!face) continue;
		const fd = faces[dir];
		if (fd.uv) face.uv = fd.uv;
		if (fd.rotation !== undefined) face.rotation = fd.rotation;
		if (fd.texture !== undefined) {
			const tex = findTexture(fd.texture);
			face.texture = tex ? tex.uuid : false;
		}
	}
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function logActivity(action, ok, ms) {
	if (action === 'ping') return; // health checks would flood the feed
	try {
		G.activity.push({ t: Date.now(), action, ok, ms });
		if (G.activity.length > ACTIVITY_CAP) G.activity.splice(0, G.activity.length - ACTIVITY_CAP);
		if (typeof G.onActivity === 'function') G.onActivity();
	} catch (e) {}
}

async function dispatch(action, params) {
	const handler = commands[action];
	if (!handler) throw new Error('Unknown command: ' + action);
	const start = Date.now();
	try {
		const result = await handler(params || {});
		logActivity(action, true, Date.now() - start);
		return result;
	} catch (err) {
		logActivity(action, false, Date.now() - start);
		throw err;
	}
}

const MAX_BODY = 96 * 1024 * 1024; // 96 MB guard (textures/screenshots can be large)

function statusText(code) {
	return {
		200: 'OK', 204: 'No Content', 400: 'Bad Request',
		404: 'Not Found', 405: 'Method Not Allowed', 500: 'Internal Server Error',
	}[code] || 'OK';
}

/** Write a minimal HTTP/1.1 response to a raw TCP socket, then close it. */
function writeResponse(socket, status, obj, extraHeaders) {
	if (socket.destroyed) return;
	const body = Buffer.from(obj === undefined ? '' : JSON.stringify(obj), 'utf8');
	let head =
		`HTTP/1.1 ${status} ${statusText(status)}\r\n` +
		`Content-Type: application/json\r\n` +
		`Content-Length: ${body.length}\r\n` +
		`Access-Control-Allow-Origin: *\r\n` +
		`Connection: close\r\n`;
	if (extraHeaders) head += extraHeaders;
	head += '\r\n';
	try {
		socket.write(head);
		if (body.length) socket.write(body);
		socket.end();
	} catch (e) {
		try { socket.destroy(); } catch (_) {}
	}
}

/** Actions that legitimately keep the connection open while a human thinks. */
const LONG_ACTIONS = { request_review: true, ask_user: true, wait_review: true };

/**
 * Actions that can arrive with a big payload (a dense character matrix, a few
 * hundred element specs) and then build a lot of geometry on this thread. The
 * default idle timeout is generous for them, but not obviously so — raise it
 * rather than have the socket die halfway through creating 300 cubes.
 */
const HEAVY_ACTIONS = {
	voxelize_matrix: true, generate_array: true, extrude_chain: true, add_hollow_volume: true,
	add_cubes: true, add_groups: true, audit_complexity: true, detail_cubes: true,
	paint_faces: true, paint_texture: true, pack_uv: true, create_rig: true, execute_script: true,
};

async function handleRequest(socket, method, path, body) {
	try {
		if (method === 'OPTIONS') {
			writeResponse(socket, 204, undefined,
				'Access-Control-Allow-Methods: POST, GET, OPTIONS\r\n' +
				'Access-Control-Allow-Headers: Content-Type\r\n');
			return;
		}
		if (method === 'GET' && (path === '/' || path === '/ping' || path.startsWith('/ping?'))) {
			writeResponse(socket, 200, { ok: true, ...commands.ping() });
			return;
		}
		if (method !== 'POST') {
			writeResponse(socket, 405, { ok: false, error: 'Use POST /command' });
			return;
		}
		let payload;
		try {
			payload = JSON.parse(body || '{}');
		} catch (e) {
			writeResponse(socket, 400, { ok: false, error: 'Invalid JSON body' });
			return;
		}
		try {
			// A review can sit unanswered for minutes; don't let the idle-socket
			// timeout kill the connection while the user is looking at the model.
			if (LONG_ACTIONS[payload.action]) {
				const wait = Number(payload.params && payload.params.wait_seconds) || 25;
				socket.setTimeout(Math.max(120000, (wait + 45) * 1000));
			} else if (HEAVY_ACTIONS[payload.action]) {
				socket.setTimeout(300000);
			}
			const result = await dispatch(payload.action, payload.params);
			writeResponse(socket, 200, { ok: true, id: payload.id, result });
		} catch (err) {
			console.error('[BlockbenchMCP] command failed:', payload && payload.action, err);
			writeResponse(socket, 200, {
				ok: false,
				id: payload && payload.id,
				error: err && err.message ? err.message : String(err),
				stack: err && err.stack ? String(err.stack) : undefined,
			});
		}
	} catch (e) {
		try { writeResponse(socket, 500, { ok: false, error: String(e) }); } catch (_) {}
	}
}

/** Accumulate bytes on a socket, parse one HTTP request, then dispatch it. */
function handleConnection(socket) {
	let chunks = [];
	let received = 0;
	let headersDone = false;
	let method, path, headerLength, contentLength = 0, expectContinue = false;
	let dispatched = false;

	socket.on('data', (chunk) => {
		received += chunk.length;
		if (received > MAX_BODY) { socket.destroy(); return; }
		chunks.push(chunk);
		const buffer = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
		chunks = [buffer];

		if (!headersDone) {
			const sep = buffer.indexOf('\r\n\r\n');
			if (sep === -1) return;
			headerLength = sep + 4;
			const headerText = buffer.slice(0, sep).toString('utf8');
			const lines = headerText.split('\r\n');
			const reqLine = (lines[0] || '').split(' ');
			method = reqLine[0];
			path = reqLine[1] || '/';
			for (let i = 1; i < lines.length; i++) {
				const c = lines[i].indexOf(':');
				if (c <= 0) continue;
				const key = lines[i].slice(0, c).trim().toLowerCase();
				const val = lines[i].slice(c + 1).trim();
				if (key === 'content-length') contentLength = parseInt(val, 10) || 0;
				if (key === 'expect' && /100-continue/i.test(val)) expectContinue = true;
			}
			headersDone = true;
			if (expectContinue) {
				try { socket.write('HTTP/1.1 100 Continue\r\n\r\n'); } catch (e) {}
			}
		}

		if (headersDone && !dispatched && buffer.length >= headerLength + contentLength) {
			// A large body arrives over many chunks; dispatch once, on the chunk that
			// completes it, and ignore anything that trails it.
			dispatched = true;
			const bodyText = buffer.slice(headerLength, headerLength + contentLength).toString('utf8');
			handleRequest(socket, method, path, bodyText);
		}
	});
	socket.on('error', () => { try { socket.destroy(); } catch (e) {} });
	socket.setTimeout(120000, () => { try { socket.destroy(); } catch (e) {} });
}

function startServer(port) {
	requireApp();
	if (G.server) {
		return { running: true, port: G.port, already: true };
	}
	const netModule = getNet(); // triggers the Blockbench permission dialog on first use
	port = port || getPort();
	const server = netModule.createServer(handleConnection);
	server.on('error', (err) => {
		console.error('[BlockbenchMCP] server error:', err);
		Blockbench.showQuickMessage('MCP server error: ' + err.message, 3000);
		G.server = null;
		G.port = null;
		updateMenuLabel();
	});
	server.listen(port, '127.0.0.1', () => {
		G.server = server;
		G.port = port;
		console.log(`[BlockbenchMCP] listening on http://127.0.0.1:${port}`);
		Blockbench.showQuickMessage(`MCP server started on port ${port}`, 2000);
		updateMenuLabel();
	});
	return { running: true, port };
}

function stopServer() {
	if (G.server) {
		G.server.close();
		G.server = null;
		G.port = null;
		console.log('[BlockbenchMCP] server stopped');
		Blockbench.showQuickMessage('MCP server stopped', 1500);
		updateMenuLabel();
		return { running: false };
	}
	return { running: false, already: true };
}

function getPort() {
	const setting = settings && settings[PLUGIN_ID + '_port'];
	return (setting && setting.value) || DEFAULT_PORT;
}

// ---------------------------------------------------------------------------
// UI: settings + menu actions
// ---------------------------------------------------------------------------

let toggleAction = null;
let mcpPanel = null;

function updateMenuLabel() {
	if (!toggleAction) return;
	const running = !!G.server;
	toggleAction.setName(running ? `Stop MCP Server (:${G.port})` : 'Start MCP Server');
	if (toggleAction.setIcon) toggleAction.setIcon(running ? 'wifi' : 'wifi_off');
}

// ---------------------------------------------------------------------------
// UI: the "MCP Copilot" side panel — drag a reference in, watch the AI work,
// see the live model stats + last silhouette-match score.
// ---------------------------------------------------------------------------

const PANEL_CSS = `
.bbmcp-panel { padding: 8px; font-size: 12px; color: var(--color-text); }
.bbmcp-row { display:flex; align-items:center; gap:6px; margin-bottom:8px; }
.bbmcp-dot { width:9px; height:9px; border-radius:50%; flex:0 0 auto; }
.bbmcp-dot.on { background:#4caf50; box-shadow:0 0 6px #4caf50; }
.bbmcp-dot.off { background:#888; }
.bbmcp-btn { background:var(--color-button); color:var(--color-text); border:none; border-radius:3px;
	padding:3px 8px; cursor:pointer; font-size:11px; }
.bbmcp-btn:hover { background:var(--color-accent); color:var(--color-accent_text,#fff); }
.bbmcp-h { font-weight:bold; opacity:.7; text-transform:uppercase; font-size:10px; letter-spacing:.5px;
	margin:10px 0 4px; border-top:1px solid var(--color-border); padding-top:8px; }
.bbmcp-drop { border:2px dashed var(--color-border); border-radius:6px; padding:14px 8px; text-align:center;
	color:var(--color-text); opacity:.8; cursor:pointer; transition:.12s; }
.bbmcp-drop.drag { border-color:var(--color-accent); background:var(--color-accent_text,rgba(120,170,255,.12)); opacity:1; }
.bbmcp-thumbs { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
.bbmcp-thumb { position:relative; width:62px; }
.bbmcp-thumb img { width:62px; height:62px; object-fit:contain; background:#222; border:1px solid var(--color-border); border-radius:3px; }
.bbmcp-thumb .x { position:absolute; top:-6px; right:-6px; background:#c0392b; color:#fff; border-radius:50%;
	width:16px; height:16px; line-height:16px; text-align:center; cursor:pointer; font-size:11px; }
.bbmcp-thumb .nm { font-size:9px; opacity:.7; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.bbmcp-stat { display:flex; justify-content:space-between; padding:1px 0; }
.bbmcp-stat b { font-weight:bold; }
.bbmcp-score { font-size:20px; font-weight:bold; }
.bbmcp-log { max-height:150px; overflow-y:auto; font-family:var(--font-code,monospace); font-size:10px; line-height:1.5; }
.bbmcp-log .ok { color:#7ec77e; } .bbmcp-log .err { color:#e07a7a; }
.bbmcp-log .tm { opacity:.5; }
.bbmcp-empty { opacity:.5; font-style:italic; }
.bbmcp-ask { border:2px solid #e0922f; border-radius:6px; padding:8px; margin-bottom:10px;
	background:rgba(224,146,47,.10); animation:bbmcp-pulse 1.6s ease-in-out infinite; }
@keyframes bbmcp-pulse { 0%,100% { border-color:#e0922f; } 50% { border-color:#ffd08a; } }
.bbmcp-ask .q { font-weight:bold; margin-bottom:4px; }
.bbmcp-ask .d { opacity:.75; margin-bottom:6px; white-space:pre-wrap; }
.bbmcp-ask .shots { display:flex; flex-wrap:wrap; gap:4px; margin-bottom:6px; max-height:230px; overflow-y:auto; }
.bbmcp-ask .shots img { width:88px; border:1px solid var(--color-border); border-radius:3px; cursor:pointer; background:#222; }
.bbmcp-ask textarea { width:100%; box-sizing:border-box; height:46px; resize:vertical; font-size:11px;
	background:var(--color-back); color:var(--color-text); border:1px solid var(--color-border); border-radius:3px; padding:3px; }
.bbmcp-ask .btns { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
.bbmcp-ok { background:#3a7d44; color:#fff; }
.bbmcp-no { background:#a8412e; color:#fff; }
.bbmcp-ask .timer { float:right; opacity:.6; font-weight:normal; }
.bbmcp-lightbox { position:fixed; inset:0; background:rgba(0,0,0,.82); z-index:60; display:flex;
	align-items:center; justify-content:center; cursor:zoom-out; }
.bbmcp-lightbox img { max-width:92vw; max-height:92vh; image-rendering:pixelated; }
`;

function scoreColor(pc) {
	if (pc == null) return 'var(--color-text)';
	if (pc >= 85) return '#4caf50';
	if (pc >= 70) return '#c9c84b';
	if (pc >= 50) return '#e0922f';
	return '#e0573a';
}

function buildPanel() {
	if (typeof Panel === 'undefined') return;
	const styleEl = Blockbench.addCSS ? Blockbench.addCSS(PANEL_CSS) : null;
	if (styleEl) deletables.push(styleEl);

	mcpPanel = new Panel('blockbench_mcp_panel', {
		name: 'mcp_copilot',
		id: 'blockbench_mcp_panel',
		icon: 'smart_toy',
		growable: true,
		resizable: true,
		default_position: { slot: 'right_bar', float_position: [0, 0], float_size: [320, 560], height: 460 },
		default_side: 'right',
		component: {
			name: 'mcp-copilot',
			data() {
				return {
					running: !!G.server, port: G.port || DEFAULT_PORT,
					refs: [], log: [], lastCompare: G.lastCompare,
					cubes: 0, groups: 0, textures: 0, hasProject: false,
					dragging: false,
					asks: [], comments: {}, zoom: null, now: Date.now(),
				};
			},
			methods: {
				refresh() {
					this.running = !!G.server;
					this.port = G.port || getPort();
					this.now = Date.now();
					this.asks = G.pending.map((e) => ({
						id: e.id, kind: e.kind, title: e.title, question: e.question, details: e.details,
						options: e.options, shots: (e.shots || []).map((s) => ({ view: s.view, time: s.time, data_url: s.data_url })),
						seconds_left: Math.max(0, Math.round((e.deadline - Date.now()) / 1000)),
					}));
					this.refs = G.references.map((r) => ({ id: r.id, name: r.name, data_url: r.data_url, source: r.source }));
					this.log = G.activity.slice(-16).reverse();
					this.lastCompare = G.lastCompare;
					const hasP = (typeof Project !== 'undefined' && !!Project);
					this.hasProject = hasP;
					this.cubes = hasP ? Cube.all.length : 0;
					this.groups = hasP ? Group.all.length : 0;
					this.textures = hasP ? Texture.all.length : 0;
				},
				toggleServer() { if (G.server) stopServer(); else startServer(getPort()); this.refresh(); },
				answer(id, approved, choice) {
					answerPending(id, {
						approved: !!approved,
						choice: choice || null,
						comment: (this.comments[id] || '').trim(),
					});
					this.$delete ? this.$delete(this.comments, id) : delete this.comments[id];
					this.refresh();
				},
				setComment(id, ev) {
					this.$set ? this.$set(this.comments, id, ev.target.value) : (this.comments[id] = ev.target.value);
				},
				openShot(url) { this.zoom = url; },
				onDragOver() { this.dragging = true; },
				onDragLeave() { this.dragging = false; },
				onDrop(e) {
					this.dragging = false;
					const dt = e.dataTransfer; if (!dt) return;
					if (dt.files && dt.files.length) { this.handleFiles(dt.files); return; }
					const url = dt.getData('text/uri-list') || dt.getData('text/plain');
					if (url && /^(data:image|https?:|file:)/.test(url.trim())) {
						addReference(url.trim(), 'dropped', 'panel').then(() => this.refresh()).catch((err) => Blockbench.showQuickMessage('Could not load image: ' + err.message, 2500));
					}
				},
				browse() {
					const inp = document.createElement('input');
					inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
					inp.onchange = () => this.handleFiles(inp.files);
					inp.click();
				},
				handleFiles(files) {
					Array.from(files).forEach((file) => {
						if (!/^image\//.test(file.type)) return;
						const reader = new FileReader();
						reader.onload = (ev) => addReference(ev.target.result, file.name, 'panel').then(() => this.refresh()).catch(() => {});
						reader.readAsDataURL(file);
					});
				},
				removeRef(id) {
					const i = G.references.findIndex((r) => r.id === id);
					if (i >= 0) { removeReferenceOverlay(G.references[i]); G.references.splice(i, 1); this.refresh(); }
				},
				clearRefs() { commands.clear_references(); this.refresh(); },
				runCheck() {
					try {
						const res = commands.check_model();
						const n = res && res.issue_count != null ? res.issue_count : 0;
						Blockbench.showQuickMessage(n ? (n + ' model issue(s) — run check_model for detail') : 'check_model: no issues', 2500);
					} catch (e) { Blockbench.showQuickMessage('check_model: ' + e.message, 2500); }
				},
				ago(t) {
					const s = Math.round((Date.now() - t) / 1000);
					if (s < 60) return s + 's';
					if (s < 3600) return Math.floor(s / 60) + 'm';
					return Math.floor(s / 3600) + 'h';
				},
				scoreColor,
			},
			mounted() {
				this.refresh();
				this._iv = setInterval(() => this.refresh(), 1000);
				G.onActivity = () => { try { this.refresh(); } catch (e) {} };
			},
			beforeDestroy() { clearInterval(this._iv); if (G.onActivity) G.onActivity = null; },
			template: `
<div class="bbmcp-panel">
	<div class="bbmcp-lightbox" v-if="zoom" @click="zoom = null"><img :src="zoom"></div>

	<div class="bbmcp-ask" v-for="a in asks" :key="a.id">
		<div class="q">
			{{ a.kind === 'review' ? '👁 ' : '❓ ' }}{{ a.title }}
			<span class="timer">{{ a.seconds_left }}s</span>
		</div>
		<div class="d">{{ a.question }}</div>
		<div class="d" v-if="a.details" style="font-size:11px">{{ a.details }}</div>
		<div class="shots" v-if="a.shots.length">
			<img v-for="(s,i) in a.shots" :key="i" :src="s.data_url"
				:title="s.view + (s.time != null ? ' @ ' + s.time + 's' : '')" @click="openShot(s.data_url)">
		</div>
		<textarea placeholder="What is wrong / what should change? (optional)"
			:value="comments[a.id] || ''" @input="setComment(a.id, $event)"></textarea>
		<div class="btns" v-if="a.options">
			<button class="bbmcp-btn" v-for="(opt,i) in a.options" :key="i" @click="answer(a.id, true, opt)">{{ opt }}</button>
		</div>
		<div class="btns" v-else>
			<button class="bbmcp-btn bbmcp-ok" @click="answer(a.id, true)">✔ Looks right</button>
			<button class="bbmcp-btn bbmcp-no" @click="answer(a.id, false)">✖ Needs changes</button>
		</div>
	</div>

	<div class="bbmcp-row">
		<span class="bbmcp-dot" :class="running ? 'on' : 'off'"></span>
		<span>{{ running ? 'Server on :' + port : 'Server stopped' }}</span>
		<span style="flex:1"></span>
		<button class="bbmcp-btn" @click="toggleServer">{{ running ? 'Stop' : 'Start' }}</button>
	</div>

	<div class="bbmcp-h">Reference</div>
	<div class="bbmcp-drop" :class="{drag: dragging}"
		@dragover.prevent.stop="onDragOver" @dragleave.prevent.stop="onDragLeave" @drop.prevent.stop="onDrop" @click="browse">
		Drag a reference image here<br><span style="opacity:.6">(or click to browse) — the AI reads it &amp; compares</span>
	</div>
	<div class="bbmcp-thumbs">
		<div class="bbmcp-thumb" v-for="r in refs" :key="r.id" :title="r.name">
			<div class="x" @click="removeRef(r.id)">×</div>
			<img :src="r.data_url">
			<div class="nm">{{ r.name }}</div>
		</div>
	</div>
	<div v-if="refs.length" style="margin-top:6px;">
		<button class="bbmcp-btn" @click="clearRefs">Clear all</button>
	</div>

	<div class="bbmcp-h">Match score</div>
	<div v-if="lastCompare" class="bbmcp-row" style="gap:10px;">
		<span class="bbmcp-score" :style="{color: scoreColor(lastCompare.match_percent)}">{{ lastCompare.match_percent }}%</span>
		<span style="opacity:.7">vs {{ lastCompare.reference }}<br>{{ lastCompare.view }} · {{ ago(lastCompare.time) }} ago</span>
	</div>
	<div v-else class="bbmcp-empty">No comparison yet — ask the AI to compare_reference.</div>

	<div class="bbmcp-h">Model</div>
	<div v-if="hasProject">
		<div class="bbmcp-stat"><span>Cubes</span><b>{{ cubes }}</b></div>
		<div class="bbmcp-stat"><span>Bones</span><b>{{ groups }}</b></div>
		<div class="bbmcp-stat"><span>Textures</span><b>{{ textures }}</b></div>
		<div style="margin-top:6px;"><button class="bbmcp-btn" @click="runCheck">Check model</button></div>
	</div>
	<div v-else class="bbmcp-empty">No project open.</div>

	<div class="bbmcp-h">Activity</div>
	<div class="bbmcp-log">
		<div v-if="!log.length" class="bbmcp-empty">No commands yet.</div>
		<div v-for="(a,i) in log" :key="i">
			<span class="tm">{{ ago(a.t) }}</span>
			<span :class="a.ok ? 'ok' : 'err'">{{ a.ok ? '✓' : '✗' }} {{ a.action }}</span>
			<span class="tm" v-if="a.ms != null">{{ a.ms }}ms</span>
		</div>
	</div>
</div>`,
		},
	});
	deletables.push(mcpPanel);
}

function buildUI() {
	const portSetting = new Setting(PLUGIN_ID + '_port', {
		name: 'MCP Server Port',
		description: 'Local port the BlockbenchMCP bridge listens on (127.0.0.1).',
		category: 'general',
		value: DEFAULT_PORT,
		type: 'number',
	});
	const autostartSetting = new Setting(PLUGIN_ID + '_autostart', {
		name: 'Start MCP Server automatically',
		description: 'Launch the BlockbenchMCP bridge when Blockbench opens.',
		category: 'general',
		value: true,
		type: 'toggle',
	});

	toggleAction = new Action(PLUGIN_ID + '_toggle', {
		name: 'Start MCP Server',
		description: 'Start or stop the local BlockbenchMCP bridge server.',
		icon: 'wifi_off',
		click() {
			if (G.server) stopServer();
			else startServer(getPort());
		},
	});

	const statusAction = new Action(PLUGIN_ID + '_status', {
		name: 'MCP Server Status',
		description: 'Show the current BlockbenchMCP bridge status.',
		icon: 'info',
		click() {
			const running = !!G.server;
			Blockbench.showMessageBox({
				title: 'BlockbenchMCP',
				message: running
					? `Server is running on http://127.0.0.1:${G.port}\n\nConnect your MCP client / AI to this port.`
					: 'Server is stopped. Use "Start MCP Server" to launch it.',
			});
		},
	});

	deletables.push(portSetting, autostartSetting, toggleAction, statusAction);

	try {
		MenuBar.addAction(toggleAction, 'tools');
		MenuBar.addAction(statusAction, 'tools');
	} catch (e) {
		console.warn('[BlockbenchMCP] could not add menu entries:', e);
	}

	try {
		buildPanel();
	} catch (e) {
		console.warn('[BlockbenchMCP] could not build the MCP Copilot panel:', e);
	}

	// So a review request can reach the user even when Blockbench is in the background.
	try {
		if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
			Notification.requestPermission();
		}
	} catch (e) {}

	if (autostartSetting.value && isApp) {
		try {
			startServer(getPort());
		} catch (e) {
			console.error('[BlockbenchMCP] autostart failed:', e);
		}
	}
	updateMenuLabel();
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

Plugin.register(PLUGIN_ID, {
	title: 'BlockbenchMCP',
	author: 'sosadly',
	icon: 'smart_toy',
	description:
		'Bridge that lets an AI (via the Model Context Protocol) create models, ' +
		'textures and animations inside Blockbench. Includes the MCP Copilot panel: ' +
			'drag in a reference image and the AI builds against it, scoring its silhouette ' +
			'match so models actually look like the reference instead of "almost".',
	tags: ['AI', 'Automation', 'MCP'],
	version: '0.3.0',
	min_version: '4.8.0',
	variant: 'desktop',
	onload() {
		// Reload safety: kill any server left over from a previous load.
		if (G.server) {
			try { G.server.close(); } catch (e) {}
			G.server = null;
		}
		// Cards from a previous load are driven by dead closures (their timers and
		// waiters belong to the old code), so retire them instead of leaving zombies.
		(G.pending || []).forEach((e) => { try { clearInterval(e._timer); } catch (_) {} });
		G.pending = [];
		buildUI();
	},
	onunload() {
		stopServer();
		if (G.onActivity) G.onActivity = null;
		deletables.forEach((d) => {
			try { d.delete(); } catch (e) {}
		});
		deletables = [];
		toggleAction = null;
		mcpPanel = null;
	},
});

})();
