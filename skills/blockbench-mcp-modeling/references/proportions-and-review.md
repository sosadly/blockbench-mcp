# Proportions, density & the review checklist

## Score the silhouette — don't eyeball it

The biggest single fix: stop judging the match by eye. Use **`compare_reference {view}`**
each pass. It renders your model from the reference angle, returns a **`match_percent`**
(silhouette IoU), `aspect_delta_pct`, `ref_only_pct`/`model_only_pct`, and a composite
`[reference | model | overlay]` image (RED = reference-only → add mass; BLUE = model-only →
trim; WHITE = match). Fix the **single biggest delta** it reports, then re-run. Iterate to
`match_percent >= 85` (90+ for hero assets) **before texturing**. Pair it with
**`measure_model`** to match numeric proportions (e.g. `head_height_fraction`).
The user drops the reference into the **MCP Copilot panel**; read it with `get_reference`.

## Build the silhouette FIRST, texture later

Build the **grey (untextured) silhouette** and `compare_reference` it from the reference's
angle before investing in texture. Fix the shape until the score is high; a great texture
cannot rescue wrong proportions. (Models usually face -Z, so the `back` preset shows the
creature's FACE — pass that as `view`, or aim the camera with `set_camera_angle` first.)

## Density and layering — the second gate

A correct silhouette made of 15 boxes is still a bad model. Run **`audit_complexity`** and read
three numbers:

- **cube count vs budget** — prop 30–60, mob/NPC 100–180, hero 180–300+. A humanoid under ~70
  cubes is a draft. Verdict `too_primitive` means keep building.
- **`overlapping_pct`** — how much geometry actually overlaps other geometry. Under ~25% means
  you have a set of separate boxes, not layered forms. Secondary volumes (armour, cloth,
  plating) should stand **0.3–0.8 proud** of the primary mass.
- **`micro_pct`** — share of cubes ≤2 units. Under 15% means no silhouette-breaking detail:
  no studs, buckles, teeth, trim or rivets.

Plus two issue types worth fixing on sight: `monolithic_box` (one cube holding >30% of the
model's volume with nothing layered on it) and `undetailed_slab` (a large face with nothing on
or near it — it names the offending face).

## Quadruped (e.g. bear) — compact, body-dominant

The single biggest failure mode is the **"camel" silhouette**: a tall hump + long neck with a
high/forward head + long thin legs. Fix by copying real compact-animal proportions:

- **Body** is a big dominant box; everything else is small relative to it. Segment it into 2–3
  blocks so it is not literally one cube.
- **Head** small and LOW at the front, head-top clearly BELOW the body top, almost no neck
  (neck rest rotation ~0, head right against the body front). Short broad snout nub.
- **Hump** (if any) is a subtle +1.5–2 rise over the shoulders, blended — not a tall block.
- **Legs** short, thick, stubby; body sits low to the ground; 3 segments each.

Verified bear numbers (geckolib, ground y=0): body `[-7,7,-10]→[7,17,10]`; subtle hump
`[-6.5,16.5,-9]→[6.5,18.5,-1]`; head `[-4,8,-15]→[4,15,-9]` (top 15 < body top 17); snout
`[-3,8,-17.5]→[3,12,-15]`; front legs upper y4–9.5 / lower y0–4.5 (width ~4).

## Humanoid (e.g. spirit / character)

Steve-like rig, but tune to the reference:
- bones: `body[0,12,0]`, `head[0,23,0]`, `arm_left/right` at shoulders `[±5,22]`,
  `leg_left/right` at hips `[±2.2,12]`, plus decorative bones (antlers, lanterns) under head.
- Split limbs upper/lower/hand for bending. Make the head as tall/large as the design wants.
- Decorative mass (cloak, leaves, armour) is many small cubes parented to body/head — generated
  with `generate_array`, not hand-placed, and staggered in depth so it cannot z-fight.

## Capes / cloaks / skirts

Never one cube. Build them as **vertical panels** (3–5, each slightly rotated outward at the
bottom) plus a **shingled fringe row** along the hem
(`generate_array {anchor:'top', depth_stagger:0.1, jitter:[0.1,0.3,0], size_decay:[0,-0.2,0]}`).
Match the design intent: a back cape should be **long at the back** and may be **open at the
front** (only a neck collar) so a chest pendant stays visible. Don't blanket the whole torso
unless the reference does.

## Hoods, helmets, masks

Never a solid box over the head. `add_hollow_volume {bounds, wall_thickness:1.5,
open_faces:['north','down']}` gives a shell with a real cavity; put the face inside it, at least
0.1 clear of the walls, and let the dark interior read as depth. The same call builds pauldrons
(open `down`), bracers (open `up`+`down`) and eye sockets (open `north`).

## Glow / accents

Bright accent parts (eyes, lanterns, gems) are named `*_core` and filled bright in the bake —
including cubes produced by a generator, so `palette:{'o':{name:'eye_core'}}` is enough. Place
them where the reference shows them; keep them clear of other geometry (lanterns hang OUTSIDE
the head silhouette, not clipping into it).

## Review checklist each pass (be honest)

**Shape**
- Did I run `compare_reference` from the reference's angle? What is `match_percent`?
- Overlay panel: any large RED (missing mass) or BLUE (extra mass) regions to fix?
- Same overall shape/stance? Head size & position right? Limb length/thickness?

**Density (`audit_complexity`)**
- Verdict — is it still `too_primitive`? Then it is not ready for anything else.
- Any `monolithic_box`? Segment it and layer something on it.
- Any `undetailed_slab`? **No large flat surface may stay bare** — break it with an overlay, a
  45° bevel cube, or a `generate_array` row. This is the difference between "a box with a nice
  texture" and a model.
- `overlapping_pct` ≥ 25 and `micro_pct` ≥ 15?
- Is anything rotated at all? A model with zero rotated elements reads as a grid.

**Z-fighting (`check_model`)**
- Zero `coplanar_overlap` pairs. Two faces on the same plane flicker in every renderer.
- **The offset rule:** decorative pieces never sit flush. Push each out by a small *unique*
  amount and stagger neighbours by **0.05–0.2**; when two cubes overlap, make one clearly
  penetrate the other by ≥0.1 (ideally ~0.5). `generate_array {depth_stagger}` does this for a
  whole row; for hand-placed pieces vary the depth yourself.
- Two billboard planes must never share a position — offset by ≥0.1.

**Finish**
- Texture: smooth (no harsh noise, no per-cube grid outlines)? Colours match the palette?
- Features: eyes/face crisp and placed like the reference? Glow reads as glow?
- `check_model`: zero untextured faces / bad UVs / unparented cubes?
- `check_sides`: every `*_left` / `*_right` name matches the geometry?
- **If anything looks wrong in the screenshot, FIX it now.** Never call a visible flaw
  "acceptable" — that is the #1 mistake. Match the reference, not a lowered bar.

## Worked lessons (what real feedback taught)

- A first "grizzly" got roasted as a "camel bear thing" — caused entirely by the proportions
  above. Rebuilding compact (small low head, subtle hump, stubby legs, big body) fixed it.
- Harsh per-pixel noise + a dark 1px outline on every face looks "dirty/sharp". Smooth
  gradients + soft mottle + per-island blur (and NO per-face outline) is the look people want.
- Decorative leaf cloaks z-fight badly when many panels overlap coplanar — that is exactly what
  `depth_stagger` exists for; do not reduce the piece count to avoid it, stagger the depths.
- Bodies/limbs are often the SAME pale wood/stone colour as the head, with darker accents only
  at the extremities (ankles/wrists) — don't default everything to brown.
- The models that get rejected are almost never rejected for the texture. They are rejected for
  being 15 boxes: no cavity under the hood, one slab for the cloak, a flat unbroken chest.
