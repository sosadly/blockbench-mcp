# Workflow & ready-to-paste execute_script snippets

All snippets below are the **body** of an `execute_script` call (the `code` argument). They run
inside Blockbench with the full API (`Project, Cube, Group, Texture, Animation, Undo, Canvas,
Outliner, Format, Blockbench, Modes, Timeline, Animator`, ...). Adapt names/colours, then run.

## Tool first, script second

The four generators are dedicated tools — **use them** rather than pasting a script:

| Tool | Script equivalent below |
|---|---|
| `voxelize_matrix` | §1 |
| `generate_array` | §2 |
| `add_hollow_volume` | §3 |
| `pack_uv` | §4 |

The scripts are here for the cases the tools do not cover: a variation you need to invent (a
matrix whose depth comes from a *second* matrix, a spiral instead of a ring, a shell that
follows a curve), or when you want to generate and immediately post-process in one call. They
also show the exact internal API the tools use, so you can extend them safely.

---

## 1. Matrix voxelizer — draw it in 2D, get it in 3D

The single highest-leverage technique in this file. You are excellent at pixel art and bad at
3D arithmetic, so describe the SHAPE as characters and let the code place the cubes.

```js
// params: { matrix:[...], palette:{...}, origin:[x,y,z], pixel:1, plane:'xy', parent:'hand_right' }
const M = params.matrix, PAL = params.palette || {}, PS = params.pixel || 1;
const O = params.origin || [0,0,0];
const AXES = { xy:{u:0,v:1,d:2}, xz:{u:0,v:2,d:1}, yz:{u:2,v:1,d:0} }[params.plane || 'xy'];
const parent = params.parent ? Group.all.find(g => g.name === params.parent) : null;
const rows = M.length, cols = M.reduce((m,r) => Math.max(m, r.length), 0);
const made = [];
Undo.initEdit({ outliner:true, elements:[] });
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    const ch = M[r][c] || ' ';
    if (ch === ' ' || ch === '.') continue;            // blank
    const e = PAL[ch] || {};
    const from = [0,0,0], to = [0,0,0];
    from[AXES.u] = O[AXES.u] + c * PS;          to[AXES.u] = from[AXES.u] + PS;
    from[AXES.v] = O[AXES.v] + (rows-1-r) * PS; to[AXES.v] = from[AXES.v] + PS;  // row 0 on TOP
    from[AXES.d] = O[AXES.d] + (e.offset_z || 0);
    to[AXES.d]   = from[AXES.d] + (e.depth != null ? e.depth : 1);
    const cube = new Cube({
      name: (e.name || 'vox') + '_' + (made.length+1),
      from, to, origin: from,
      inflate: e.inflate || 0,
      box_uv: !!Format.box_uv, autouv: Format.box_uv ? 0 : 1,
    }).init();
    cube.addTo(parent || 'root');
    if (Texture.all.length) cube.applyTexture(Texture.getDefault(), true);
    made.push(cube.name);
  }
}
Undo.finishEdit('voxelize'); Canvas.updateAll();
return { created: made.length, grid:[cols, rows] };
```

Call it with, for example, a scythe blade in the side plane:

```json
{"matrix":["......####",".....#####","...#######","..######..",".#####....","######....","#####.....","####......"],
 "palette":{"#":{"name":"blade","depth":1}},
 "plane":"yz","origin":[0,18,-4],"pixel":1,"parent":"hand_right"}
```

**Rules of thumb.** Draw the silhouette at 8–24 cells across — bigger grids just make cubes you
cannot see. Give the *edge* character a smaller `depth` and a small `offset_z` so the blade
tapers instead of reading as a slab. Use a second character for a fuller/inlay at
`offset_z: -0.3` to break the flat face. Merge runs (`merge_adjacent` in the tool) when the
shape is wide and solid.

---

## 2. Array generator — rows, rings and fringes

Repeat one element with jitter, taper and an alternating depth so nothing z-fights.

