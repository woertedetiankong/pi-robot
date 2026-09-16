/**
 * CodeSession: a persistent Python REPL backed by a monty worker, with
 * checkpoint/restore and resumable approval suspensions.
 *
 * State model (all transitions keep these invariants):
 * - `current`      — a live worker during a run; released after checkpointing.
 * - `lastIdleDump` — serialized interpreter state after the last completed
 *                    run. Restores a crashed/aborted/restarted session; the
 *                    unit of rollback is one snippet.
 * - `suspension`   — a serialized mid-execution snapshot paused at a gated
 *                    call, plus the pending request. While set, new code is
 *                    refused; resume() re-drives it, abandon() discards it
 *                    (reverting to lastIdleDump).
 *
 * Unlike replay-based designs, completed side effects can never re-execute:
 * state is the interpreter's own serialized heap, not a transcript.
 */
import {
	type Monty,
	MontyCrashedError,
	MontyError,
	MontyRuntimeError,
	MontySyntaxError,
	type MontySession,
	MontyTypingError,
} from "@pydantic/monty";
import type { MountDir } from "@pydantic/monty/node";
import type { ToolRegistry } from "./registry.ts";
import { drive } from "./runner.ts";
import { jsonSafe } from "./values.ts";
import type {
	ApprovalRequest,
	RunErrorKind,
	RunOptions,
	RunResult,
	SessionLimits,
	ToolCallTrace,
} from "./types.ts";

const DEFAULT_MAX_MEMORY = 256 * 1024 * 1024;
const DEFAULT_MAX_STDOUT_BYTES = 1024 * 1024;
export const MONTY_VERSION = "0.0.23";
/** After an abort, how long to let the interpreter reach a call boundary before killing the worker. */
const ABORT_GRACE_MS = 2000;

/** A saved snippet fed into brand-new sessions (saved tools). */
export interface PreludeSnippet {
	name: string;
	code: string;
}

export interface CodeSessionOptions {
	/** Worker pool the session checks out from (shared; not owned). */
	pool: Monty;
	tools: ToolRegistry;
	limits?: SessionLimits;
	/** Pre-execution type checking. Default true when typeCheckStubs is provided. */
	typeCheck?: boolean;
	/** Stub text for monty's type checker (see buildTypeCheckStubs). */
	typeCheckStubs?: string;
	/** Name shown in tracebacks. Default 'code.py'. */
	scriptName?: string;
	/** Fresh owned mount(s) per feed; CodeSession closes them after execution. */
	makeMount?: () => MountDir | MountDir[] | undefined;
	/** Snippets fed into brand-new sessions, e.g. saved tools. */
	prelude?: () => Promise<PreludeSnippet[]>;
}

/** JSON-serializable session state, small enough to ride in tool-result metadata. */
export interface SerializedState {
	v: 2;
	montyVersion: string;
	kind: "session" | "suspension";
	/** Base64 of the monty dump (idle session or paused snapshot). */
	data: string;
	/** Present when kind is 'suspension'. */
	request?: ApprovalRequest;
}

export class CodeSession {
	private readonly options: CodeSessionOptions;
	private current: MontySession | null = null;
	private lastIdleDump: Buffer | null = null;
	private suspension: { blob: Buffer; request: ApprovalRequest } | null = null;
	private preludeNote = "";
	private running = false;
	private activeMounts: MountDir[] = [];

	constructor(options: CodeSessionOptions) {
		if (options.limits && "maxAllocations" in options.limits) {
			throw new Error("maxAllocations was removed by Monty; use maxMemory and maxSuspensions instead");
		}
		this.options = options;
	}

	/** The gated call a suspended run is waiting on, if any. */
	get suspendedCall(): ApprovalRequest | null {
		return this.suspension?.request ?? null;
	}

	/** Warnings from loading saved snippets, cleared on read. */
	takePreludeNote(): string {
		const note = this.preludeNote;
		this.preludeNote = "";
		return note;
	}

