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

// Survive plugin reloads: keep the running server on a global handle.
const G = (globalThis.__BLOCKBENCH_MCP__ = globalThis.__BLOCKBENCH_MCP__ || {
	server: null,
	port: null,
});

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

/** Fallback camera placement by angle name when no matching preset exists. */
function applyAngleName(preview, name) {
	const { center, size } = sceneBounds();
	const dist = size * 2.2 + 12;
	const dirs = {
		front: [0, 0, 1], back: [0, 0, -1], left: [-1, 0, 0], right: [1, 0, 0],
		top: [0, 1, 0.001], bottom: [0, -1, 0.001],
		iso: [1, 0.8, 1], isometric: [1, 0.8, 1],
		isometric_right_front: [1, 0.8, 1], isometric_left_front: [-1, 0.8, 1],
	};
	const v = dirs[name] || dirs.iso;
	const len = Math.hypot(v[0], v[1], v[2]) || 1;
	preview.camera.position.set(
		center[0] + (v[0] / len) * dist,
		center[1] + (v[1] / len) * dist,
		center[2] + (v[2] / len) * dist
	);
	if (preview.controls) preview.controls.target.set(center[0], center[1], center[2]);
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
	'get_guide {topic:"texturing"|"vfx"|"animation"|"reference"} for those workflows.',
	'',
	'GOLDEN WORKFLOW (loop it, do not one-shot):',
	'  get_status -> plan bones & proportions -> add_groups -> add_cubes',
	'  -> pack_uv -> create_texture -> detail_cubes -> paint_faces',
	'  -> screenshot_views (incl. the REFERENCE angle) -> check_model -> FIX -> repeat.',
	'Do at least 2-3 passes. The first pass is NEVER good enough — plan to redo it.',
	'',
	'1. SILHOUETTE FIRST. Build the grey shape and screenshot it from the reference',
	'   angle BEFORE texturing. A great texture cannot rescue wrong proportions. Match',
	'   the reference silhouette: overall stance, head size/position, limb length.',
	'',
	'2. PART COUNT & DETAIL. A good creature is 25-60+ cubes, not 6-8 boxes. Break',
	'   every limb into segments (upper/lower/foot), give the head a separate snout,',
	'   ears, brow, jaw. Add secondary forms (claws, teeth, tufts, plates). More,',
	'   smaller, overlapping parts = less blocky. Use add_cubes in bulk.',
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
	'   bad UVs / unparented cubes. If a screenshot looks wrong, FIX it — never call a',
	'   visible flaw "acceptable" or "close enough". See get_guide {topic:"reference"}.',
	'',
	'Animation formats (GeckoLib/Bedrock): every cube must live under a bone; bone',
	'origins must sit at the real joint. GeckoLib store id "geckolib", format',
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
	'BLOCKBENCH ANIMATION PLAYBOOK (GeckoLib/Bedrock).',
	'',
	'SETUP: create_animation {name,loop,length} then add_keyframes (bulk). Each keyframe:',
	'{bone, channel:"rotation"|"position"|"scale", time, value:[x,y,z], interpolation}.',
	'catmullrom = smooth; linear = snappy beats (a jaw snap, a slash); step = instant.',
	'',
	'ROTATION SIGN (verified): a bone +X rotation tilts its FRONT (-Z side) UP. To point',
	'a head/snout DOWN you need a NEGATIVE delta. Always preview the pose and confirm:',
	'  execute_script: anim.select(); Timeline.setTime(t); Animator.preview(); then',
	'  screenshot_views. Reset before saving: Modes.options.edit.select(); Timeline.setTime(0).',
	'',
	'PRINCIPLES: overlap & follow-through (limbs lag the body), anticipation before a',
	'strike, ease in/out (catmullrom), and a held contact frame on impacts. Keep loops',
	'seamless: first and last keyframe identical.',
	'',
	'QUADRUPED walk (~1s, diagonal gait): FL+BR in phase, opposite FR+BL; upper legs ±25°',
	'on X; lower legs add a ~22° knee bend offset a quarter cycle; body Y bobs twice;',
	'slight neck nod & tail sway. Run = faster, bigger swing (±40°), body Y hops — NOT a',
	'front-pair/back-pair bound (reads as a march).',
	'',
	'HUMANOID: idle = small body-Y breathe + sway; walk = arms/legs swing opposite on X',
	'(left arm with right leg) ±25-35° + body bob; attack = wind one arm back then swing',
	'through with a torso twist; cast = raise arms, pulse glow *_core bones with scale.',
	'',
	'VFX animation: see get_guide {topic:"vfx"} — scale/position pulses, trails that',
	'scale to 0, spinning cores, sweeping slashes, expanding shockwaves.',
].join('\n');

