---
name: agent-evals
description: Create, run, and interpret behavioral evaluations of skills and agent extensions using pi or Codex, including with/without comparisons and regression checks. Use when the user asks to test skill triggering, measure agent behavior, or evaluate a plugin.
---

Use the bundled CLI with `node <this-skill-directory>/scripts/agent-evals.mjs`.
Read [the schema reference](references/schema.md) when authoring or modifying cases.

Read the target's eval.config.json before authoring. Init, validate and run share its selected skills/extensions, backend/model and eval_dir; explicit command options override config. Focus on a reliable pi/Codex evaluation workflow. Claude-only plugin manifests and publication services are outside the package's scope.

For new suites, inspect the target skills and extensions and identify realistic requests and concrete success criteria. Ask a focused question only if the user's intended outcome remains ambiguous. Include positive requests and unrelated requests that should not activate the skill. `init <target> --bare <case>` creates a template without model calls. In pi, `/eval init <target>` starts this authoring workflow in the current conversation. The CLI's `init <target> --expect "..."` generates draft cases in a separate model call.

Validate before running. Start a pilot with `run <target> --runs 1 --ablation none`, inspect each grader's evidence, then use the default three runs and both arms to confirm improvements. Each model judge performs three votes, so judge-based suites make additional model calls.

Use an outcome grader for quality. Mark invocation-only diagnostics `arm: with-only`; otherwise the no-skill arm is unfairly penalized. Use actual backend tool names and inputs. pi reads SKILL.md with `read`; Codex emits `shell` and `apply_patch` events. Never infer that reading a skill proves the output followed it.

Run `run <target> --backend pi` or `--backend codex`. The latter evaluates skills, not pi extension code. Omit explicit `allowed_tools` and `max_turns` for shared cases: Codex uses `--sandbox read-only|workspace-write` and wall-clock timeouts. All reports stay local. Real model usage is charged to the selected backend's configured account.

Report WITH, WITHOUT, delta, run errors, judge errors and the report path. Null delta means results are not comparable, not zero improvement. Do not treat an incomplete run, rate-limit failure, or absent cost estimate as a successful or free evaluation. Never silently substitute mock execution for a requested real evaluation.
