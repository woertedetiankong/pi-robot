# Evaluation schema

The target root contains `evals/<case>/prompt.md` and `graders/*.md`. Optional `eval.config.json` selects `skills` and `extensions` as arrays of relative paths, `backend`, `model`, `provider`, `judge_backend`, `judge_model`, `judge_provider`, and `eval_dir`. Without it, `skills/`, a root SKILL.md, or package.json `pi.skills`/`pi.extensions` are discovered. This independent implementation is not a Claude CLI plugin.

Init, validate and run share this config; explicit CLI options override it. An empty skills or extensions array disables only that resource type. The resolved eval directory and report output directory are excluded from copied skill resources, including custom names.

```markdown
---
tags: [smoke]
timeout_seconds: 120
---

Write a commit message for renaming getUser to fetchUser.
```

Case fields: `schema_version: "1.1"`, `name`, `description`, `tags`, `runs` (3), `expected_outcome` (documentation only), `model`, `provider`, `max_turns` (10, pi only), `timeout_seconds` (300), `allowed_tools` (pi defaults read/grep/find/ls), `append_system_prompt` (portable task-instruction preamble, not an actual system-role injection), `env` (string EVAL_* values).

Optional case.yaml requires `schema_version: "1.1"` and `name`. Case metadata belongs at the top level; execution fields and `prompt` under `execution`. prompt.md overrides matching fields. Inline `graders` are combined with grader files. `context.fixture_dir` copies files from a case-relative directory into the empty workspace; `context.scaffold_script` runs a Bash setup script only with `--scaffold`. Native conversation history and context.add_dirs are unsupported and fail validation.

Each grader is Markdown with frontmatter:

```markdown
---
type: llm
weight: 2
---

PASS if the message accurately describes a rename without claiming a behavior change.
FAIL if it invents functionality or omits the rename.
```

| Type | Fields / body |
|---|---|
| regex | Body is pattern (or `pattern` in metadata); `flags`; `match`: contains, not_contains, count:N; `target` |
| tool_used | `tool`, optional `input_match` regex on input JSON; `min` (1), `max` (unlimited) |
| tool_order | `before` and `after`, each a tool name or `{tool, input_match}`; checks first matching calls |
| file_exists | `path` glob and `exists` (true); only newly created files count |
| llm | Body is concrete PASS/FAIL rubric; optional `focus`; 2/3 votes required, any judge error fails |
| baseline | `baseline_file` case-relative reference transcript, body is comparison rubric; three judge votes |

Common fields: `weight` (1), `arm: with-only|both`. All-with-only suites fall back to scoring all graders, matching the documented Claude behavior; use at least one outcome grader for a meaningful delta.

Targets/focus: `last_message` (default), `trace` (normalized source events as JSONL), `files` (new file paths), `mock_calls` (inputs and results from fixed MCP mocks), or `{source: file, path: relative/path}`. File contents must be text; binary/image judging is not implemented. Model targets above 32000 characters fail instead of being silently truncated. Regex sees the full text up to the 2 MiB file input limit.

Fixed mocks: `evals/mocks/<server>/<tool>.md`, overridden file by file under each case's `mocks/`. Frontmatter accepts `type: fixed`, `description`, `error`, and `expect` (dotted input keys mapped to types, literals, lists or `/regex/flags`). Body supports `{{input.field}}` and `{{file:fixtures/file}}`; fixture contents preserve literal dollar sequences. Optional `_tools.json` carries the MCP tools/list response and is inherited when the case overrides only a tool answer. Fixture files follow the same overlay rules. Tool name is `mcp__<server>__<tool>` on both backends. Both arms get the same mocks. `error: true` produces a tool error and permits recovery. A failed expectation forces the run to fail; pi terminates before another model call, Codex is marked failed after execution. pi mock_calls come from native tool result details. Agent mocks and replay are unsupported.

For pi skill-read diagnostics:

```markdown
---
type: tool_used
tool: read
input_match: 'SKILL\.md'
arm: with-only
---
```

`tool: Skill` is a pi compatibility shorthand for a read of SKILL.md and is automatically diagnostic in two-arm runs. Its input_match still matches pi's native `{path: ...}` input, not Claude's `{skill: ...}` input. Codex rejects this shorthand. Codex tool names are `shell`, `apply_patch`, `mcp__<server>__<tool>`, and `web_search` where emitted.

Exit codes: 0 complete and passed; 1 failed/invalid/error; 2 partial due to cost ceiling; 130 cancelled. Run failures force score zero; any run or grader error suppresses delta and prevents a case passing, even if the threshold is zero. A dollar ceiling is checked before new agent/judge calls; concurrent calls already running may exceed it. Codex costs are unknown and dollar ceilings are rejected.
