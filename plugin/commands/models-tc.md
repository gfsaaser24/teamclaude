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
   chosen, because the valid levels depend on which model they picked:

   - For a **`claude-*`** model: `low`, `medium`, `high`, `max`.
   - For a **backend** model (Kimi, Codex, Grok): `none`, `low`, `high`, `max` —
     `none` is worth surfacing there, it disables reasoning entirely and is the
     fastest option.

   Never offer `none` or `minimal` for a Claude model; Anthropic returns a 400.
   `xhigh` sits between `high` and `max` on every system and can be typed into
   Other — a question caps at four options, so it does not get a slot.

   Describe the levels in terms of the chosen model's job: low for scoped or
   latency-sensitive work, high as the sane default, max when correctness
   outweighs cost and latency. Effort is not free — on `gpt-5.6-sol` `max` cost
   2.4× the latency of `low`, and on `kimi-k3` roughly 2×.

If the user's request already names a family or a use case, skip stage one and
go straight to the matching models.

## The request shape effort must be sent in

One shape is correct for every routed model. Send **both** fields together:

```json
{
  "model": "<id>",
  "thinking": { "type": "adaptive" },
  "output_config": { "effort": "low" | "medium" | "high" | "xhigh" | "max" }
}
```

`thinking` is not optional decoration — **`output_config.effort` is ignored
without it.** CLIProxyAPI's `extractClaudeConfig` (`internal/thinking/apply.go`)
reads effort only inside the `thinking.type == "adaptive"|"auto"` branch; with no
`thinking` field the value is silently dropped and the provider default applies,
which is indistinguishable from effort having no effect.

### What each system receives, and the evidence it lands

| Target | Translation | Verified end-to-end |
|---|---|---|
| **Claude** (fleet) | None — goes direct to Anthropic, bypassing CPA. Native field, default `high`. | Rejects out-of-range levels with a 400, so the field is unambiguously read. |
| **Codex / GPT** | `codex_claude_request.go` → `reasoning.effort` + `reasoning.summary:"auto"`. | `gpt-5.6-sol`, `low`→`max`: 2.46× output, 3.5× thinking. |
| **Kimi** | `provider/kimi` → `thinking:{type:"enabled",effort:L}`, legacy top-level `reasoning_effort` deleted. | `kimi-k3` monotonic: `none` 0 → `low` 78 → `max` 2,716 thinking chars. Also `kimi-k2-thinking` 0→10,407 and `kimi-k2.7-code` 0→7,300. |

**Grok / xAI** is not measured — the three above are. It takes the same
`reasoning.effort` path as Codex, except `sanitizeXAIResponsesBody` **deletes**
the field for any model with no thinking levels in the registry. So effort is a
deliberate no-op on `grok-4.20-0309-non-reasoning`; steer to the `-reasoning`
variant if the user wants depth from Grok.

### Level vocabulary is NOT uniform — this is the one real trap

- **`low` `medium` `high` `xhigh` `max`** — safe everywhere. Use these by default.
- **`none`** — backends only. Disables reasoning outright (measurably 0 thinking
  chars, and the fastest option). **Anthropic rejects it with a 400**, so never
  offer it for a `claude-*` model.
- **`minimal`** — exists inside CPA (`ParseLevelSuffix`) but Anthropic also 400s
  it. Do not offer it.

Anthropic's exact error, worth recognizing:
`output_config.effort: Input should be 'low', 'medium', 'high', 'xhigh' or 'max'`

### Two shapes that look plausible and are wrong

- **Bare top-level `effort`.** Claude answers "Extra inputs are not permitted";
  the backends accept and ignore it.
- **A level baked into the model id** — `kimi-k3(max)`. CPA does support this
  (`ParseSuffix`/`ParseLevelSuffix`, and a suffix *outranks* the body), but
  TeamClaude matches routes on the literal model id and returns
  `not_found_error: model: kimi-k3(max)`. Never emit a suffixed id here.

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
