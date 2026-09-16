/**
 * Core contracts: host tools exposed to sandboxed Python, run options, and
 * the discriminated result union. Nothing in core/ imports pi — it is usable
 * as a plain library; the pi adapter lives in src/pi/.
 */

/** A parameter of a host tool, described in Python terms for prompt rendering. */
export interface HostToolParam {
	/** Python identifier. */
	name: string;
	/** Python type expression, e.g. 'str', 'int', 'list[str]'. */
	type: string;
	description?: string;
	optional?: boolean;
}

/**
 * A host-side tool exposed to sandboxed Python as a plain function.
 *
 * `execute` runs on the host while the interpreter is paused; it may be sync
 * or async. Args/kwargs arrive normalized to idiomatic JS (dicts as plain
 * objects, tuples as arrays). Throw `HostToolError` to raise a specific
 * Python exception type in the sandbox; any other thrown error surfaces as
 * RuntimeError. Long-running tools should honor `signal` (the run's abort
 * signal) — the sandbox watchdog cannot interrupt host-side work.
 */
export interface HostTool {
	/** Python identifier the sandboxed code calls. */
	name: string;
	/** Becomes the docstring in the rendered Python stub. */
	description: string;
	/**
	 * Rendered into the prompt stub AND (when typeCheck is on, the default)
	 * enforced pre-execution via generated type stubs — declare accurately.
	 * A stub monty's type checker can't parse degrades that tool to unchecked.
	 */
	params: HostToolParam[];
	/** Python type expression of the return value, e.g. 'str', 'list[dict]'. */
	returns: string;
	/** Shape/meaning of the return value (the model's code must deserialize it). */
	returnsDescription?: string;
	/**
	 * Pause the script and ask the host for approval before each call (see
	 * RunOptions.onApproval). Denial raises PermissionError in the sandbox.
	 * Without an approver configured, gated calls are always denied.
	 */
	requiresApproval?: boolean;
	execute(args: unknown[], kwargs: Record<string, unknown>, signal?: AbortSignal): unknown | Promise<unknown>;
}

/** Thrown by host tools to raise a specific Python exception in the sandbox. */
export class HostToolError extends Error {
	/** Python exception type to raise, e.g. 'ValueError', 'FileNotFoundError'. */
	readonly pythonType: string;

	constructor(message: string, pythonType = "RuntimeError") {
		super(message);
		this.name = "HostToolError";
		this.pythonType = pythonType;
	}
}

/** A gated host-tool call awaiting an approval decision. */
export interface ApprovalRequest {
	tool: string;
	args: unknown[];
	kwargs: Record<string, unknown>;
	description: string;
}

export type ApprovalDecision = boolean | "suspend";

/** One host-tool invocation made by the sandboxed code. */
export interface ToolCallTrace {
	tool: string;
	args: unknown[];
	kwargs: Record<string, unknown>;
	durationMs: number;
	ok: boolean;
	/** Host-side error message when ok is false (what was raised into Python). */
	error?: string;
	/** Approval outcome, present only for tools with requiresApproval. */
	approved?: boolean;
}

/**
 * Interpreter resource limits per session. maxDurationSecs is deliberately
 * absent: it is cumulative per monty checkout, which would silently starve a
 * long-lived REPL session. Wall-clock protection comes from the pool's
 * requestTimeout watchdog instead (see CodeSessionOptions.requestTimeout).
 */
export interface SessionLimits {
	/** Max heap memory in bytes. Default 256 MiB. */
	maxMemory?: number;
	/** Maximum host/OS/name-lookup suspensions per run or resume. Default 1000. */
	maxSuspensions?: number;
	maxRecursionDepth?: number;
}

export interface RunOptions {
	/** Host variables injected into the snippet's namespace by name. */
	inputs?: Record<string, unknown>;
	/** Checked at every host-tool call boundary; aborting raises KeyboardInterrupt. */
	signal?: AbortSignal;
	/** Cap on captured stdout bytes; output beyond it is dropped. Default 1 MiB. */
	maxStdoutBytes?: number;
	/** Streaming observer for print() chunks, bounded by maxStdoutBytes. */
	onPrint?: (text: string) => void;
	/**
	 * Decides gated (requiresApproval) host-tool calls. The script is paused
	 * mid-execution while this resolves; false raises a catchable
	 * PermissionError in the sandbox, and 'suspend' checkpoints the paused
	 * interpreter (resumable any time, even after a process restart). Gated
	 * calls are denied if omitted.
	 */
	onApproval?: (request: ApprovalRequest) => ApprovalDecision | Promise<ApprovalDecision>;
}

export type RunErrorKind = "syntax" | "runtime" | "typing" | "aborted" | "crashed";

interface RunResultBase {
	/** Captured print() output — the model-facing observation channel. */
	stdout: string;
	/** True if stdout exceeded maxStdoutBytes and was truncated. */
	stdoutTruncated: boolean;
	/** Every host-tool call the code made, in order. */
	calls: ToolCallTrace[];
}

export interface RunSuccess extends RunResultBase {
	status: "ok";
	/** Value of the last top-level expression, converted to JS. */
	output: unknown;
}

export interface RunError extends RunResultBase {
	status: "error";
	output: undefined;
	/** Model-facing failure description (Python traceback, syntax error, abort notice). */
	error: string;
	errorKind: RunErrorKind;
}

export interface RunSuspended extends RunResultBase {
	status: "suspended";
	output: undefined;
	/** Model-facing suspension description. */
	error: string;
	/** The gated call awaiting a decision. */
	suspendedCall: ApprovalRequest;
}

export type RunResult = RunSuccess | RunError | RunSuspended;
