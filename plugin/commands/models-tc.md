---
description: Pick a model from everything TeamClaude routes (fleet + CLIProxyAPI backends)
allowed-tools: Bash(node:*), AskUserQuestion, Read, Edit
---

!`node "$TEAMCLAUDE_HOME/plugin/scripts/models-tc.mjs" 2>&1 || node "$HOME/code/teamclaude/plugin/scripts/models-tc.mjs" 2>&1`

The block above is the LIVE routing table from the local TeamClaude proxy. Use
only ids that appear in it — never invent or recall a model id from memory.

If the report says the proxy is unreachable, tell the user that and stop.

## Present a picker

Drive an interactive selection with **AskUserQuestion**. It allows at most four
options per question, and the full fleet is larger than that, so use two stages:

1. **Stage one — family.** One question whose options are the provider families
   that actually appear in the report (typically Claude fleet, Codex / ChatGPT,
   Grok / xAI, Kimi). In each option's `description`, say how many models the
   family has and what it is good for.

2. **Stage two — model.** One question listing up to four models from the chosen
   family, ordered strongest/most useful first. Give each a `description` noting
   what it suits (coding, reasoning, speed, images) and, where it matters, its
   trade-off. The harness always adds an "Other" choice, so mention in the
   question text that any other id from the report can be typed there.

If the user's request already names a family or a use case, skip stage one and
go straight to the matching models.

## After they choose

The session model cannot be changed programmatically, so do not claim to have
switched it. Instead:

- Give the exact command to use it now: `/model <id>`
- Note that `claude --model <id>` starts a new session on it.
- Offer — do not do it unsolicited — to make it the default for future sessions
  by setting `"model"` in `~/.claude/settings.json`. Only edit that file if the
  user agrees, and tell them it affects new sessions, not the current one.

Keep the final message short: the chosen id, the one command to run, and the
offer. No recap of the whole table.
