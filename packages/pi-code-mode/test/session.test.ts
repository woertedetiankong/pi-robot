/** CodeSession behavior against the real monty worker pool. */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Monty } from "@pydantic/monty";
import { buildTypeCheckStubs } from "../src/core/capabilities.ts";
import { ToolRegistry } from "../src/core/registry.ts";
import { CodeSession, MONTY_VERSION, type SerializedState } from "../src/core/session.ts";
import { HostToolError } from "../src/core/types.ts";
import type { ApprovalRequest, HostTool } from "../src/core/types.ts";

let pool: Monty;
before(async () => {
	pool = await Monty.create({ requestTimeout: 20 });
});
after(async () => {
	await pool.close();
});

/** A side-effecting gated tool plus simple helpers, fresh per test. */
function makeTools() {
	const effects: string[] = [];
	const echo: HostTool = {
		name: "echo",
		description: "Echo a value back.",
		params: [{ name: "value", type: "str" }],
		returns: "str",
		execute: (args) => `echo:${args[0]}`,
	};
	const failing: HostTool = {
		name: "flaky",
		description: "Always raises.",
		params: [],
		returns: "str",
		execute: () => {
			throw new HostToolError("nope", "ValueError");
		},
	};
	const gated: HostTool = {
		name: "mutate",
		description: "A gated side effect.",
		params: [{ name: "what", type: "str" }],
		returns: "str",
		requiresApproval: true,
		execute: (args) => {
			effects.push(String(args[0]));
			return `did:${args[0]}`;
		},
	};
	const record: HostTool = {
		name: "record",
		description: "Accepts a dict payload.",
		params: [{ name: "payload", type: "dict" }],
		returns: "str",
		execute: (args) => JSON.stringify(args[0]),
	};
	return { registry: new ToolRegistry([echo, failing, gated, record]), effects };
}

describe("CodeSession basics", () => {
	it("evaluates and persists state across runs", async () => {
		const { registry } = makeTools();
		const session = new CodeSession({ pool, tools: registry });
		try {
			const first = await session.run("x = 21");
			assert.equal(first.status, "ok");
			const second = await session.run("x * 2");
			assert.equal(second.status, "ok");
			assert.equal(second.output, 42);
		} finally {
			await session.close();
		}
	});

	it("captures print output and streams it", async () => {
		const { registry } = makeTools();
		const session = new CodeSession({ pool, tools: registry });
		const streamed: string[] = [];
		try {
			const result = await session.run("print('hello')\nprint('world')\n'done'", {
				onPrint: (t) => streamed.push(t),
			});
			assert.equal(result.status, "ok");
			assert.equal(result.stdout, "hello\nworld\n");
			assert.equal(result.output, "done");
			assert.ok(streamed.join("").includes("hello"));
		} finally {
			await session.close();
		}
	});

	it("dispatches tool calls with normalized args and records traces", async () => {
		const { registry } = makeTools();
		const session = new CodeSession({ pool, tools: registry });
		try {
			const result = await session.run("record({'k': [1, 2]})");
			assert.equal(result.status, "ok");
			assert.equal(result.output, '{"k":[1,2]}');
			assert.equal(result.calls.length, 1);
			assert.equal(result.calls[0]?.tool, "record");
			assert.deepEqual(result.calls[0]?.args, [{ k: [1, 2] }]);
			assert.equal(result.calls[0]?.ok, true);
		} finally {
			await session.close();
		}
	});

	it("raises typed Python exceptions from HostToolError", async () => {
		const { registry } = makeTools();
		const session = new CodeSession({ pool, tools: registry });
		try {
			const result = await session.run(
				"try:\n    flaky()\nexcept ValueError as e:\n    out = f'caught {e}'\nout",
			);
			assert.equal(result.status, "ok");
			assert.equal(result.output, "caught nope");
		} finally {
			await session.close();
		}
	});

	it("keeps pre-error state after a runtime error (REPL semantics)", async () => {
		const { registry } = makeTools();
		const session = new CodeSession({ pool, tools: registry });
		try {
			const errored = await session.run("y = 7\n1 / 0");
			assert.equal(errored.status, "error");
			assert.equal(errored.errorKind, "runtime");
			assert.ok(errored.error.includes("ZeroDivisionError"));
			const after_ = await session.run("y");
			assert.equal(after_.status, "ok");
			assert.equal(after_.output, 7);
		} finally {
			await session.close();
		}
	});

	it("raises NameError for unknown functions", async () => {
		const { registry } = makeTools();
		const session = new CodeSession({ pool, tools: registry });
		try {
			const result = await session.run("no_such_tool(1)");
			assert.equal(result.status, "error");
			assert.ok(result.status === "error" && result.error.includes("NameError"));
		} finally {
			await session.close();
		}
	});
});