	/** Run a snippet in the persistent REPL. Refuses while a run is suspended. */
	async run(code: string, opts: RunOptions = {}): Promise<RunResult> {
		if (this.suspension) throw new Error("a run is suspended awaiting approval; resume() or abandon() it first");
		return this.guarded(opts, async (capture) => {
			const session = await this.ensureSession(capture.printCallback);
			return session.feedStart(code, {
				inputs: opts.inputs,
				printCallback: capture.printCallback,
				mount: this.acquireMounts(),
			});
		});
	}

	/** Re-drive the suspended run; the pending gated call is re-submitted for approval. */
	async resume(opts: RunOptions = {}): Promise<RunResult> {
		const suspension = this.suspension;
		if (!suspension) throw new Error("nothing is suspended");
		this.suspension = null;
		return this.guarded(opts, async (capture) => {
			// loadSnapshot is only valid on a fresh session, so the suspended
			// worker was discarded at suspension time; check out a new one.
			await this.discardWorker();
			const session = await this.checkout();
			this.current = session;
			return session.loadSnapshot(suspension.blob, {
				printCallback: capture.printCallback,
				mount: this.acquireMounts(),
			});
		});
	}

	/** Discard a suspended run. State reverts to the last completed snippet. */
	abandon(): boolean {
		if (!this.suspension) return false;
		this.suspension = null;
		return true;
	}

	/** Drop all state; the next run starts a brand-new interpreter (prelude reloaded). */
	async reset(): Promise<void> {
		this.suspension = null;
		this.lastIdleDump = null;
		await this.discardWorker();
	}

	/** Release the live worker (kept state still restores from dumps). */
	async close(): Promise<void> {
		await this.discardWorker();
	}

	/** Serializable checkpoint of the session, or null when there is none. */
	dumpState(): SerializedState | null {
		if (this.suspension) {
			// The persisted request is display-only after restore (resume()
			// rebuilds the live one from the snapshot), so sanitize values
			// JSON.stringify would choke on (BigInt, Map, Set, bytes).
			const request = this.suspension.request;
			return {
				v: 2,
				montyVersion: MONTY_VERSION,
				kind: "suspension",
				data: this.suspension.blob.toString("base64"),
				request: {
					tool: request.tool,
					args: request.args.map(jsonSafe),
					kwargs: Object.fromEntries(Object.entries(request.kwargs).map(([k, v]) => [k, jsonSafe(v)])),
					description: request.description,
				},
			};
		}
		if (this.lastIdleDump) {
			return { v: 2, montyVersion: MONTY_VERSION, kind: "session", data: this.lastIdleDump.toString("base64") };
		}
		return null;
	}

	/**
	 * Adopt a checkpoint produced by dumpState() — possibly in a previous
	 * process. Lazy: no worker is created until the next run()/resume().
	 * Throws on malformed input; callers should treat that as "start fresh".
	 */
	restoreState(state: SerializedState): void {
		if (!state || state.v !== 2 || state.montyVersion !== MONTY_VERSION) {
			throw new Error(`incompatible Monty checkpoint; expected ${MONTY_VERSION}. Start fresh; pending work was not replayed`);
		}
		if (this.running || this.current) throw new Error("restore requires an idle session without a live worker");
		if (typeof state.data !== "string") throw new Error("unrecognized session state");
		const blob = Buffer.from(state.data, "base64");
		if (blob.length === 0) throw new Error("empty session state");
		if (state.kind === "suspension") {
			if (!state.request) throw new Error("suspension state without a request");
			this.suspension = { blob, request: state.request };
			this.lastIdleDump = null;
		} else if (state.kind === "session") {
			this.lastIdleDump = blob;
			this.suspension = null;
		} else {
			throw new Error("unrecognized session state kind");
		}
	}

	// -------------------------------------------------------------------------