```js
// params: { count:9, size:[2.2,5,1.2], start:[-6,7,3.2], end:[6,7,3.2],
//           jitter:[0.15,0.4,0], decay:[-0.05,-0.25,0], stagger:0.12,
//           tilt:[-9,9], anchor:'top', parent:'body', prefix:'hem' }
const P = params, n = P.count;
const parent = P.parent ? Group.all.find(g => g.name === P.parent) : null;
const rnd = (a) => (Math.random()*2-1) * (a || 0);
const made = [];
Undo.initEdit({ outliner:true, elements:[] });
for (let i = 0; i < n; i++) {
  const t = n > 1 ? i/(n-1) : 0;
  const pt = [0,1,2].map(k => P.start[k] + (P.end[k]-P.start[k])*t + rnd((P.jitter||[])[k]));
  if (P.stagger && i % 2) pt[2] += P.stagger;                  // alternate depth: no z-fighting
  const sz = [0,1,2].map(k => Math.max(0.05, P.size[k] + ((P.decay||[])[k]||0)*i));
  const from = P.anchor === 'top'
    ? [pt[0]-sz[0]/2, pt[1]-sz[1], pt[2]-sz[2]/2]               // hangs from the point
    : [pt[0]-sz[0]/2, pt[1]-sz[1]/2, pt[2]-sz[2]/2];            // centred on it
  const cube = new Cube({
    name: (P.prefix || 'element') + '_' + (i+1),
    from, to: [from[0]+sz[0], from[1]+sz[1], from[2]+sz[2]],
    origin: pt,
    rotation: P.tilt ? [0, 0, P.tilt[0] + Math.random()*(P.tilt[1]-P.tilt[0])] : [0,0,0],
    box_uv: !!Format.box_uv, autouv: Format.box_uv ? 0 : 1,
  }).init();
  cube.addTo(parent || 'root');
  if (Texture.all.length) cube.applyTexture(Texture.getDefault(), true);
  made.push(cube.name);
}
Undo.finishEdit('array'); Canvas.updateAll();
return { created: made.length };
```

Ring variant (teeth in a jaw, spikes around a collar) — swap the position line for:

```js
const th = (P.start_deg + (360/n)*i) * Math.PI/180;
const pt = [P.center[0] + P.radii[0]*Math.cos(th), P.center[1], P.center[2] + P.radii[1]*Math.sin(th)];
const faceOut = Math.atan2(-Math.cos(th), -Math.sin(th)) * 180/Math.PI;  // rotation[1]
```

**Anti-z-fighting checklist for any array:** step ≈ element width (small overlap only), a unique
outer depth per piece (`stagger`, or `+ i*0.02`), never two pieces at identical x/y/z, and never
two faces on the same plane. Run `check_model` afterwards and fix every `coplanar_overlap`.

---

## 3. Hollow shell — a cavity instead of a box

