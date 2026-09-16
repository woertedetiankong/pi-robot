/**
 * The snapshot drive loop: advances a monty feedStart()/loadSnapshot()
 * execution, dispatching host-tool calls, enforcing approval gates, and
 * honoring aborts at call boundaries. Interpreter errors (MontyRuntimeError
 * etc.) propagate to the caller (CodeSession), which classifies them.
 */
import {
	FunctionSnapshot,
	MontyComplete,
	NameLookupSnapshot,
	type Snapshot,
} from "@pydantic/monty";
import type { ToolRegistry } from "./registry.ts";
import { HostToolError } from "./types.ts";
import type { ApprovalDecision, ApprovalRequest, ToolCallTrace } from "./types.ts";
import { formatCall, toHostValue } from "./values.ts";

export interface DriveContext {
	registry: ToolRegistry;
	signal?: AbortSignal;
	onApproval?: (request: ApprovalRequest) => ApprovalDecision | Promise<ApprovalDecision>;
	/** Appended in place as calls happen, so partial traces survive errors. */
	traces: ToolCallTrace[];
}

export type DriveOutcome =
	| { kind: "complete"; output: unknown }
	| { kind: "suspended"; snapshot: FunctionSnapshot; request: ApprovalRequest };

/** One step of handleCall: either execution advanced, or it must suspend. */
type CallStep = { next: Snapshot } | { suspend: ApprovalRequest; snapshot: FunctionSnapshot };

/** An Error whose name monty maps onto the same-named Python exception type. */
export function pythonError(type: string, message: string): Error {
	const err = new Error(message);
	err.name = type;
	return err;
}

export async function drive(first: Snapshot, ctx: DriveContext): Promise<DriveOutcome> {
	let snap = first;
	for (;;) {
		if (snap instanceof MontyComplete) {
			return { kind: "complete", output: snap.output };
		}

		if (snap instanceof NameLookupSnapshot) {
			// A bare reference to a tool name (e.g. aliasing `f = grep`)
			// registers it as an external function; calls through the alias
			// come back as FunctionSnapshots under the original name, so
			// approval gates cannot be bypassed by aliasing.
			snap = ctx.registry.has(snap.variableName) ? await snap.resume(snap.variableName) : await snap.resume();
			continue;
		}

		if (snap instanceof FunctionSnapshot) {
			const step = await handleCall(snap, ctx);
			if ("suspend" in step) {
				return { kind: "suspended", snapshot: step.snapshot, request: step.suspend };
			}
			snap = step.next;
			continue;
		}

		// FutureSnapshot: we never register futures (tools are answered
		// synchronously), but resolve defensively if one appears.
		snap = await snap.resumeAuto();
	}
}

async function handleCall(snap: FunctionSnapshot, ctx: DriveContext): Promise<CallStep> {
	const name = snap.functionName;

	if (ctx.signal?.aborted) {
		// KeyboardInterrupt derives from BaseException, so `except Exception`
		// in sandbox code cannot swallow an abort.
		return { next: await snap.resumeError(pythonError("KeyboardInterrupt", "aborted by user")) };
	}

	// Since Monty 0.0.23, feedStart surfaces even mount-covered OS calls.
	// Route them through Monty's captured read-only mounts, never the tool registry.
	if (snap.isOsFunction) return { next: await snap.resumeAuto() };

	const tool = ctx.registry.get(name);
	if (!tool) {
		return { next: await snap.resumeError(pythonError("NameError", `name '${name}' is not defined`)) };
	}

	const args = snap.args.map(toHostValue);
	const kwargs = Object.fromEntries(Object.entries(snap.kwargs).map(([k, v]) => [k, toHostValue(v)]));
	const trace: ToolCallTrace = { tool: name, args, kwargs, durationMs: 0, ok: false };
	const started = Date.now();
	const finish = () => {
		trace.durationMs = Date.now() - started;
		ctx.traces.push(trace);
	};

	if (tool.requiresApproval) {
		const request: ApprovalRequest = { tool: name, args, kwargs, description: formatCall({ tool: name, args, kwargs }) };
		const decision = ctx.onApproval ? await ctx.onApproval(request) : false;
		if (decision === "suspend") {
			// Hand the un-resumed snapshot back so the caller can checkpoint it.
			return { suspend: request, snapshot: snap };
		}
		trace.approved = decision;
		if (!decision) {
			trace.error = `user denied ${request.description}`;
			finish();
			return { next: await snap.resumeError(pythonError("PermissionError", trace.error)) };
		}
		// The user may have taken minutes to decide; re-check the abort flag.
		if (ctx.signal?.aborted) {
			finish();
			return { next: await snap.resumeError(pythonError("KeyboardInterrupt", "aborted by user")) };
		}
	}

	let value: unknown;
	try {
		value = await tool.execute(args, kwargs, ctx.signal);
	} catch (err) {
		const type = err instanceof HostToolError ? err.pythonType : "RuntimeError";
		const message = err instanceof Error ? err.message : String(err);
		trace.error = `${type}: ${message}`;
		finish();
		return { next: await snap.resumeError(pythonError(type, message)) };
	}
	trace.ok = true;
	finish();
	// Interpreter failures from resume belong to CodeSession. The snapshot has
	// already been consumed; attempting resumeError again hides the real error.
	return { next: await snap.resume(value === undefined ? null : value) };
}
