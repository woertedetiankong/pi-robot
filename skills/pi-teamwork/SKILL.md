---
name: pi-teamwork
description: Coordinate coding work across Pi sessions using Herdr and pi-intercom. Use when asked to create Pi collaborators, delegate independent implementation tasks, or consult another Pi reviewer. Covers launching workers, cross-session messages, integration, and completion. Keep explicitly solo tasks local.
---

# Pi teamwork

Use Herdr for worker lifecycle and pi-intercom for conversations. Apply this workflow when multi-session work is requested and useful; do small, tightly coupled changes directly. Loading this skill does not require using both tools on every task.

## Choose the participants

- Read the available `herdr` skill before managing panes, and `pi-intercom` before messaging. Use their actual discovered paths and installed tool schemas; do not install another orchestration plugin.
- Herdr control requires this Pi session to be inside a genuine Herdr pane (`HERDR_ENV=1`). On PowerShell, inspect `$env:HERDR_ENV`. Do not set that variable to impersonate a managed session. If unavailable, use an existing reachable Pi peer or explain the limitation and continue locally when that meets the request.
- For an existing reviewer, use `intercom` with `action: "list"` and select the live peer. Reuse that session instead of starting a replacement. Read-only review usually needs a concise question about the requirements, implementation, and missing tests.
- For new workers, identify independent deliverables first. Assign each worker its own source and test files, agree on shared interfaces, and retain integration work for the lead. State protected files and the task's actual acceptance criteria. Respect the user's worker count, provider/model, permissions, and directory choices.

## Start workers and resolve identities

Read `herdr agent` for the installed syntax. Create sibling panes with explicit cwd and `--no-focus`, taking each pane ID from the returned JSON. Start interactive Pi workers in the available shell panes:

```text
herdr agent start <unique-name> --kind pi --pane <returned-pane-id> -- --name <unique-name> <native-pi-options>
```

Pass provider/model/thinking options after `--` when specified for this task; preserve inherited Pi configuration. Do not use `--print` for a worker that must receive messages while busy. Successful Herdr startup confirms agent readiness, not intercom registration.

Call `intercom` with `action: "list"` and map the new Pi sessions to their Herdr names/pane IDs using session names and cwd. Use the returned session IDs for messages. Herdr's agent name alone is not proof of an intercom alias. If a peer is missing, inspect that specific worker with `herdr agent get/read` and retry discovery briefly; do not send blindly or create duplicate workers.

## Dispatch without serializing independent work

Send each independent task with `intercom` `action: "send"`, addressed to the resolved session ID. Include the task identifier, owned files, interface contract, protected files, requested checks, and the lead's reply address. Ask for a completion message containing changed files, actual test results, and any unresolved issue. Send all independent assignments before waiting for one to finish; work on your integration portion while they run.

If a worker cannot receive intercom messages, Herdr `agent prompt` is a fallback. Submit once without `--wait` when other assignments remain. Use one delivery channel per assignment; a timeout is not proof of non-delivery. Inspect activity before retrying.

On Windows, keep a task's text as a single argument. For large assignments, write a task file and send a short instruction to read its absolute path. Avoid launching Pi through a `Start-Process -ArgumentList` array containing an unquoted long prompt: PowerShell joins it into a command line, which can split one assignment into many positional prompts.

## Keep conversations responsive

- Use `send` for progress, completion, and questions that can wait while other work continues. Completion is a notification; do not use a blocking `ask` just to announce that work is done.
- Reserve `ask` for a concrete decision that truly blocks the sender. Answer inbound requests using `reply`; inspect `pending` if several requests need disambiguation.
- Do not block the lead in a long `ask` or terminal wait while workers may need its decisions. Use brief, bounded waits (for example, 10–20 seconds), return to model turns to handle incoming questions, and perform useful local work between checks.
- Track only this task's explicit workers. Never wait for every process named `pi`; that can include the lead and unrelated user sessions.
- Require a task-specific completion report and inspect the resulting files. An idle state before observed work is not evidence that the assignment ran. Treat `unknown`, `blocked`, and timeouts as states to investigate, not success. Read the affected worker's output before retrying, reassigning, or stopping it.

## Integrate and finish

As lead, reconcile interfaces and review each worker's actual diff. Run the integrated project's relevant tests; worker reports alone do not establish success. Preserve the user's original tests and other protected files, and add new test files when that is required.

Before reporting completion, ensure assigned work is accounted for and no worker is still editing. If taking over a worker's files, first confirm it has stopped editing them. Report failed or incomplete work honestly. Keep existing user sessions intact; only clean up panes/processes created for this task when appropriate, and never stop the shared Herdr server to end one assignment.

As a worker, stay within the assigned ownership, ask for interface decisions rather than editing another worker's files, and send a concise completion report to the lead. Do not independently publish the lead's final handoff or launch more workers unless asked.