	/** Shared run/resume scaffolding: stdout capture, drive, classify, checkpoint. */
	private async guarded(
		opts: RunOptions,
		begin: (capture: StdoutCapture) => Promise<Awaited<ReturnType<MontySession["feedStart"]>>>,
	): Promise<RunResult> {
		if (this.running) throw new Error("a run is already in progress on this session");
		this.running = true;
		const capture = new StdoutCapture(opts.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES, opts.onPrint);
		const traces: ToolCallTrace[] = [];
		const base = () => ({ stdout: capture.text, stdoutTruncated: capture.truncated, calls: traces });

		// Aborts are honored at tool-call boundaries; if the interpreter is
		// mid-computation, give it a grace period and then kill the worker
		// (state reverts to lastIdleDump — the aborted snippet is the only loss).
		let abortTimer: ReturnType<typeof setTimeout> | undefined;
		const onAbort = () => {
			abortTimer = setTimeout(() => void this.discardWorker(), ABORT_GRACE_MS);
			abortTimer.unref?.();
		};
		if (opts.signal) {
			if (opts.signal.aborted) onAbort();
			else opts.signal.addEventListener("abort", onAbort, { once: true });
		}

		try {
			const first = await begin(capture);
			const outcome = await drive(first, {
				registry: this.options.tools,
				signal: opts.signal,
				onApproval: opts.onApproval,
				traces,
			});

			if (outcome.kind === "suspended") {
				const blob = await outcome.snapshot.dump();
				// The paused worker cannot serve further feeds; discard it.
				await this.discardWorker();
				this.suspension = { blob, request: outcome.request };
				return {
					...base(),
					status: "suspended",
					output: undefined,
					error: `suspended awaiting approval of ${outcome.request.description}`,
					suspendedCall: outcome.request,
				};
			}

			this.lastIdleDump = (await this.current?.dump()) ?? this.lastIdleDump;
			return { ...base(), status: "ok", output: outcome.output };
		} catch (err) {
			return { ...base(), status: "error", output: undefined, ...(await this.classify(err, opts)) };
		} finally {
			clearTimeout(abortTimer);
			opts.signal?.removeEventListener("abort", onAbort);
			// Monty counts suspensions per checkout. Restore the heap into a fresh
			// checkout on the next invocation so the REPL never inherits an exhausted
			// budget. No Python or host side effects are replayed.
			await this.discardWorker();
			for (const mount of this.activeMounts.splice(0)) mount.close();
			this.running = false;
		}
	}

	/** Map a thrown error onto a model-facing message, updating worker state. */
	private async classify(err: unknown, opts: RunOptions): Promise<{ error: string; errorKind: RunErrorKind }> {
		if (opts.signal?.aborted) {
			// Includes KeyboardInterrupt tracebacks and worker-kill fallout.
			await this.discardWorker();
			return { error: "(aborted by user — interpreter state was rolled back; completed host side effects were not undone)", errorKind: "aborted" as const };
		}
		if (err instanceof MontySyntaxError) {
			return { error: err.display("type-msg"), errorKind: "syntax" as const };
		}
		if (err instanceof MontyTypingError) {
			// The snippet never ran; the session and its state are intact.
			return { error: typingMessage(err), errorKind: "typing" as const };
		}
		if (err instanceof MontyRuntimeError) {
			// REPL semantics: statements before the raising line executed and
			// persist, so checkpoint the post-error state.
			try {
				this.lastIdleDump = (await this.current?.dump()) ?? this.lastIdleDump;
			} catch {
				await this.discardWorker();
			}
			return { error: err.display("traceback"), errorKind: "runtime" as const };
		}
		if (err instanceof MontyCrashedError) {
			this.current = null; // worker already dead; the pool replaces it
			const reason = err.timedOut
				? "execution timed out and the sandbox worker was killed"
				: "the sandbox worker crashed";
			return {
				error: `(${reason} — interpreter state reverts to the last completed snippet; completed host side effects were not undone)`,
				errorKind: "crashed" as const,
			};
		}
		if (err instanceof MontyError) {
			return { error: err.message, errorKind: "runtime" as const };
		}
		// Unknown failure (e.g. monty's ProtocolError, which is not a
		// MontyError, or a host-side conversion error). The worker may be
		// poisoned — discard it so the next run gets a fresh one; state
		// reverts to the last completed snippet.
		await this.discardWorker();
		const message = err instanceof Error ? err.message : String(err);
		return {
			error: `(sandbox failure: ${message} — session state reverts to the last completed snippet)`,
			errorKind: "crashed" as const,
		};
	}

