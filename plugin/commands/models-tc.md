---
description: List every model TeamClaude routes (fleet + CLIProxyAPI backends)
allowed-tools: Bash(node:*)
---

!`node "$TEAMCLAUDE_HOME/plugin/scripts/models-tc.mjs" 2>&1 || node "$HOME/code/teamclaude/plugin/scripts/models-tc.mjs" 2>&1`

The report above lists every model id the local TeamClaude proxy will route,
grouped by provider family, with the route that governs each one.

Claude Code's own `/model` picker cannot show these: it offers a fixed list plus
at most five env-configurable slots, while the fleet routes far more. Every id
above still works by exact name — this is a discovery aid, not a limitation.

If the user asked for a recommendation, pick from the list based on the task
(coding, reasoning, speed, images) and give them the exact command to run.
Do not invent model ids that are not in the report.