describe("approval gating", () => {
	it("denies gated calls by default with a catchable PermissionError", async () => {
		const { registry, effects } = makeTools();
		const session = new CodeSession({ pool, tools: registry });
		try {
			const result = await session.run(
				"try:\n    mutate('a')\nexcept PermissionError:\n    out = 'denied'\nout",
			);
			assert.equal(result.status, "ok");
			assert.equal(result.output, "denied");
			assert.deepEqual(effects, []);
		} finally {
			await session.close();
		}
	});

	it("executes gated calls when approved", async () => {
		const { registry, effects } = makeTools();
		const session = new CodeSession({ pool, tools: registry });
		try {
			const result = await session.run("mutate('a')", { onApproval: () => true });
			assert.equal(result.status, "ok");
			assert.equal(result.output, "did:a");
			assert.deepEqual(effects, ["a"]);
			assert.equal(result.calls[0]?.approved, true);
		} finally {
			await session.close();
		}
	});

	it("suspends, resumes with re-approval, and never repeats completed work", async () => {
		const { registry, effects } = makeTools();
		const session = new CodeSession({ pool, tools: registry });
		try {
			const requests: ApprovalRequest[] = [];
			const suspended = await session.run("pre = mutate('first')\npost = mutate('second')\nf'{pre}|{post}'", {
				onApproval: (req) => {
					requests.push(req);
					return req.args[0] === "first" ? true : "suspend";
				},
			});
			assert.equal(suspended.status, "suspended");
			assert.equal(session.suspendedCall?.tool, "mutate");
			assert.deepEqual(effects, ["first"]);

			// New code is refused while suspended.
			await assert.rejects(() => session.run("1"), /suspended/);

			const resumed = await session.resume({ onApproval: () => true });
			assert.equal(resumed.status, "ok");
			assert.equal(resumed.output, "did:first|did:second");
			// 'first' ran exactly once: suspension checkpointing is not replay.
			assert.deepEqual(effects, ["first", "second"]);
			assert.equal(session.suspendedCall, null);
		} finally {
			await session.close();
		}
	});

	it("abandon() reverts to the last completed snippet", async () => {
		const { registry, effects } = makeTools();
		const session = new CodeSession({ pool, tools: registry });
		try {
			await session.run("stable = 1");
			const suspended = await session.run("partial = 2\nmutate('x')", { onApproval: () => "suspend" });
			assert.equal(suspended.status, "suspended");
			assert.equal(session.abandon(), true);
			// monty has no dir(); detect the rolled-back name via NameError
			const check = await session.run(
				"try:\n    partial\n    has_partial = True\nexcept NameError:\n    has_partial = False\n(stable, has_partial)",
			);
			assert.equal(check.status, "ok");
			// partial was rolled back with the abandoned snippet
			assert.deepEqual(check.output, [1, false]);
			assert.deepEqual(effects, []);
		} finally {
			await session.close();
		}
	});
});

describe("state persistence", () => {
	it("round-trips idle session state through dumpState/restoreState", async () => {
		const { registry } = makeTools();
		const first = new CodeSession({ pool, tools: registry });
		let state: SerializedState | null;
		try {
			await first.run("def triple(v):\n    return v * 3\nseed = 14");
			state = first.dumpState();
			assert.equal(state?.kind, "session");
		} finally {
			await first.close();
		}

		const second = new CodeSession({ pool, tools: registry });
		try {
			second.restoreState(state!);
			const result = await second.run("triple(seed)");
			assert.equal(result.status, "ok");
			assert.equal(result.output, 42);
		} finally {
			await second.close();
		}
	});

	it("round-trips a suspension through dumpState/restoreState (restart survival)", async () => {
		const { registry, effects } = makeTools();
		const first = new CodeSession({ pool, tools: registry });
		let state: SerializedState | null;
		try {
			const suspended = await first.run("done = mutate('later')\ndone", { onApproval: () => "suspend" });
			assert.equal(suspended.status, "suspended");
			state = first.dumpState();
			assert.equal(state?.kind, "suspension");
			assert.equal(state?.request?.tool, "mutate");
		} finally {
			await first.close();
		}

		// "Restart": a brand-new CodeSession adopts the serialized suspension.
		const second = new CodeSession({ pool, tools: registry });
		try {
			second.restoreState(state!);
			assert.equal(second.suspendedCall?.tool, "mutate");
			const resumed = await second.resume({ onApproval: () => true });
			assert.equal(resumed.status, "ok");
			assert.equal(resumed.output, "did:later");
			assert.deepEqual(effects, ["later"]);
		} finally {
			await second.close();
		}
	});

	it("serializes suspension state containing BigInt args (regression)", async () => {
		const { registry } = makeTools();
		const session = new CodeSession({ pool, tools: registry });
		try {
			const suspended = await session.run("mutate(2 ** 70)", { onApproval: () => "suspend" });
			assert.equal(suspended.status, "suspended");
			const state = session.dumpState();
			// Must not throw despite the > 2^53 integer in the request args.
			const json = JSON.stringify(state);
			assert.ok(json.includes("1180591620717411303424"));
		} finally {
			await session.close();
		}
	});

	it("rejects malformed state", () => {
		const { registry } = makeTools();
		const session = new CodeSession({ pool, tools: registry });
		assert.throws(() => session.restoreState({ v: 2, montyVersion: MONTY_VERSION, kind: "session", data: "" }));
		assert.throws(() => session.restoreState({ v: 2, kind: "session", data: "AAAA" } as never));
		assert.throws(() => session.restoreState({ v: 2, montyVersion: MONTY_VERSION, kind: "suspension", data: "AAAA" }));
	});

	it("reset() drops state entirely", async () => {
		const { registry } = makeTools();
		const session = new CodeSession({ pool, tools: registry });
		try {
			await session.run("z = 1");
			await session.reset();
			const result = await session.run("z");
			assert.equal(result.status, "error");
			assert.ok(result.status === "error" && result.error.includes("NameError"));
		} finally {
			await session.close();
		}
	});
});

