/**
 * pi extension: a `code` code-mode tool backed by monty's crash-isolated
 * sandboxed Python workers (@pydantic/monty 0.0.23). Host tools appear to
 * the model as plain Python functions; print() output streams back;
 * variables persist across calls as real interpreter state (no replay), and
 * that state rides in tool-result `details` so it survives pi restarts,
 * session restores, and branching. Gated calls (bash/edit/write) freeze the
 * script for per-call approval and can be suspended to an exact serialized
 * checkpoint, resumable any time.
 *
 * Use directly with `pi -e src/pi/extension.ts`, or install the package.
 */
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { statSync } from "node:fs";
import { join } from "node:path";
import { Monty } from "@pydantic/monty";
import { MountDir } from "@pydantic/monty/node";
import { Type } from "typebox";
import { createBuiltinTools } from "../core/builtins.ts";
import { buildTypeCheckStubs, probeImportableModules } from "../core/capabilities.ts";
import { renderPythonToolRules, ToolRegistry } from "../core/registry.ts";
import { CodeSession, type SerializedState } from "../core/session.ts";
import { ToolStore } from "../core/store.ts";
import type { ApprovalRequest, HostTool, RunResult, SessionLimits } from "../core/types.ts";
import { formatCall, pyRepr } from "../core/values.ts";
import { createPiBridgeTools } from "./bridge.ts";

const DEFAULT_TOOL_NAME = "code";
/** Virtual path the read-only workspace mount is exposed at inside the sandbox. */
const VIRTUAL_WORKSPACE_PATH = "/workspace";
/** Hard wall-clock deadline per interpreter turn; the watchdog kills past it. */
const DEFAULT_REQUEST_TIMEOUT_SECS = 30;
/** Ceiling on serialized state persisted in tool-result details. */
const MAX_STATE_JSON_BYTES = 2 * 1024 * 1024;

/**
 * Labels of the gated-call approval dialog. pi's `ctx.ui.select` returns the
 * chosen label string, so these are load-bearing for routing the decision —
 * tests and RPC drivers should import them rather than re-typing the text.
 */
export const APPROVAL_CHOICES = {
	approve: "Approve",
	deny: "Deny",
	suspend: "Decide later (suspends the script, resumable any time)",
} as const;

export interface CodeModeExtensionOptions {
	/**
	 * Name the tool is registered under. Default 'code' — neutral across
	 * model families; a name like 'python' invites full-CPython assumptions
	 * monty can't meet.
	 */
	toolName?: string;
	/** Extra host tools beyond the built-ins. */
	tools?: HostTool[];
	/** Workspace root for mounts, file tools, and the default store. Default: process.cwd(). */
	root?: string;
	/** Disable the built-in tools (list_files, http_get, and read_file when the mount is off). */
	noBuiltins?: boolean;
	/**
	 * Mount the workspace read-only at /workspace so code reads files with
	 * plain open()/pathlib. When disabled, a read_file host tool is provided
	 * instead. Default true.
	 */
	mountWorkspace?: boolean;
	/** Pre-execution static type checking with tool stubs. Default true. */
	typeCheck?: boolean;
	/**
	 * Bridge pi's built-in tools into the sandbox as Python functions:
	 * read/grep/find/ls dispatch directly; bash/edit/write pause for
	 * per-call user approval. Default true.
	 */
	bridgePiTools?: boolean;
	/**
	 * Approve gated (bash/edit/write) calls without asking. Headless escape
	 * hatch — without it, gated calls are denied when no UI is available.
	 * Default false.
	 */
	autoApprove?: boolean;
	/** Directory for agent-saved tools, or false to disable saving. Default: <root>/.pi/code-tools. */
	toolStore?: string | false;
	/** Interpreter limits (memory, recursion, suspensions per run/resume). */
	limits?: SessionLimits;
	/** Watchdog deadline in seconds for a single interpreter turn. Default 30. */
	requestTimeout?: number;
}

interface CodeToolDetails {
	status: RunResult["status"];
	/** JSON-serialized SerializedState for branch-safe restore ('' when none). */
	state: string;
	/** Names of host tools called by this snippet. */
	calls: string[];
}

