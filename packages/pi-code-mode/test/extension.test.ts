/**
 * Drives the pi extension through a stub ExtensionAPI — the same call shapes
 * pi's agent loop uses — including approval dialogs, suspension riding in
 * details across a simulated restart, and the read-only workspace mount.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { APPROVAL_CHOICES, createCodeModeExtension } from "../src/pi/extension.ts";
import type { CodeModeExtensionOptions } from "../src/pi/extension.ts";
import type { HostTool } from "../src/core/types.ts";

interface ToolResult {
	content: Array<{ type: string; text?: string }>;
	details: { status: string; state: string; calls: string[] };
}

interface Harness {
	execute: (params: Record<string, unknown>, ctx?: Partial<StubCtx>) => Promise<ToolResult>;
	toolName: string;
	description: string;
	emitSessionStart: (branch: unknown[]) => void;
	shutdown: () => Promise<void>;
	commands: Map<string, (args: string, ctx: StubCtx) => Promise<void>>;
}

interface StubCtx {
	hasUI: boolean;
	ui: { select: (title: string, options: string[]) => Promise<string | undefined>; notify: (msg: string) => void };
	sessionManager: { getBranch: () => unknown[] };
}

async function loadExtension(options: CodeModeExtensionOptions, workspace: string): Promise<Harness> {
	const tools: Array<{
		name: string;
		description: string;
		execute: (id: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<ToolResult>;
	}> = [];
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const commands = new Map<string, (args: string, ctx: StubCtx) => Promise<void>>();
	const stubPi = {
		registerTool: (t: (typeof tools)[number]) => tools.push(t),
		registerCommand: (name: string, opts: { handler: (args: string, ctx: StubCtx) => Promise<void> }) =>
			commands.set(name, opts.handler),
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	};
	await createCodeModeExtension({ root: workspace, ...options })(stubPi as never);
	const tool = tools[0];
	if (!tool) throw new Error("extension registered no tool");

	const defaultCtx: StubCtx = {
		hasUI: false,
		ui: { select: async () => undefined, notify: () => {} },
		sessionManager: { getBranch: () => [] },
	};
	return {
		toolName: tool.name,
		description: tool.description,
		execute: (params, ctx = {}) => tool.execute("t1", params, undefined, undefined, { ...defaultCtx, ...ctx }),
		emitSessionStart: (branch) => {
			for (const h of handlers.get("session_start") ?? []) {
				h({}, { ...defaultCtx, sessionManager: { getBranch: () => branch } });
			}
		},
		shutdown: async () => {
			for (const h of handlers.get("session_shutdown") ?? []) await h({}, defaultCtx);
		},
		commands,
	};
}

function text(result: ToolResult): string {
	return result.content[0]?.text ?? "";
}

let workspace: string;
before(async () => {
	workspace = await mkdtemp(join(tmpdir(), "pi-code-mode-test-"));
	await writeFile(join(workspace, "data.json"), JSON.stringify({ answer: 42 }));
});
after(async () => {
	await rm(workspace, { recursive: true, force: true });
});

describe("extension basics", () => {
	it("runs code, persists state, and resets", async () => {
		const ext = await loadExtension({ bridgePiTools: false, toolStore: false, typeCheck: false }, workspace);
		try {
			assert.equal(text(await ext.execute({ code: "x = 20" })), "(no output)");
			assert.equal(text(await ext.execute({ code: "x + 2" })), "=> 22");
			assert.equal(text(await ext.execute({ reset: true })), "(session reset)");
			assert.ok(text(await ext.execute({ code: "x" })).includes("NameError"));
		} finally {
			await ext.shutdown();
		}
	});

	it("reads workspace files through the read-only mount", async () => {
		const ext = await loadExtension({ bridgePiTools: false, toolStore: false, typeCheck: false }, workspace);
		try {
			const result = await ext.execute({
				code: "import json\njson.loads(open('/workspace/data.json').read())['answer']",
			});
			assert.equal(text(result), "=> 42");
			const denied = await ext.execute({ code: "open('/workspace/new.txt', 'w')" });
			assert.ok(text(denied).includes("Error"), `mount should be read-only, got: ${text(denied)}`);
		} finally {
			await ext.shutdown();
		}
	});

	it("accepts /workspace-prefixed paths in bridged host helpers (regression)", async () => {
		// Models mix paradigms: open('/workspace/x') reads work, so they pass
		// write('/workspace/x', ...) too. The bridge must strip the prefix
		// instead of rejecting the write (which previously led to retry loops
		// ending in a false "done").
		const ext = await loadExtension({ toolStore: false, typeCheck: false, autoApprove: true }, workspace);
		try {
			const read = await ext.execute({ code: "read('/workspace/data.json')" });
			assert.ok(text(read).includes("42"), `bridged read should accept /workspace prefix, got: ${text(read)}`);
			const written = await ext.execute({ code: "write('/workspace/prefixed.txt', 'ok')" });
			assert.ok(!/error/i.test(text(written)), `bridged write should succeed, got: ${text(written)}`);
			const check = await ext.execute({ code: "open('/workspace/prefixed.txt').read()" });
			assert.ok(text(check).includes("ok"), `expected written content, got: ${text(check)}`);
		} finally {
			await ext.shutdown();
		}
	});

	it("type-checks tool calls before execution", async () => {
		const echo: HostTool = {
			name: "echo",
			description: "Echo.",
			params: [{ name: "value", type: "str" }],
			returns: "str",
			execute: (args) => String(args[0]),
		};
		const ext = await loadExtension({ bridgePiTools: false, toolStore: false, tools: [echo] }, workspace);
		try {
			const bad = await ext.execute({ code: "echo(123)" });
			assert.equal(bad.details.status, "error");
			assert.ok(text(bad).includes("invalid-argument-type"), `expected a typing diagnostic, got: ${text(bad)}`);
			const good = await ext.execute({ code: "echo('fine')" });
			assert.equal(text(good), '=> "fine"');
		} finally {
			await ext.shutdown();
		}
	});
});

describe("approval and suspension through the extension", () => {
	const gated: HostTool = {
		name: "mutate",
		description: "Gated.",
		params: [{ name: "what", type: "str" }],
		returns: "str",
		requiresApproval: true,
		execute: (args) => `did:${args[0]}`,
	};

	it("denies without UI, approves via dialog, suspends via 'decide later'", async () => {
		const ext = await loadExtension(
			{ bridgePiTools: false, toolStore: false, typeCheck: false, tools: [gated] },
			workspace,
		);
		try {
			const denied = await ext.execute({ code: "try:\n    mutate('a')\nexcept PermissionError:\n    r = 'no'\nr" });
			assert.equal(text(denied), '=> "no"');

			const approved = await ext.execute(
				{ code: "mutate('b')" },
				{ hasUI: true, ui: { select: async () => APPROVAL_CHOICES.approve, notify: () => {} } },
			);
			assert.equal(text(approved), '=> "did:b"');

			const suspended = await ext.execute(
				{ code: "mutate('c')" },
				{ hasUI: true, ui: { select: async () => APPROVAL_CHOICES.suspend, notify: () => {} } },
			);
			assert.equal(suspended.details.status, "suspended");
			assert.ok(text(suspended).includes("[suspended]"));

			// New code refused while suspended; resume completes it.
			const refused = await ext.execute({ code: "1" });
			assert.ok(text(refused).includes("suspended"));
			const resumed = await ext.execute(
				{ resume: true },
				{ hasUI: true, ui: { select: async () => APPROVAL_CHOICES.approve, notify: () => {} } },
			);
			assert.equal(text(resumed), '=> "did:c"');
		} finally {
			await ext.shutdown();
		}
	});

	it("carries a suspension across a simulated pi restart via details.state", async () => {
		const first = await loadExtension(
			{ bridgePiTools: false, toolStore: false, typeCheck: false, tools: [gated] },
			workspace,
		);
		let suspendedDetails: ToolResult["details"];
		try {
			await first.execute({ code: "prefix = 'kept'" });
			const suspended = await first.execute(
				{ code: "r = mutate('later')\nf'{prefix}:{r}'" },
				{ hasUI: true, ui: { select: async () => APPROVAL_CHOICES.suspend, notify: () => {} } },
			);
			assert.equal(suspended.details.status, "suspended");
			assert.ok(suspended.details.state.length > 0);
			suspendedDetails = suspended.details;
		} finally {
			await first.shutdown();
		}

		// "Restart": a fresh extension instance restores from the branch history.
		const second = await loadExtension(
			{ bridgePiTools: false, toolStore: false, typeCheck: false, tools: [gated] },
			workspace,
		);
		try {
			second.emitSessionStart([
				{ type: "message", message: { toolName: "code", details: suspendedDetails } },
			]);
			const resumed = await second.execute(
				{ resume: true },
				{ hasUI: true, ui: { select: async () => APPROVAL_CHOICES.approve, notify: () => {} } },
			);
			assert.equal(text(resumed), '=> "kept:did:later"', `resume after restart failed: ${text(resumed)}`);
		} finally {
			await second.shutdown();
		}
	});

	it("persists a suspension whose gated call has BigInt args (regression)", async () => {
		const ext = await loadExtension(
			{ bridgePiTools: false, toolStore: false, typeCheck: false, tools: [gated] },
			workspace,
		);
		try {
			const suspended = await ext.execute(
				{ code: "mutate(2 ** 70)" },
				{ hasUI: true, ui: { select: async () => APPROVAL_CHOICES.suspend, notify: () => {} } },
			);
			assert.equal(suspended.details.status, "suspended");
			assert.ok(suspended.details.state.length > 0, "suspension state must serialize");
		} finally {
			await ext.shutdown();
		}
	});

	it("does not resurrect pre-reset state after a restart (regression)", async () => {
		const first = await loadExtension({ bridgePiTools: false, toolStore: false, typeCheck: false }, workspace);
		const branch: unknown[] = [];
		const record = (details: ToolResult["details"]) =>
			branch.push({ type: "message", message: { toolName: "code", details } });
		try {
			record((await first.execute({ code: "x = 1" })).details);
			record((await first.execute({ reset: true })).details);
		} finally {
			await first.shutdown();
		}

		const second = await loadExtension({ bridgePiTools: false, toolStore: false, typeCheck: false }, workspace);
		try {
			second.emitSessionStart(branch);
			const result = await second.execute({ code: "x" });
			assert.ok(text(result).includes("NameError"), `reset must survive a restart, got: ${text(result)}`);
		} finally {
			await second.shutdown();
		}
	});

	it("clears the restored-state hint after a reset (regression)", async () => {
		const first = await loadExtension({ bridgePiTools: false, toolStore: false, typeCheck: false }, workspace);
		let details: ToolResult["details"];
		try {
			details = (await first.execute({ code: "x = 1" })).details;
		} finally {
			await first.shutdown();
		}

		const second = await loadExtension({ bridgePiTools: false, toolStore: false, typeCheck: false }, workspace);
		try {
			second.emitSessionStart([{ type: "message", message: { toolName: "code", details } }]);
			await second.execute({ reset: true });
			const errored = await second.execute({ code: "1 / 0" });
			assert.ok(!text(errored).includes("restored from an earlier conversation"), text(errored));
		} finally {
			await second.shutdown();
		}
	});

	it("honors autoApprove for headless runs", async () => {
		const ext = await loadExtension(
			{ bridgePiTools: false, toolStore: false, typeCheck: false, tools: [gated], autoApprove: true },
			workspace,
		);
		try {
			assert.equal(text(await ext.execute({ code: "mutate('auto')" })), '=> "did:auto"');
		} finally {
			await ext.shutdown();
		}
	});
});

describe("pi tool bridge", () => {
	it("exposes pi's read-only tools as Python functions", async () => {
		const ext = await loadExtension({ toolStore: false, typeCheck: false }, workspace);
		try {
			assert.ok(ext.description.includes("def read("));
			assert.ok(ext.description.includes("def bash("));
			const result = await ext.execute({ code: "content = read('data.json')\n'42' in content" });
			assert.equal(text(result), "=> True", `bridged read failed: ${text(result)}`);
		} finally {
			await ext.shutdown();
		}
	});
});

describe("saved tools", () => {
	it("save_tool validates and persists; saved tools auto-load after reset", async () => {
		const storeDir = await mkdtemp(join(tmpdir(), "pi-code-mode-store-"));
		// Default typeCheck (true): validation type-checks candidates, which is
		// what catches functions leaning on session-local names.
		const ext = await loadExtension({ bridgePiTools: false, toolStore: storeDir }, workspace);
		try {
			// Rejected: not self-contained (references a session-local variable).
			const bad = await ext.execute({
				code: "session_only = 1\nsave_tool('leaky', 'def leaky():\\n    return session_only', 'bad')",
			});
			assert.ok(text(bad).includes("self-contained") || text(bad).includes("fresh session"), text(bad));

			const good = await ext.execute({
				code: "save_tool('quadruple', 'def quadruple(v):\\n    return v * 4', 'Multiply by four.')",
			});
			assert.ok(text(good).includes("Saved tool"), text(good));

			// After reset, the saved tool auto-loads as a prelude.
			await ext.execute({ reset: true });
			assert.equal(text(await ext.execute({ code: "quadruple(10)" })), "=> 40");
		} finally {
			await ext.shutdown();
			await rm(storeDir, { recursive: true, force: true });
		}
	});
});

describe("reset command", () => {
	it("registers a working /code-reset command", async () => {
		const ext = await loadExtension({ bridgePiTools: false, toolStore: false, typeCheck: false }, workspace);
		try {
			await ext.execute({ code: "v = 9" });
			const handler = ext.commands.get("code-reset");
			assert.ok(handler, "code-reset command not registered");
			let notified = "";
			await handler("", {
				hasUI: true,
				ui: { select: async () => undefined, notify: (m: string) => (notified = m) },
				sessionManager: { getBranch: () => [] },
			});
			assert.ok(notified.includes("cleared"));
			assert.ok(text(await ext.execute({ code: "v" })).includes("NameError"));
		} finally {
			await ext.shutdown();
		}
	});
});
