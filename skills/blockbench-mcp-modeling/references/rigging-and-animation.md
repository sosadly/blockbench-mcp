# Rigging & animation

> Start from the tools: **`create_rig`** builds a correct segmented skeleton,
> **`check_rig`** must report `ready_to_animate`, **`generate_animation`** produces a
> direction-correct base cycle, and **`analyze_animation`** measures the result. The recipes
> below are for refining by hand afterwards.

## Rig basics

- Make bones with `add_groups` (or `create_rig`); put each bone's `origin` at the real JOINT
  (shoulder/elbow/wrist/hip/knee/ankle) so rotation pivots correctly. Parents may reference
  siblings created earlier in the same call.
- **Three bones per limb minimum**: `arm_upper` → `arm_lower` → `hand`, `leg_upper` →
  `leg_lower` → `foot`. Two-bone limbs have no elbow or knee and always animate like cardboard.
  Plus hips → spine → chest → neck → head, and 2-4 bone tail/cloak chains for follow-through.
  A creature rig is normally 15-30 bones.
- Parent cubes to the bone that should move them — forearm cubes go under `arm_lower`, not
  `arm_upper`, or the elbow bend tears the mesh. Decorative cubes parent to body/head.
- For animation formats (GeckoLib/Bedrock) every animated cube must live under a bone.
- **Chains** (tail, tentacle, horn, braid, cable) come from `extrude_chain` rather than by hand:
  it nests one bone per segment, tapers the cross-section, and the rest pose is laid out
  straight with each bone carrying `curvature`, so segment *i* ends up at
  `base_rotation + i x curvature` and the whole chain sweeps into a curve. Name it `tail` and
  the rig tools pick it up as the tail chain. `create_bones:false` bakes the rotations into the
  cubes and the chain can no longer be animated — use it only for rigid decor.
- Cubes made by the generators take a `parent`, so build straight into the bone that should move
  them (`generate_array {parent:'body'}`, `add_hollow_volume {parent:'head'}`). Cubes left at the
  root cannot be animated; `check_rig` reports them as `cubes_without_bone`.

## Left and right (VERIFIED against Blockbench's vanilla data)

The model faces `-Z`, so **the model's own RIGHT is `+X`** and its LEFT is `-X`. (Bedrock
`rightArm`, stored at `x=-5`, is loaded by Blockbench at `x=+5`; Blockbench mirrors X on
import/export, which is why the exported json shows the opposite sign — that is correct.)
A front-view render is MIRRORED: the model's right hand appears on the image's left. Use
`get_orientation` / `which_side` / `check_sides`, and the label stamped on every screenshot —
never your own reading of a picture.

## Rotation sign (VERIFIED — don't guess)

A bone's **`+X` rotation tilts its FRONT (`-Z` side) UP** (and the back down). Consequences:
- A bone pointing **DOWN** (arm, leg) swings its tip **FORWARD** with `+X`; a bone pointing
  **UP** (torso, neck, head) tips **BACKWARD** with `+X`. So a head/snout pointing DOWN needs a
  NEGATIVE neck rotation, and an attack that reaches forward needs a POSITIVE shoulder rotation.
- **Elbows bend `+X`** (hand comes forward), **knees bend `-X`** (heel goes back).
- `+Y` turns the model toward its own LEFT; `+Z` tips a bone's top toward its LEFT.
- Legs swing on `X` to move along `Z` (the walking axis). Phase relationships matter more than
  the absolute sign for a looping cycle.
- Don't trust the pose by eye: `analyze_animation` reports the real travel direction of each
  hand and foot in the model's own axes.

## Keyframes

Use `add_keyframes` (bulk). Each: `{bone, channel:'rotation'|'position'|'scale', time, value:[x,y,z],
interpolation:'catmullrom'|'linear'|'step'|'bezier'}`. Use `catmullrom` for smooth motion,
`linear` for snappy beats (e.g. a jaw snap).

## Quadruped recipes (bone names: leg_front_left/right, leg_back_left/right + lowerleg_* + body + neck + tail)

**Walk (loop ~1.0s, diagonal gait).** Diagonal pairs in phase: FL+BR vs FR+BL (opposite).
Upper legs swing ±25° on X (FL/BR: +25 @0, -25 @0.5, +25 @1; FR/BL opposite). Lower legs add a
~22° knee bend offset by a quarter cycle (peak at 0.75 for phase A, 0.25 for phase B). Body Y
bobs twice (+0.5 @0.25 and 0.75). Slight neck nod, tail sway.

**Run (loop ~0.46s).** A FASTER version of the diagonal walk gait + body Y HOPS — not a "front
pair then back pair" bound (that reads as a march, users dislike it). Bigger swing (±40°),
deeper knee bend, body Y bounce (+1.8) twice per cycle, slight body pitch and neck bob.

**Attack (once/hold ~0.85s).** Windup then lunge: t0 neutral; ~0.15 wind back (body/neck back,
jaw starts open); ~0.4 strike (body pitch + position forward, neck thrusts, jaw wide ~46°, front
legs swipe/raise); ~0.55 contact (jaw snaps ~6°, hold); ~0.85 return to neutral. Use `linear`
on the jaw for a punchy snap.

**Sleep (loop ~4s).** Lying pose + slow breathing. Lower the body via `body` position (e.g.
[0,-4,0]); fold legs under (front legs ~ +85°, lower front ~ -75°; back legs ~ +80° with a
slight Z splay, lower back ~ +58°); bring the head DOWN to rest (NEGATIVE neck, e.g. -46°, head
~ -20°). Breathing = small body-Y / head oscillation between two/three keyframes. VERIFY the
head actually rests down (see rotation-sign note above) — a wrong sign leaves it craned up.

## Humanoid recipes (hips, spine, chest, neck, head, arm_upper/lower/hand_*, leg_*, tail)

- **Idle** (~4s): body-Y breathe + weight shift, chest counter-rotation, slow head drift,
  a constant slight elbow bend; hanging lanterns get a pendulum on X (±3-5°) offset from the body.
- **Walk** (~1s): arms and legs swing opposite on X (left arm with RIGHT leg), thigh ±26°,
  knee flexing to about -50° during the swing phase only, foot counter-rotating to stay flat,
  two body bobs per cycle, hips and chest counter-rotating on Y.
- **Attack (melee)** (~0.85s): anticipation ~25-30% in (shoulder BACK, i.e. negative X, torso
  twists away on Y), then the strike swings THROUGH to positive X with the torso turning back,
  a 2-3 frame contact hold, then a slower recovery. The off arm counterbalances and the legs
  take a step. Measure it: the striking hand must end up FORWARD.
- **Cast (channel)**: raise both arms forward/up (+X up to ~130°), tilt head up, hold; pulse any
  glow with a `scale` keyframe on the `*_core` bones.

Every one of these is available directly as `generate_animation {type:...}` — generate first,
then refine.

## Save/export reminders

- Before saving, reset to rest: `Modes.options.edit.select(); Timeline.setTime(0);`.
- Export geometry with `export_project`; texture PNG + animation JSON via execute_script
  (`Blockbench.writeFile`, `Animator.buildFile`) — see workflow-and-scripts.md snippet 10.
- If you delete & recreate an animated bone, its UUID changes and existing animators break;
  prefer `edit_element` to reposition bones so animations keep working.
