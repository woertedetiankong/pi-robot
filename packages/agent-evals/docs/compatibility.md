# Compatibility with the Claude Plugin Evals documentation

Source checked: 2026-09-12, [official behavior reference](https://code.claude.com/docs/en/plugin-evals). Independent implementation; no proprietary Claude implementation is copied.

Product scope: a reliable evaluation workflow installed in pi and Codex. Full Claude CLI/plugin ecosystem compatibility is not a release requirement. Add history, image judges or agent mocks only when actual evaluation cases need them.

| Feature | This package |
|---|---|
| Natural-language prompts and Markdown graders | Supported |
| Optional case.yaml and nested case groups | Supported; portable context fields documented in schema |
| Six grader types, weights, with-only diagnostics | Supported for text and native tool events |
| Three runs per arm; with/without delta | Supported; excludes diagnostic checks symmetrically |
| Model judge three-vote majority | Supported; invalid/error votes make grader fail |
| CLI-generated cases | Supported for skills, without an automatic pilot; pi authoring workflow also supports extension source inspection |
| Fixtures and scaffold scripts | Supported; fixture_dir is an extension, scaffold requires --scaffold |
| Fixed MCP mocks, input guards, case overrides | Supported on both backends; same mocks available to both arms |
| Model-powered mocks and recording/replay | Not implemented; rejected explicitly |
| Native conversation history and context.add_dirs | Not implemented; rejected explicitly |
| Image / binary-file judges | Not implemented; text targets only |
| Custom eval directory | eval.config.json or --eval-dir, not Claude plugin.json experimental fields |
| Claude plugin manifest / installed marketplace target | Not accepted; use a filesystem target with portable skills or a pi package |
| pi extensions / Claude hooks | pi extensions run in pi; Claude hooks are not translated |
| HTML report, JSON, traces, output files | Local only; no Claude Artifact publication |
| Cost ceiling | Pi when prices are reported; unknown prices stop a budgeted run. Codex dollars unavailable |
| Concurrency and filtering | Supported, up to 8 agent runs; judges run sequentially within each grader |
| Timeout and cancellation | Child process trees terminated; partial report saved |
| max_turns | pi only; explicit use is rejected on Codex |
| Tool grants | pi allowlist + built-in file guard; Codex native sandbox modes |
| Isolation | Separate configuration/session/workspace; not a sandbox around trusted plugin code |

The v0.1.1 protocol checks use pi 0.85.1 with a local deterministic provider. Native tool results carry mock calls and error state; failed input guards terminate the pi agent loop and force score zero. Skill copying prunes the resolved eval/report directories, including custom names. Init, validation and execution share project config and independent skill/extension selection.

## Deliberate scoring differences

Run errors force score zero and suppress delta, even if partial output passes graders. A judge error prevents a case passing even at a low threshold. This avoids presenting authentication, sandbox or rate-limit failures as plugin quality differences. Claude may grade partial output from an abnormal run.

`baseline` compares to a saved reference transcript, whereas the automatic without arm compares the target's contribution. These are different comparisons.

pi's `tool: Skill` shorthand matches reads of SKILL.md, with native `{path: ...}` inputs. Claude's `{skill: ...}` regexes need rewriting. For portable outcome comparisons, use final text or produced files. Codex command and patch event names are normalized to `shell` and `apply_patch`; its CLI does not emit every rejected tool attempt as a structured event. Sandbox startup rejection is treated as a run error when detected in stderr.

## Runtime sources

- [pi coding agent](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md): print/JSON mode, packages, extensions, resource discovery flags.
- [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive): exec JSONL, ephemeral sessions and sandbox selection.
- [Codex Windows sandbox](https://developers.openai.com/codex/windows): preserve the configured native sandbox, including elevated setup state.

The package does not upgrade either CLI or change their default model. Pin a compatible model explicitly for reproducible evaluations.
