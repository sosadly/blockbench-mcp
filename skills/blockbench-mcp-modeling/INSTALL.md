# Installing the `blockbench-mcp-modeling` skill

This skill teaches Claude the proven workflow + scripts for building good models through the
BlockbenchMCP server. It does NOT replace the MCP — you still need the MCP connected (Blockbench
open with `Tools ▸ Start MCP Server`, and the `blockbench` MCP server configured in your client).

## Claude Desktop
1. Settings ▸ **Capabilities** ▸ **Skills** (enable Skills if prompted).
2. **Add / Upload skill** and pick `blockbench-mcp-modeling.zip` (next to this folder), or point
   it at the `blockbench-mcp-modeling/` folder.
3. Make sure the **blockbench MCP** is also added (Settings ▸ Connectors / MCP) and Blockbench's
   server is running.
4. New chat: ask e.g. *"Build a detailed grizzly bear in Blockbench"* — the skill auto-loads
   when the request matches its description.

> Skill folders must contain `SKILL.md` at the top level (this one does). If Desktop wants a zip,
> use the provided `.zip`; if it wants a folder, point it at `blockbench-mcp-modeling/`.

## Claude Code (already installed here)
Copied to `~/.claude/skills/blockbench-mcp-modeling/`, so it's available in Claude Code
automatically. Per-project alternative: put it under `<project>/.claude/skills/`.

## Updating
Edit the files in `d:/projects/blockbench-mcp/skills/blockbench-mcp-modeling/`, then re-copy to
`~/.claude/skills/` (Code) and/or re-zip and re-upload (Desktop). Re-zip with PowerShell:
`Compress-Archive -Path .\blockbench-mcp-modeling -DestinationPath .\blockbench-mcp-modeling.zip -Force`

## What's inside
- `SKILL.md` — the cube budget, the 4-layer doctrine, the banned shapes, the procedural
  generators, the pipeline, hard rules, tool cheat-sheet and gotchas.
- `references/workflow-and-scripts.md` — paste-ready execute_script snippets (matrix voxelizer,
  array generator, hollow shell, UV packer, smooth texture bake, feature painting, density
  audit, pose preview, exports).
- `references/proportions-and-review.md` — animal/humanoid proportions, the density gate and the
  per-pass review checklist (flat surfaces, z-fighting, layering).
- `references/rigging-and-animation.md` — rigs, bone chains, rotation-sign facts,
  idle/walk/run/attack/sleep recipes.