const REFERENCE_GUIDE = [
	'MATCHING A REFERENCE — how to actually hit it, not "almost".',
	'',
	'Why models miss the reference: building too few/too boxy parts, skipping the',
	'silhouette check, and (the big one) RATIONALISING flaws after a screenshot instead',
	'of fixing them. Beat all three with discipline:',
	'',
	'1. READ THE REFERENCE FIRST. List concretely, in words: overall shape/stance;',
	'   head size & position; number and shape of limbs/appendages; key features (eyes,',
	'   horns, fins, runes); the colour palette (name ~5 colours); proportions (what is',
	'   biggest?). Build a part list from this BEFORE touching Blockbench.',
	'',
	'2. SILHOUETTE TO THE SAME ANGLE. Screenshot the grey model from the reference',
	'   camera (screenshot_views with explicit {position,target} if needed) and overlay',
	'   mentally. NOTE: models usually face -Z, so the "back" preset shows the FACE. Fix',
	'   shape until the silhouette matches. Only then texture.',
	'',
	'3. MATCH THE PALETTE. Pull the actual colours from the reference into detail_cubes',
	'   `colors` and paint_faces. Wrong hue/saturation is the most obvious miss.',
	'',
	'4. CRITICAL SELF-REVIEW EACH PASS — be your own harshest critic. For every',
	'   screenshot ask: does THIS specifically match the reference? Head too big? Neck',
	'   too long? Pose wrong? Colour off? Eyes misplaced? Write the differences down and',
	'   FIX them next pass. Do NOT write "looks great / close enough / acceptable" about',
	'   something you can see is off — that is the #1 cause of bad results.',
	'',
	'5. ITERATE 3-4 PASSES minimum. Compare to the reference, not to your last attempt.',
	'   Stop only when a side-by-side would convince the user, not just you.',
].join('\n');