Six slabs that tile the shell exactly, so the walls cannot overlap each other. `open` lists the
faces to skip (`north` = -Z = the model's front).

```js
// params: { from:[-5,24,-5], to:[5,34,5], t:1.5, open:['north','down'], name:'hood', parent:'head' }
const P = params, t = P.t || 1, open = new Set(P.open || []);
const lo = P.from, hi = P.to, has = d => !open.has(d);
const yLo = lo[1] + (has('down') ? t : 0), yHi = hi[1] - (has('up') ? t : 0);
const zLo = lo[2] + (has('north') ? t : 0), zHi = hi[2] - (has('south') ? t : 0);
const parent = P.parent ? Group.all.find(g => g.name === P.parent) : null;
const walls = {
  down:  [[lo[0], lo[1], lo[2]], [hi[0], lo[1]+t, hi[2]]],
  up:    [[lo[0], hi[1]-t, lo[2]], [hi[0], hi[1], hi[2]]],
  north: [[lo[0], yLo, lo[2]], [hi[0], yHi, lo[2]+t]],
  south: [[lo[0], yLo, hi[2]-t], [hi[0], yHi, hi[2]]],
  west:  [[lo[0], yLo, zLo], [lo[0]+t, yHi, zHi]],
  east:  [[hi[0]-t, yLo, zLo], [hi[0], yHi, zHi]],
};
Undo.initEdit({ outliner:true, elements:[] });
const made = [];
for (const dir in walls) {
  if (!has(dir)) continue;
  const [f, to] = walls[dir];
  if (to[0]-f[0] <= 0 || to[1]-f[1] <= 0 || to[2]-f[2] <= 0) continue;
  const cube = new Cube({ name: (P.name||'shell') + '_' + dir, from: f, to, origin: f,
    box_uv: !!Format.box_uv, autouv: Format.box_uv ? 0 : 1 }).init();
  cube.addTo(parent || 'root');
  if (Texture.all.length) cube.applyTexture(Texture.getDefault(), true);
  made.push(cube.name);
}
Undo.finishEdit('hollow'); Canvas.updateAll();
return { walls: made, cavity: { from:[lo[0]+(has('west')?t:0), yLo, zLo], to:[hi[0]-(has('east')?t:0), yHi, zHi] } };
```

Fill the returned cavity with the face, the skull, the glow core — keeping ≥0.1 clear of the
walls so nothing z-fights.

---

## 4. Pack box UVs (REQUIRED before texturing)

New box-UV cubes all overlap at `[0,0]`. This shelf-packs them and updates each cube's faces.
Run it after the LAST `add_cubes` / generator call. If `used_height` exceeds the texture height,
raise the texture size (§8) and re-run. (The `pack_uv` tool does this with auto-resize.)

```js
const TW = Project.texture_width, pad = 1;
const items = Cube.all.map(c => {
  const w=Math.ceil(Math.abs(c.to[0]-c.from[0])),
        h=Math.ceil(Math.abs(c.to[1]-c.from[1])),
        d=Math.ceil(Math.abs(c.to[2]-c.from[2]));
  return { c, fw: 2*(w+d), fh: (h+d) };           // box-UV footprint
}).sort((a,b)=> b.fh-a.fh);                         // tallest first = tighter packing
Undo.initEdit({ elements: Cube.all, uv_only: true });
let x=0,y=0,rowH=0,maxX=0;
for (const it of items){
  if (x+it.fw+pad > TW){ x=0; y+=rowH+pad; rowH=0; }
  it.c.box_uv = true; it.c.uv_offset = [x,y];
  if (it.c.mapAutoUV) it.c.mapAutoUV();             // recompute the 6 face UVs from uv_offset
  x += it.fw+pad; rowH = Math.max(rowH, it.fh); maxX = Math.max(maxX, x);
}
Undo.finishEdit('pack uv'); Canvas.updateAll();
return { packed: items.length, used: [maxX, y+rowH], tex: [TW, Project.texture_height] };
```

Footprint math: a cube of size (w,h,d) unwraps to `2*(w+d)` wide and `(h+d)` tall, in texture
pixels (1 unit = 1 px when `uv_width == texture_width`). A 150-cube model usually needs a
128–256 px sheet; check `used` against the texture height and grow it before painting.

---

## 5. Smooth texture bake (the core of "good textures")

Assigns the texture to every face (no gaps), then bakes a smooth, shaded base per face and
blurs each island. Edit `baseFor(name)` to map cube-name → colour — which is why the generators
let you name what they produce. Cubes named `*_core` are treated as emissive/glow. Paint crisp
features AFTER this (§6).

```js
const tex = Texture.all[0];
Undo.initEdit({elements:Cube.all});
Cube.all.forEach(c=>{ for(const d in c.faces){ if(c.faces[d]) c.faces[d].texture = tex.uuid; } });
Undo.finishEdit('assign tex');

const hexToRgb=h=>{h=h.replace('#','');return{r:parseInt(h.slice(0,2),16),g:parseInt(h.slice(2,4),16),b:parseInt(h.slice(4,6),16)};};
const cl=v=>v<0?0:v>255?255:v|0;
const shade=(hex,f)=>{const c=hexToRgb(hex);return 'rgb('+cl(c.r*f)+','+cl(c.g*f)+','+cl(c.b*f)+')';};
const rectOf=f=>{const u=f.uv;return{x:Math.round(Math.min(u[0],u[2])),y:Math.round(Math.min(u[1],u[3])),w:Math.round(Math.abs(u[2]-u[0])),h:Math.round(Math.abs(u[3]-u[1]))};};

// ---- EDIT THIS: cube-name -> base colour ----
const GREENS=['#5f7a2e','#6d8a38','#7c9442','#56702a','#849a48'];
const isGlow = n => /_core$/.test(n);
function baseFor(n){
  if(isGlow(n))                 return '#3fe0d6';   // teal glow
  if(/_cap$|_base$|chain|cord|rivet|stud/.test(n)) return '#2a2620'; // dark metal/frame
  if(/blade|edge/.test(n))      return '#b9c3cb';   // steel
  if(/antler|branch|horn/.test(n)) return '#6b4a2e';
  if(/leaf|moss/.test(n))       return GREENS[(Math.random()*GREENS.length)|0];
  if(/hem|fringe|cloak|shingle/.test(n)) return '#4a3b52'; // cloth
  if(/head|torso|body|limb|leg|arm/.test(n)) return '#c8bca0'; // pale body
  return '#6e4f30';                                  // default brown
}
// up brighter, down darker, slight side variation -> soft 3D form
const faceMul={up:1.12,down:0.78,north:0.95,south:1.0,east:1.06,west:0.88};

tex.edit((canvas)=>{
  const ctx=canvas.getContext('2d'); ctx.imageSmoothingEnabled=false;
  ctx.fillStyle='#3a3530'; ctx.fillRect(0,0,canvas.width,canvas.height); // backdrop
  const jobs=[];
  Cube.all.forEach(cube=>{ const base=baseFor(cube.name), glow=isGlow(cube.name);
    for(const dir in cube.faces){ const f=cube.faces[dir]; if(!f) continue;
      const r=rectOf(f); if(r.w<=0||r.h<=0) continue;
      const mul = glow?1:(faceMul[dir]??1);
      const g=ctx.createLinearGradient(0,r.y,0,r.y+r.h);
      if(glow){ g.addColorStop(0,shade(base,1.12)); g.addColorStop(.5,shade(base,1.42)); g.addColorStop(1,shade(base,1.05)); }
      else    { g.addColorStop(0,shade(base,mul*1.1)); g.addColorStop(1,shade(base,mul*0.85)); }
      ctx.fillStyle=g; ctx.fillRect(r.x,r.y,r.w,r.h);
      jobs.push({cube,dir,r,base,mul,glow});
    }});
  // subtle low-contrast mottle (skip glow + hard parts)
  jobs.forEach(({cube,r,base,mul,glow})=>{ if(glow||/_cap$|_base$|chain|cord/.test(cube.name)) return;
    const n=Math.max(1,Math.floor(r.w*r.h*0.10));
    for(let i=0;i<n;i++){ const px=r.x+(Math.random()*r.w|0), py=r.y+(Math.random()*r.h|0);
      ctx.fillStyle=shade(base,mul*(0.86+Math.random()*0.26)); ctx.fillRect(px,py,1,Math.random()<.5?2:1); } });
  // 3x3 box blur per island (the "smooth brush"); skip glow + hard parts for crisp edges
  const blur=(rx,ry,rw,rh,amt)=>{ if(rw<2||rh<2) return;
    const s=ctx.getImageData(rx,ry,rw,rh).data, out=ctx.createImageData(rw,rh), d=out.data;
    for(let y=0;y<rh;y++)for(let x=0;x<rw;x++){ let R=0,G=0,B=0,N=0;
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){ const xx=x+dx,yy=y+dy; if(xx<0||yy<0||xx>=rw||yy>=rh)continue;
        const i=(yy*rw+xx)*4; R+=s[i];G+=s[i+1];B+=s[i+2];N++; }
      const o=(y*rw+x)*4; d[o]=cl(s[o]*(1-amt)+R/N*amt); d[o+1]=cl(s[o+1]*(1-amt)+G/N*amt); d[o+2]=cl(s[o+2]*(1-amt)+B/N*amt); d[o+3]=255; }
    ctx.putImageData(out,rx,ry); };
  jobs.forEach(({cube,r,glow})=>{ if(!glow && !/_cap$|_base$|chain|cord/.test(cube.name)) blur(r.x,r.y,r.w,r.h,0.55); });
}, {edit_name:'smooth bake', no_undo:false});
Canvas.updateAll();
return {baked:true, cubes:Cube.all.length};
```

Tuning: pale/smooth surfaces -> lower mottle (`*0.06`, amplitude `0.10`); fur/foliage -> higher.
For grizzled backs add a few darker vertical streaks on `up` faces before the blur. The
`detail_cubes` tool does all of this with a `colors` regex list if you would rather not script it.

---

## 6. Paint crisp features (eyes / nose / claws) — run AFTER the bake

Operate on a specific cube face using its UV rect; coordinates are face-relative.

```js
const tex=Texture.all[0];
const rectOf=f=>{const u=f.uv;return{x:Math.round(Math.min(u[0],u[2])),y:Math.round(Math.min(u[1],u[3])),w:Math.round(Math.abs(u[2]-u[0])),h:Math.round(Math.abs(u[3]-u[1]))};};
const head=Cube.all.find(c=>c.name==='head'); const r=rectOf(head.faces.north);
tex.edit((canvas)=>{ const ctx=canvas.getContext('2d'); ctx.imageSmoothingEnabled=false;
  const X=r.x,Y=r.y,W=r.w;
  // glowing teal almond eyes
  const eye=cx=>{ const cy=4;
    ctx.fillStyle='#0c1817'; ctx.fillRect(X+cx-1,Y+cy-1,4,6);   // dark socket
    ctx.fillStyle='#29bdb4'; ctx.fillRect(X+cx,Y+cy,2,4);        // teal
    ctx.fillStyle='#63e7dd'; ctx.fillRect(X+cx,Y+cy+1,2,2);      // brighter
    ctx.fillStyle='#ccfff9'; ctx.fillRect(X+cx,Y+cy+1,1,1); };   // hotspot
  eye(1); eye(W-3);
}, {edit_name:'features', no_undo:false});
Canvas.updateAll(); return {ok:true};
```

The `paint_faces` tool does the same with face-relative coords if you prefer not to script it.

---

## 7. Density audit in one line

Before texturing, ask the model to grade itself. The `audit_complexity` tool does this properly
(monoliths, layering, bare faces); this is the quick version when you just want the numbers.

```js
const vol=c=>Math.abs((c.to[0]-c.from[0])*(c.to[1]-c.from[1])*(c.to[2]-c.from[2]));
const total=Cube.all.reduce((s,c)=>s+vol(c),0)||1;
const big=Cube.all.map(c=>({name:c.name, pct:Math.round(vol(c)/total*100)}))
  .filter(e=>e.pct>15).sort((a,b)=>b.pct-a.pct);
const micro=Cube.all.filter(c=>[0,1,2].every(k=>Math.abs(c.to[k]-c.from[k])<=2)).length;
return { cubes:Cube.all.length, bones:Group.all.length, micro_pct:Math.round(micro/Cube.all.length*100), biggest:big };
```

Any cube over ~30% of the total volume is a monolith: segment it and layer something on it.

---

## 8. Resize the texture (when packing overflows)

```js
const TW=160; Project.texture_width=TW; Project.texture_height=TW;
const tex=Texture.all[0];
const c=document.createElement('canvas'); c.width=TW;c.height=TW;
const x=c.getContext('2d'); x.fillStyle='#3a3530'; x.fillRect(0,0,TW,TW);
tex.width=TW; tex.height=TW; tex.updateSource(c.toDataURL());
return {size:TW};
```

---

## 9. Preview an animation pose (then screenshot it)

```js
const a=Animation.all.find(x=>x.name===params.name);
a.select(); Timeline.setTime(params.t); Animator.preview();
return {animation:a.name, t:params.t};
```
Pass `params:{name:'animation.x.walk', t:0.25}`. Then call `screenshot_views`. To return to the
rest pose for saving: `Modes.options.edit.select(); Timeline.setTime(0); Canvas.updateAll();`

---

## 10. Export texture PNG + animation JSON (no `require`!)

```js
const tex=Texture.all[0];
Blockbench.writeFile(params.png, { content: tex.getDataURL(), savetype:'image' });
const built=Animator.buildFile(undefined,false);
const content=typeof built==='string'?built:JSON.stringify(built,null,2);
Blockbench.writeFile(params.anim, { content, savetype:'text' });
return { png:params.png, anim:params.anim };
```
Pass `params:{png:'D:/.../model.png', anim:'D:/.../model.animation.json'}`. Geometry itself is
exported with the `export_project` tool.
