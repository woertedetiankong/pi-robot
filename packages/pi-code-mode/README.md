# pi-code-mode

A code-mode plugin for the [pi](https://pi.dev) coding agent: the model writes sandboxed
Python that calls pi's tools as plain functions — loops, filtering, and aggregation happen
inside the sandbox, and intermediate data never enters model context. Only what the code
`print()`s comes back.

Built on [@pydantic/monty](https://github.com/pydantic/monty) **0.0.23** — the
worker-pool architecture, not the deprecated in-process API — which is what enables the
features below.

## Why this design

LLMs compose code better than they compose chained JSON tool calls (see Cloudflare's
[Code Mode](https://blog.cloudflare.com/code-mode/) and Anthropic's
[programmatic tool calling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling)).
The prior art for pi is [pi-code-tool](https://github.com/josephkern/pi-code-tool), whose
UX this project deliberately preserves; pi-code-mode is a new implementation on monty's
current crash-isolated engine, which changes what's possible:

| | pi-code-tool (monty 0.0.18) | **pi-code-mode (monty 0.0.23)** |
|---|---|---|
| Sandbox execution | in the pi process | crash-isolated worker subprocesses |
| Sandbox crash / memory abort | takes down pi | kills a worker; pi unaffected |
| Runaway pure-Python code | in-sandbox limit only | hard wall-clock watchdog kills the worker |
| State across calls | transcript replay + call cache | real interpreter state (never re-executes) |
| State across restarts/branches | replay the whole transcript | load a serialized heap dump (bytes) |
| Suspended approval calls | replay up to the gated call | exact serialized interpreter snapshot |
| Abort (Esc) | at pause points | KeyboardInterrupt at call boundaries + worker kill fallback |

## What the agent gets

One `code` tool (configurable name) that is a persistent sandboxed Python REPL:

- **pi's own tools bridged in**: `read`, `grep`, `find`, `ls` dispatch directly as Python
  functions; the model composes them in one snippet instead of one model round-trip per call.
- **Approval-gated mutations**: `bash`, `edit`, `write` freeze the script mid-execution and
  show you the exact call. Deny raises a catchable `PermissionError`; **"Decide later"**
  checkpoints the paused interpreter to bytes — resumable days later, even after a pi
  restart, and completed work never repeats.
- **Pre-execution type checking**: code is checked by monty's bundled
  [`ty`](https://docs.astral.sh/ty/) against typed stubs of every bridged tool before any
  side effect runs. Wrong argument types come back as compiler diagnostics, not tracebacks.
- **Workspace mounted read-only at `/workspace`** for plain `open()`/`pathlib` reads
  (symlink-escape and `..`-traversal safe), plus `http_get` (host-side fetch) and
  `read_file`/`list_files` fallbacks.
- **A growing toolbox**: `save_tool(name, code, description)` persists reusable functions
  as plain `.py` files in `.pi/code-tools/` (validated in a fresh session first, so they
  can't silently depend on session-local state); they auto-load into future sessions.
- **State that follows the conversation**: session state rides in tool-result `details`,
  so it survives pi restarts, session restores, and branching.
- Capability probing at startup keeps the prompt truthful: the import allowlist and
  type-checker workarounds are measured against the installed monty, not hardcoded.

There is also a `/code-reset` command for the human.

## Upgrading from Monty 0.0.19-beta.4

This version pins Monty to `0.0.23`. Install the updated lockfile with `npm ci`
using Node.js >= 22.19. Old interpreter checkpoints, including paused scripts,
are not restored across this upgrade: the extension reports the incompatibility
and starts fresh. Finish pending scripts before upgrading if you need to keep
their interpreter state. Saved `.py` tools remain on disk and are loaded into
fresh sessions; completed host actions are never replayed automatically.

Each `run` or `resume` gets a fresh checkout with a default budget of 1000
suspensions (host tool calls, name lookups and OS calls). Interpreter state moves
between checkouts through heap snapshots. A loop that exhausts the budget stops;
the next invocation gets a new budget without replaying completed work. Configure
`limits.maxSuspensions` for larger batches. `maxAllocations` was removed upstream
and is rejected; use `maxMemory` for memory limits.

Read-only mount handles are released after execution, including errors and
suspensions. Interpreter rollback never undoes file writes or other host actions.

## Install

See [DEPLOYMENT.md](DEPLOYMENT.md) for the full path from checkout to published package.
The short version, from a checkout:

```bash
npm install
npm test && npm run smoke      # verify on your machine (no pi or API key needed)
pi -e /path/to/pi-code-mode/src/pi/extension.ts     # try it in pi
```

## Configuration

The default export works out of the box. For custom host tools or different behavior,
re-export from your own extension file (e.g. `.pi/extensions/code.ts`):

```ts
import { createCodeModeExtension } from "pi-code-mode/pi";

export default createCodeModeExtension({
	toolName: "code",            // the tool name the model sees
	root: process.cwd(),         // workspace root for mounts, file tools, and the store
	mountWorkspace: true,        // false: no /workspace mount; read_file tool instead
	bridgePiTools: true,         // false: don't expose pi's read/grep/find/ls/bash/edit/write
	noBuiltins: false,           // true: skip read_file/list_files/http_get starter tools
	toolStore: ".pi/code-tools", // false: disable save_tool/delete_tool/list/read helpers
	typeCheck: true,             // false: skip the pre-execution type-check gate
	autoApprove: false,          // true: run bash/edit/write without asking (headless)
	requestTimeout: 30,          // watchdog seconds per interpreter turn
	limits: { maxMemory: 256 * 1024 * 1024, maxSuspensions: 1000 },
	tools: [
		{
			name: "query_db",
			description: "Run a read-only SQL query.",
			params: [{ name: "sql", type: "str" }],
			returns: "list[dict]",
			execute: async ([sql]) => db.query(String(sql)),
		},
	],
});
```

## Use as a library (no pi)

The core is harness-agnostic — any agent loop can drive it:

```ts
import { Monty } from "@pydantic/monty";
import { CodeSession, ToolRegistry, createBuiltinTools } from "pi-code-mode";

const pool = await Monty.create({ requestTimeout: 30 });
const session = new CodeSession({ pool, tools: new ToolRegistry(createBuiltinTools({ root: process.cwd() })) });

const result = await session.run("len(list_files('.'))");
if (result.status === "ok") console.log(result.output);

// Serialize/restore across processes:
const state = session.dumpState();          // JSON-able
// later: new CodeSession({...}).restoreState(state)
```

`RunResult` is a discriminated union (`ok | error | suspended`) with `stdout`, per-call
traces, and typed error kinds (`syntax | runtime | typing | aborted | crashed`).

## Architecture

```
src/core/  types.ts         HostTool contract, RunResult union, limits
           values.ts        sandbox ⇄ host value conversion, Python-ish repr
           registry.ts      tool registry + prompt stubs + type stubs + prompt rules
           capabilities.ts  startup probing: importable modules, ty gaps, stub validation
           runner.ts        the feedStart snapshot drive loop (dispatch, gating, abort)
           session.ts       CodeSession: REPL lifecycle, dump/restore, suspensions
           store.ts         saved tools as plain .py files + manage-from-sandbox
           builtins.ts      read_file / list_files / http_get
src/pi/    bridge.ts        pi built-in tools → typed Python stubs
           extension.ts     the pi adapter: tool registration, approval UI, branch-safe state
```

Key invariant: state is the interpreter's own serialized heap, never a transcript —
completed side effects can never re-execute, by construction.

## Credits

The tool bridging, approval-gating UX, saved-tool store, and prompt design follow
[pi-code-tool](https://github.com/josephkern/pi-code-tool) by Joseph Kern (MIT), which
pioneered code mode for pi on monty 0.0.18. This project reimplements that feature set on
monty 0.0.19's worker-pool architecture.

## License

MIT