const GUIDES = {
	modeling: MODELING_GUIDE,
	texturing: TEXTURING_GUIDE,
	vfx: VFX_GUIDE,
	animation: ANIMATION_GUIDE,
	reference: REFERENCE_GUIDE,
};

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

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

	async export_model(p) {
		requireProject();
		if (!p || !p.path) throw new Error('path is required');
		const codecId = p.codec || 'gltf';
		const codec = Codecs[codecId];
		if (!codec) throw new Error('Unknown codec: ' + codecId + '. Available: ' + Object.keys(Codecs).join(', '));
		// codec.compile() may be sync or return a Promise (Codecs.gltf does).
		const content = await codec.compile({ format: p.format || codecId });
		const data = typeof content === 'string' ? content : JSON.stringify(content);
		require('fs').writeFileSync(p.path, data);
		return { exported: true, path: p.path, codec: codecId, bytes: data.length };
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
		Undo.initEdit({ outliner: true });
		const group = new Group({
			name: p.name || 'group',
			origin: num3(p.origin, [0, 0, 0]),
			rotation: num3(p.rotation, [0, 0, 0]),
		}).init();
		group.addTo(parent || 'root');
		Undo.finishEdit('MCP: add group');
		Canvas.updateAll();
		return serializeGroup(group);
	},

	add_cube(p) {
		requireProject();
		const parent = p.parent ? findGroup(p.parent) : null;
		if (p.parent && !parent) throw new Error('Parent group not found: ' + p.parent);
		const from = num3(p.from, [0, 0, 0]);
		const to = num3(p.to, [from[0] + 1, from[1] + 1, from[2] + 1]);
		Undo.initEdit({ outliner: true, elements: [] });
		const cube = new Cube({
			name: p.name || 'cube',
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
		Undo.initEdit({ outliner: true });
		const created = {};
		const out = [];
		for (const spec of p.groups) {
			let parent = null;
			if (spec.parent) {
				parent = created[spec.parent] || findGroup(spec.parent);
				if (!parent) throw new Error('Parent group not found: ' + spec.parent);
			}
			const group = new Group({
				name: spec.name || 'group',
				origin: num3(spec.origin, [0, 0, 0]),
				rotation: num3(spec.rotation, [0, 0, 0]),
			}).init();
			group.addTo(parent || 'root');
			created[group.name] = group;
			out.push(serializeGroup(group));
		}
		Undo.finishEdit('MCP: add groups');
		Canvas.updateAll();
		return { created: out.length, groups: out };
	},

	// Build many cubes at once — the efficient way to author a detailed model.
	add_cubes(p) {
		requireProject();
		if (!Array.isArray(p.cubes) || !p.cubes.length) throw new Error('cubes (array) is required');
		Undo.initEdit({ outliner: true, elements: [] });
		const out = [];
		for (const spec of p.cubes) {
			const parent = spec.parent ? findGroup(spec.parent) : null;
			if (spec.parent && !parent) throw new Error('Parent group not found: ' + spec.parent);
			const from = num3(spec.from, [0, 0, 0]);
			const to = num3(spec.to, [from[0] + 1, from[1] + 1, from[2] + 1]);
			const cube = new Cube({
				name: spec.name || 'cube',
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

		const byType = {};
		issues.forEach((i) => { byType[i.issue] = (byType[i.issue] || 0) + 1; });
		return {
			cubes: Cube.all.length, groups: Group.all.length, textures: Texture.all.length,
			texture_size: [tw, th], animation_format: animMode,
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
		Undo.initEdit({ keyframes: [] });
		let maxTime = anim.length;
		const created = [];
		for (const k of p.keyframes || []) {
			const group = findGroup(k.bone);
			if (!group) throw new Error('Bone (group) not found: ' + k.bone);
			const animator = anim.getBoneAnimator(group);
			if (!animator) throw new Error('Cannot animate bone: ' + k.bone);
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
		anim.setLength(maxTime);
		Undo.finishEdit('MCP: add keyframes');
		updateKeyframeSelection && updateKeyframeSelection();
		return { created: created.length, keyframes: created, animation: serializeAnimation(anim) };
	},

	remove_animation(p) {
		requireProject();
		const anim = findAnimation(p.animation);
		if (!anim) throw new Error('Animation not found: ' + p.animation);
		anim.remove(true);
		return { removed: true };
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

	screenshot(p) {
		requireProject();
		const preview = Preview.selected;
		const options = {};
		if (p && p.width) options.width = p.width;
		if (p && p.height) options.height = p.height;
		return new Promise((resolve) => {
			Screencam.screenshotPreview(preview, options, (dataUrl) => {
				resolve({
					mime: 'image/png',
					data_url: dataUrl,
					base64: dataUrl.replace(/^data:image\/png;base64,/, ''),
				});
			});
		});
	},

	// Capture several camera angles in one call so you can see the whole model
	// at once and spot problems (gaps, wrong rotations, missing detail) from
	// every side. `views` is a list of preset ids ('front','back','left',
	// 'right','top','bottom','isometric_right_front',...) or {position,target}.
	screenshot_views(p) {
		requireProject();
		const preview = Preview.selected;
		const views = (p && Array.isArray(p.views) && p.views.length)
			? p.views
			: ['isometric_right_front', 'front', 'left', 'back'];
		const options = {};
		if (p && p.width) options.width = p.width;
		if (p && p.height) options.height = p.height;
		const shotOne = () => new Promise((res) =>
			Screencam.screenshotPreview(preview, options, (d) => res(d)));
		return (async () => {
			const shots = [];
			for (const v of views) {
				if (typeof v === 'string') {
					const preset = (typeof DefaultCameraPresets !== 'undefined' && DefaultCameraPresets)
						? DefaultCameraPresets.find((x) => x.id === v || x.name === v) : null;
					if (preset && preview.loadAnglePreset) preview.loadAnglePreset(preset);
					else applyAngleName(preview, v);
				} else if (v && typeof v === 'object') {
					if (Array.isArray(v.position)) preview.camera.position.set(v.position[0], v.position[1], v.position[2]);
					if (Array.isArray(v.target) && preview.controls) preview.controls.target.set(v.target[0], v.target[1], v.target[2]);
				}
				if (preview.controls && preview.controls.updateSceneScale) preview.controls.updateSceneScale();
				preview.render();
				const dataUrl = await shotOne();
				shots.push({
					view: typeof v === 'string' ? v : 'custom',
					data_url: dataUrl,
					base64: dataUrl.replace(/^data:image\/png;base64,/, ''),
				});
			}
			return { count: shots.length, shots };
		})();
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

async function dispatch(action, params) {
	const handler = commands[action];
	if (!handler) throw new Error('Unknown command: ' + action);
	return await handler(params || {});
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

		if (headersDone && buffer.length >= headerLength + contentLength) {
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

function updateMenuLabel() {
	if (!toggleAction) return;
	const running = !!G.server;
	toggleAction.setName(running ? `Stop MCP Server (:${G.port})` : 'Start MCP Server');
	if (toggleAction.setIcon) toggleAction.setIcon(running ? 'wifi' : 'wifi_off');
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
		'textures and animations, take screenshots and install plugins inside Blockbench.',
	tags: ['AI', 'Automation', 'MCP'],
	version: '0.2.0',
	min_version: '4.8.0',
	variant: 'desktop',
	onload() {
		// Reload safety: kill any server left over from a previous load.
		if (G.server) {
			try { G.server.close(); } catch (e) {}
			G.server = null;
		}
		buildUI();
	},
	onunload() {
		stopServer();
		deletables.forEach((d) => {
			try { d.delete(); } catch (e) {}
		});
		deletables = [];
		toggleAction = null;
	},
});

})();
