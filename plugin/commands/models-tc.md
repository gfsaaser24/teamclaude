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

   The report can carry five families (Gemini / Antigravity is the fifth), which
   is one more than a question allows. If more than four appear, list three and
   use the same `More families →` pager as stage two.

2. **Stage two — model, paginated.** Families are larger than four, so page
   through them instead of truncating:

   - If the family has **four or fewer** models, list them all. No paging.
   - Otherwise list **three** models, strongest/most useful first, and make the
     **fourth option the pager**: label it `More models →`, description
     `Show the next N of M in <family>`.
   - If the user picks the pager, ask the same question again with the next three
     in report order. Keep the pager as the fourth option while models remain.
   - On the final page, list the remaining models (up to four) and drop the
     pager. If they still have not chosen, offer `Back to the first page →`
     rather than dead-ending.

   Page in the report's order and never repeat a model across pages — the report
   is sorted, so track position by index, not by memory. Give each option a
   `description` noting what it suits (coding, reasoning, speed, images) and its
   trade-off where that matters.

   Some families also carry a dedicated reasoning variant — `kimi-k2-thinking`,
   `grok-4.20-0309-reasoning`. Surface those on the first page when the user
   wants depth; they stack with the effort level chosen in stage three.

   The harness always appends "Other", so say in the question text that any id
   from the report can be typed there directly — that is the fast path out of
   paging for a user who already knows the id they want.

3. **Stage three — reasoning effort.** Always ask this last, after the model is
   chosen. Options: **low**, **medium**, **high**, **max** (offer `xhigh` via
   Other; the harness caps a question at four options). Describe them in terms of
   the chosen model's job — low for scoped/latency-sensitive work, high as the
   sane default, max when correctness outweighs cost and latency.

If the user's request already names a family or a use case, skip stage one and
go straight to the matching models.

## The request shape effort must be sent in

**`output_config.effort` is ignored unless `thinking.type` is `"adaptive"`.**
Verified in CLIProxyAPI's `extractClaudeConfig`
(`internal/thinking/apply.go`): it reads `output_config.effort` only inside the
`adaptive`/`auto` branch. With no `thinking` field the value is silently
discarded and the provider default applies — which looks exactly like "effort
does nothing". Both fields are required, together:

```json
{
  "model": "<id>",
  "thinking": { "type": "adaptive" },
  "output_config": { "effort": "low" | "medium" | "high" | "xhigh" | "max" }
}
```

That one shape is correct for every routed model — it is native on Claude, and
CLIProxyAPI translates it per provider:

| Target | How the pair is consumed |
|---|---|
| **Claude** (fleet) | Native. `output_config.effort`, default `high`, all five levels on `claude-opus-5`. |
| **Codex / GPT** | `codex_claude_request.go` maps it to OpenAI's `reasoning.effort`. Measured 2.46× output and 3.5× thinking between `low` and `max` on `gpt-5.6-sol`. |
| **Kimi** | Routed through `ApplyThinking`, which clamps the level to what the model registry says the target supports. |
| **Grok / xAI** | Same path, then `sanitizeXAIResponsesBody` **deletes** `reasoning.effort` for any model with no thinking levels registered — so it is a deliberate no-op on `grok-4.20-0309-non-reasoning`. Use the `-reasoning` variant for effort to apply. |

Sending a bare top-level `effort` is wrong everywhere: Claude rejects it with
"Extra inputs are not permitted", and the backends accept and ignore it.

## After they choose

The session model and effort cannot be changed programmatically, so do not claim
to have switched anything. Give the user:

- `/model <id>` to switch model in this session, or `claude --model <id>` for a
  new one.
- For effort: `~/.claude/settings.json` carries `"effortLevel"`, which applies to
  new sessions. Offer to set it — do not edit that file unsolicited.
- If they are making raw API calls through the proxy, give them the JSON block
  above with their chosen values filled in.

Keep the final message short: chosen model, chosen effort, the command(s) to run.
No recap of the whole table.