	private async ensureSession(printCallback: (stream: "stdout" | "stderr", text: string) => void): Promise<MontySession> {
		if (this.current) return this.current;
		const session = await this.checkout();
		this.current = session;
		if (this.lastIdleDump) {
			try {
				await session.loadSession(this.lastIdleDump);
			} catch (err) {
				this.lastIdleDump = null;
				throw new Error(`checkpoint could not be restored and was discarded; code was not run. Retry to start fresh: ${String(err)}`);
			}
		} else if (this.options.prelude) {
			await this.loadPrelude(session, printCallback);
		}
		return session;
	}

	private checkout(): Promise<MontySession> {
		const limits = this.options.limits;
		return this.options.pool.checkout({
			scriptName: this.options.scriptName ?? "code.py",
			limits: {
				maxMemory: limits?.maxMemory ?? DEFAULT_MAX_MEMORY,
				maxSuspensions: limits?.maxSuspensions ?? 1000,
				...(limits?.maxRecursionDepth !== undefined && { maxRecursionDepth: limits.maxRecursionDepth }),
			},
			typeCheck: this.options.typeCheck ?? this.options.typeCheckStubs !== undefined,
			...(this.options.typeCheckStubs !== undefined && { typeCheckStubs: this.options.typeCheckStubs }),
		});
	}

	/**
	 * Feed saved snippets one at a time, looping until the failed set stops
	 * shrinking: a malformed snippet skips just that tool, and dependency
	 * chains load in any order (a function's globals resolve only if defined
	 * before it — retrying failures effectively topo-sorts).
	 */
	private async loadPrelude(
		session: MontySession,
		printCallback: (stream: "stdout" | "stderr", text: string) => void,
	): Promise<void> {
		let pending = await this.options.prelude!();
		while (pending.length > 0) {
			const failed: { snippet: PreludeSnippet; error: string }[] = [];
			for (const snippet of pending) {
				try {
					await session.feedRun(snippet.code, { printCallback, mount: this.acquireMounts() });
				} catch (err) {
					if (err instanceof MontyCrashedError) throw err;
					const message = err instanceof MontyError ? err.display("msg") : String(err);
					failed.push({ snippet, error: message.split("\n")[0] ?? "error" });
				}
			}
			if (failed.length === pending.length) {
				if (failed.length > 0) {
					const skipped = failed.map((f) => `${f.snippet.name} (${f.error})`).join("; ");
					this.preludeNote = `[note: skipped saved tool(s) that failed to load: ${skipped}]\n\n`;
				}
				return;
			}
			pending = failed.map((f) => f.snippet);
		}
	}

	private acquireMounts(): MountDir | MountDir[] | undefined {
		const mounts = this.options.makeMount?.();
		if (mounts) this.activeMounts.push(...(Array.isArray(mounts) ? mounts : [mounts]));
		return mounts;
	}

	private async discardWorker(): Promise<void> {
		const session = this.current;
		this.current = null;
		if (session) {
			try {
				await session.close();
			} catch {
				// Worker already dead or mid-turn — nothing to release.
			}
		}
	}
}

/** Renders typing diagnostics compactly (one per line, no ANSI). */
function typingMessage(err: MontyTypingError): string {
	try {
		return err.display();
	} catch {
		return err.message;
	}
}

/** Caps both captured and streamed stdout, preserving the prefix of batched prints. */
class StdoutCapture {
	text = "";
	truncated = false;
	private bytes = 0;
	readonly printCallback: (stream: "stdout" | "stderr", text: string) => void;

	constructor(maxBytes: number, onPrint?: (text: string) => void) {
		this.printCallback = (stream, chunk) => {
			const tagged = stream === "stderr" ? `[stderr] ${chunk}` : chunk;
			if (this.truncated) return;
			const remaining = Math.max(0, maxBytes - this.bytes);
			if (Buffer.byteLength(tagged) > remaining) {
				this.truncated = true;
				// Streaming decode drops an incomplete UTF-8 character at the boundary.
				const prefix = new TextDecoder().decode(Buffer.from(tagged).subarray(0, remaining), { stream: true });
				this.text += prefix;
				if (prefix) onPrint?.(prefix);
				return;
			}
			this.bytes += Buffer.byteLength(tagged);
			this.text += tagged;
			onPrint?.(tagged);
		};
	}
}