describe("type checking", () => {
	it("blocks miscalls before execution and survives across dump/load", async () => {
		const { registry } = makeTools();
		const stubs = await buildTypeCheckStubs(pool, registry);
		const first = new CodeSession({ pool, tools: registry, typeCheckStubs: stubs });
		let state: SerializedState | null;
		try {
			const bad = await first.run("echo(123)");
			assert.equal(bad.status, "error");
			assert.equal(bad.errorKind, "typing");

			const good = await first.run("n = 5\necho('ok')");
			assert.equal(good.status, "ok");
			state = first.dumpState();
		} finally {
			await first.close();
		}

		// After restoring, the type checker must still know restored globals.
		const second = new CodeSession({ pool, tools: registry, typeCheckStubs: stubs });
		try {
			second.restoreState(state!);
			const result = await second.run("n + 1");
			assert.equal(result.status, "ok", `expected restored state to type-check, got: ${JSON.stringify(result)}`);
			assert.equal(result.output, 6);
		} finally {
			await second.close();
		}
	});
});

describe("prelude loading", () => {
	it("loads saved snippets in dependency order via retry and reports failures", async () => {
		const { registry } = makeTools();
		const session = new CodeSession({
			pool,
			tools: registry,
			// z_helper sorts after a_caller, so a_caller fails on the first
			// pass and succeeds on the retry — exercising the topo-sort loop.
			prelude: async () => [
				{ name: "a_caller", code: "def a_caller():\n    return z_helper() + 1" },
				{ name: "broken", code: "def broken(:\n    pass" },
				{ name: "z_helper", code: "def z_helper():\n    return 41" },
			],
		});
		try {
			const result = await session.run("a_caller()");
			assert.equal(result.status, "ok");
			assert.equal(result.output, 42);
			assert.ok(session.takePreludeNote().includes("broken"));
		} finally {
			await session.close();
		}
	});
});

describe("error classification", () => {
	it("returns a crashed result for non-Monty errors instead of throwing (regression)", async () => {
		const { registry } = makeTools();
		const session = new CodeSession({ pool, tools: registry });
		try {
			await session.run("keep = 'safe'");
			// Symbol inputs cannot cross into monty; the host-side conversion
			// error must classify as a result, not escape run().
			const result = await session.run("1", { inputs: { bad: Symbol("nope") as never } });
			assert.equal(result.status, "error");
			assert.equal(result.status === "error" && result.errorKind, "crashed");
			// The worker was discarded; the next run restores prior state.
			const after_ = await session.run("keep");
			assert.equal(after_.status, "ok");
			assert.equal(after_.output, "safe");
		} finally {
			await session.close();
		}
	});
});

describe("watchdog", () => {
	it("kills runaway code and rolls back to the last completed snippet", async () => {
		const tinyPool = await Monty.create({ requestTimeout: 2 });
		const { registry } = makeTools();
		const session = new CodeSession({ pool: tinyPool, tools: registry });
		try {
			await session.run("safe = 'kept'");
			const result = await session.run("while True:\n    pass");
			assert.equal(result.status, "error");
			assert.equal(result.errorKind, "crashed");
			const after_ = await session.run("safe");
			assert.equal(after_.status, "ok");
			assert.equal(after_.output, "kept");
		} finally {
			await session.close();
			await tinyPool.close();
		}
	});
});