const CodeParams = Type.Object({
	code: Type.Optional(
		Type.String({
			description:
				"Python code to run. Required unless resume=true. The value of the last top-level expression is returned.",
		}),
	),
	reset: Type.Optional(
		Type.Boolean({ description: "Discard all session state and reload saved tools before running." }),
	),
	resume: Type.Optional(
		Type.Boolean({
			description:
				"Resume the snippet that was suspended awaiting approval. Work done before " +
				"the suspension is not repeated; code is ignored and may be omitted.",
		}),
	),
	abandon: Type.Optional(
		Type.Boolean({ description: "Discard a suspended snippet without resetting the rest of the session." }),
	),
});

export function createCodeModeExtension(options: CodeModeExtensionOptions = {}) {
	return async (pi: ExtensionAPI) => {
		const toolName = options.toolName ?? DEFAULT_TOOL_NAME;
		const root = options.root ?? process.cwd();
		const pool = await Monty.create({ requestTimeout: options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT_SECS });

		// One MountDir per feed: monty mounts cannot be shared across live runs.
		let makeMount: (() => MountDir) | undefined;
		if (options.mountWorkspace ?? true) {
			try {
				if (!statSync(root).isDirectory()) throw new Error("not a directory");
				makeMount = () => new MountDir({ virtualPath: VIRTUAL_WORKSPACE_PATH, hostPath: root, mode: "read-only" });
			} catch {
				// Root missing/unreadable: degrade to the read_file tool rather
				// than failing the whole extension load.
				makeMount = undefined;
			}
		}

		const bridge = options.bridgePiTools ?? true;
		// With the mount active, sandbox reads see "/workspace/<path>"; host
		// helpers accept the same spelling and strip it back to a relative path.
		const virtualRoot = makeMount ? VIRTUAL_WORKSPACE_PATH : undefined;
		const registry = new ToolRegistry(options.tools);
		if (bridge) {
			for (const tool of createPiBridgeTools(root, { virtualRoot })) registry.add(tool);
		}
		if (!options.noBuiltins) {
			// The mount replaces read_file with plain open(); bridged ls replaces list_files.
			for (const tool of createBuiltinTools({ root, readFile: !makeMount, listFiles: !bridge, virtualRoot })) {
				registry.add(tool);
			}
		}

		const store =
			options.toolStore === false ? null : new ToolStore(options.toolStore ?? join(root, ".pi", "code-tools"));
		const sessionConfig = () => ({
			pool,
			tools: registry,
			limits: options.limits,
			typeCheck: options.typeCheck ?? true,
			typeCheckStubs,
			makeMount,
			prelude: store ? () => store.prelude() : undefined,
		});
		if (store) {
			// Saved code must work in a future session, not just this one: run
			// it in an isolated throwaway session (other saved tools loaded,
			// current session's imports/variables absent) before accepting it.
			const validate = async (code: string): Promise<string | null> => {
				const probe = new CodeSession(sessionConfig());
				try {
					const result = await probe.run(code);
					return result.status === "ok" ? null : ((result.error ?? "unknown error").split("\n")[0] ?? null);
				} finally {
					await probe.close();
				}
			};
			for (const tool of store.hostTools((name) => registry.has(name), validate)) {
				registry.add(tool);
			}
		}

		const importable = await probeImportableModules(pool);
		const typeCheckStubs = (options.typeCheck ?? true) ? await buildTypeCheckStubs(pool, registry) : undefined;
		const savedSummary = store ? await store.renderSummary() : "";
		const gatedNames = registry
			.list()
			.filter((t) => t.requiresApproval)
			.map((t) => t.name);

		const session = new CodeSession(sessionConfig());
		// Set when state came from a previous conversation and hasn't run yet.
		let restoredUnverified = false;
		let restoreNote = "";

		// Rebuild session state from the last code tool result on the current
		// branch — `details` travels with the session file, so this survives
		// pi restarts, restores, and branching.
		pi.on("session_start", (_event, ctx) => {
			// The LAST code-tool entry is authoritative even when its state is
			// the empty string (a reset, or state too large to persist) —
			// falling back to an earlier non-empty state would resurrect
			// exactly what the reset discarded.
			let state: string | undefined;
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type === "message") {
					const message = entry.message as { toolName?: string; details?: CodeToolDetails };
					if (message.toolName === toolName && typeof message.details?.state === "string") {
						state = message.details.state;
					}
				}
			}
			restoredUnverified = false;
			restoreNote = "";
			if (!state) return;
			try {
				session.restoreState(JSON.parse(state) as SerializedState);
				restoredUnverified = true;
			} catch (err) {
				// Unreadable state (e.g. written by an incompatible version):
				// start fresh rather than failing every session start.
				restoreNote = `[note: saved interpreter state was not restored: ${String(err)}]\n`;
			}
		});

		pi.on("session_shutdown", async () => {
			await session.close();
			await pool.close();
		});

		pi.registerTool({
			name: toolName,
			label: "Code",
			description: [
				"Run Python in a sandboxed interpreter with host tools available as plain",
				"functions. Variables and functions persist across calls in this session.",
				"Prefer this tool when you need to chain tool calls, loop, filter large",
				"results, or compute — do the work in code and print only what you need.",
				"If a single direct tool call (bash one-liner, grep -n, read) already",
				"yields the exact answer, prefer it — this tool pays off for loops,",
				"multi-step aggregation, and keeping large data out of context.",
				"",
				"Python-only helper functions available INSIDE this tool:",
				`- These names are NOT standalone pi tools; they only exist in Python code passed to ${toolName}.`,
				`- Example: call ${toolName} with code like \`print(ls("."))\`; do not try to invoke \`ls\` as a separate pi tool.`,
				"",
				registry.renderStubs(),
				...(savedSummary
					? [
							"",
							"Saved functions (auto-loaded into new sessions — call them from your",
							`code like any function, e.g. via ${toolName} with "result = name(...)"):`,
							savedSummary,
						]
					: []),
				"",
				"Rules:",
				renderPythonToolRules(importable),
				...(gatedNames.length > 0
					? [
							`- Calls to ${gatedNames.join("/")} pause the script for per-call user approval; a denial raises PermissionError (catch it or stop gracefully), and the user may suspend the script instead — resume later with {"resume": true}, or discard it with {"abandon": true}. Group related work so the user approves meaningful units.`,
						]
					: []),
				...(makeMount
					? [
							`- The workspace is mounted READ-ONLY at /workspace: read files with open("/workspace/<path>") or pathlib, and parse JSON with json.loads(text). In-sandbox open(..., "w") writes raise PermissionError. Host helpers inside code (write/edit/ls) take paths RELATIVE to the workspace root — e.g. write("out/users.csv", ...); a leading "/workspace/" prefix on path arguments is accepted and stripped (bash command strings are not rewritten). Only claim a file was written after the write()/edit() helper returns success.`,
						]
					: []),
			].join("\n"),
			promptSnippet: `${toolName}: run sandboxed Python; host tools are callable as functions; state persists`,
			promptGuidelines: [
				`Use ${toolName} for multi-step tool workflows: loop/filter/aggregate in code and print only the result, instead of issuing many separate tool calls.`,
				`Prefer a single direct tool call (a bash one-liner or grep -n) when it already yields the exact answer by itself; use ${toolName} when a task needs loops, multi-step aggregation, or must keep large data out of context.`,
				...(bridge
					? [
							`Route file changes by how the content is produced. DERIVED content — computed from data (manifests, indexes, conversions, extractions), the same mechanical transform across many files, or writes that must pass programmatic checks first — belongs inside ${toolName} via write()/edit(): code computes it exactly, verifies before writing, and each mutation is shown for approval. AUTHORED content — new code or prose you are composing, or a single judgment-driven edit — belongs in the regular edit/write tools.`,
						]
					: []),
				`Names listed in the ${toolName} tool description are Python helper functions only, not top-level pi tools; call ${toolName} and invoke them from Python code there.`,
				...(store
					? [
							`To create a reusable saved tool, call save_tool(name, code, description) inside ${toolName} — it validates the code. Do not write files into .pi/code-tools directly.`,
						]
					: []),
			],
			parameters: CodeParams,
			executionMode: "sequential",
			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				const detailsFor = (status: RunResult["status"], calls: string[] = []): CodeToolDetails => {
					const state = session.dumpState();
					const json = state ? JSON.stringify(state) : "";
					return { status, state: json.length <= MAX_STATE_JSON_BYTES ? json : "", calls };
				};

				if (params.resume && params.abandon) {
					return {
						content: [{ type: "text", text: "(choose either resume=true or abandon=true, not both)" }],
						details: detailsFor("error"),
					};
				}

				if (params.reset) {
					await session.reset();
					// Restored-from-history state is gone with the reset, so the
					// "state was restored" hint would mislead on later errors.
					restoredUnverified = false;
				}

				const abandoned = params.abandon ? session.abandon() : false;
				if (params.abandon && params.code === undefined && !params.resume) {
					return {
						content: [{ type: "text", text: abandoned ? "(suspended script abandoned)" : "(nothing is suspended)" }],
						details: detailsFor("ok"),
					};
				}

				// Gated calls freeze the script while the human decides in the
				// TUI; "decide later" checkpoints the paused interpreter
				// (resumable via resume=true, even after a pi restart — the
				// suspension rides in the session state); headless runs deny
				// unless autoApprove opts in.
				const onApproval = async (request: ApprovalRequest): Promise<boolean | "suspend"> => {
					if (options.autoApprove) return true;
					if (!ctx?.hasUI) return false;
					const choice = await ctx.ui.select(`Approve ${formatCall(request)}?`, [
						APPROVAL_CHOICES.approve,
						APPROVAL_CHOICES.deny,
						APPROVAL_CHOICES.suspend,
					]);
					if (choice === APPROVAL_CHOICES.approve) return true;
					if (choice === APPROVAL_CHOICES.suspend) return "suspend";
					return false;
				};

				let streamed = "";
				const runOptions = {
					signal,
					onApproval,
					onPrint: (text: string) => {
						streamed += text;
						onUpdate?.({
							content: [{ type: "text", text: streamed }],
							details: { status: "ok", state: "", calls: [] } satisfies CodeToolDetails,
						});
					},
				};

				let result: RunResult;
				if (params.resume) {
					if (!session.suspendedCall) {
						return {
							content: [{ type: "text", text: restoreNote + "(nothing is suspended — run code normally)" }],
							details: detailsFor("error"),
						};
					}
					result = await session.resume(runOptions);
				} else {
					if (session.suspendedCall) {
						return {
							content: [
								{
									type: "text",
									text:
										'(a script is suspended awaiting approval — call with {"resume": true}, ' +
										'discard it with {"abandon": true}, or reset=true; new code was not run)',
								},
							],
							details: detailsFor("suspended"),
						};
					}
					if (params.code === undefined) {
						return {
							content: [{ type: "text", text: params.reset ? "(session reset)" : "(code is required unless resume=true)" }],
							details: detailsFor(params.reset ? "ok" : "error"),
						};
					}
					result = await session.run(params.code, runOptions);
				}

				const abandonNote = abandoned ? "[note: discarded the previously suspended script]\n" : "";
				let text = restoreNote + abandonNote + session.takePreludeNote() + result.stdout;
				restoreNote = "";
				if (result.stdoutTruncated) text += "\n[print output truncated]";
				if (result.status === "ok") {
					if (result.output !== null && result.output !== undefined) {
						if (text && !text.endsWith("\n")) text += "\n";
						text += `=> ${pyRepr(result.output)}`;
					}
					if (!text) text = "(no output)";
				} else if (result.status === "suspended") {
					if (text && !text.endsWith("\n")) text += "\n";
					text += `[suspended] The script is paused awaiting user approval of ${formatCall(
						result.suspendedCall,
						200,
					)}. Nothing after that call has run; completed work will not repeat. STOP and tell the user what is pending — do NOT call this tool again until the user explicitly says they have decided. Then continue with {"resume": true} (works even in a later session), or discard it with {"abandon": true}.`;
				} else {
					if (text && !text.endsWith("\n")) text += "\n";
					text += result.error;
					if (restoredUnverified) {
						text +=
							"\n[note: session state was restored from an earlier conversation; if this error references older code, retry with reset=true]";
					}
				}
				restoredUnverified = false;

				const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
				let finalText = truncation.content;
				if (truncation.truncated) finalText += "\n[output truncated]";

				return {
					content: [{ type: "text", text: finalText }],
					details: detailsFor(
						result.status,
						result.calls.map((c) => c.tool),
					),
				};
			},
		});

		pi.registerCommand(`${toolName}-reset`, {
			description: `Reset the ${toolName} tool's Python session (clears all variables)`,
			handler: async (_args, ctx) => {
				await session.reset();
				ctx.ui.notify("Code session state cleared", "info");
			},
		});
	};
}

export default createCodeModeExtension({ autoApprove: true });
