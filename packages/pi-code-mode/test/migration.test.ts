import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, it } from "node:test";
import { Monty } from "@pydantic/monty";
import { MountDir } from "@pydantic/monty/node";
import { CodeSession, MONTY_VERSION } from "../src/core/session.ts";
import { ToolRegistry } from "../src/core/registry.ts";
import { probeImportableModules } from "../src/core/capabilities.ts";

let pool: Monty;
before(async () => { pool = await Monty.create({ requestTimeout: 5 }); });
after(async () => { await pool.close(); });

const tools = () => new ToolRegistry([{
	name: "ping", description: "Return one", params: [], returns: "int", execute: () => 1,
}]);

it("pins checkpoint metadata to the installed Monty version", async () => {
	const pkg = JSON.parse(await readFile(new URL("../node_modules/@pydantic/monty/package.json", import.meta.url), "utf8"));
	assert.equal(MONTY_VERSION, pkg.version);
});

it("renews suspension budgets between snippets and after exhaustion without replay", async () => {
	let effects = 0;
	const registry = tools();
	registry.add({ name: "effect", description: "Count", params: [], returns: "int", execute: () => ++effects });
	const session = new CodeSession({ pool, tools: registry, limits: { maxSuspensions: 4 } });
	try {
		for (let i = 0; i < 8; i++) assert.equal((await session.run("effect()")).status, "ok");
		assert.equal(effects, 8);
		const exhausted = await session.run("kept = 42\nfor i in range(20):\n    ping()");
		assert.equal(exhausted.status, "error");
		assert.match(exhausted.error, /suspension limit/);
		const next = await session.run("kept + ping()");
		assert.equal(next.status, "ok");
		assert.equal(next.output, 43);
		assert.equal(effects, 8);
	} finally { await session.close(); }
});

it("rejects legacy checkpoints and removed resource limits explicitly", () => {
	const session = new CodeSession({ pool, tools: tools() });
	assert.throws(() => session.restoreState({ v: 1, kind: "suspension", data: "AAAA" } as never), /incompatible Monty/);
	assert.equal(session.suspendedCall, null);
	assert.throws(() => new CodeSession({ pool, tools: tools(), limits: { maxAllocations: 10 } as never }), /maxAllocations was removed/);
});

it("discards a corrupt checkpoint without running code, then allows a fresh run", async () => {
	const session = new CodeSession({ pool, tools: tools() });
	try {
		session.restoreState({ v: 2, montyVersion: MONTY_VERSION, kind: "session", data: "AAAA" });
		const bad = await session.run("ping()");
		assert.equal(bad.status, "error");
		assert.match(bad.error, /checkpoint could not be restored/);
		assert.equal(bad.calls.length, 0);
		assert.equal(session.dumpState(), null);
		assert.equal((await session.run("ping()")).output, 1);
	} finally { await session.close(); }
});

it("releases read-only mount handles after success and runtime failure", async () => {
	const root = await mkdtemp(join(tmpdir(), "pcm-mount-migration-"));
	let hostPath = join(root, "data");
	const { mkdir } = await import("node:fs/promises");
	await mkdir(hostPath);
	await writeFile(join(hostPath, "value.txt"), "42");
	const session = new CodeSession({ pool, tools: tools(), makeMount: () => new MountDir({ hostPath, virtualPath: "/workspace", mode: "read-only" }) });
	try {
		assert.equal((await session.run("open('/workspace/value.txt').read()")).output, "42");
		await rename(hostPath, join(root, "moved"));
		hostPath = join(root, "moved");
		const denied = await session.run("open('/workspace/value.txt', 'w').write('bad')");
		assert.equal(denied.status, "error");
		assert.match(denied.error, /PermissionError/);
		await rename(hostPath, join(root, "final"));
		assert.equal(await readFile(join(root, "final", "value.txt"), "utf8"), "42");
	} finally { await session.close(); await rm(root, { recursive: true, force: true }); }
});

it("discovers newly supported standard-library modules", async () => {
	const modules = await probeImportableModules(pool);
	for (const name of ["unicodedata", "collections", "itertools", "functools", "base64"]) assert.ok(modules.includes(name), name);
});

it("bounds streamed output while retaining the prefix of a large print batch", async () => {
	const session = new CodeSession({ pool, tools: tools() });
	let streamed = "";
	try {
		const result = await session.run("print('你好' * 10000)", { maxStdoutBytes: 7, onPrint: (chunk) => { streamed += chunk; } });
		assert.equal(result.status, "ok");
		assert.equal(result.stdout, "你好");
		assert.equal(streamed, result.stdout);
		assert.equal(result.stdoutTruncated, true);
	} finally { await session.close(); }
});

it("remounts a suspended script and preserves completed host effects", async () => {
	const root = await mkdtemp(join(tmpdir(), "pcm-suspended-mount-"));
	let hostPath = join(root, "data");
	const { mkdir } = await import("node:fs/promises");
	await mkdir(hostPath);
	await writeFile(join(hostPath, "value.txt"), "42");
	let effects = 0;
	const registry = tools();
	registry.add({ name: "change", description: "Count", params: [], returns: "int", requiresApproval: true, execute: () => ++effects });
	const session = new CodeSession({ pool, tools: registry, makeMount: () => new MountDir({ hostPath, virtualPath: "/workspace", mode: "read-only" }) });
	let approvals = 0;
	try {
		const paused = await session.run("a = open('/workspace/value.txt').read()\nchange()\nchange()\na + open('/workspace/value.txt').read()", {
			onApproval: () => ++approvals === 1 ? true : "suspend",
		});
		assert.equal(paused.status, "suspended");
		assert.equal(effects, 1);
		await rename(hostPath, join(root, "moved"));
		hostPath = join(root, "moved");
		const resumed = await session.resume({ onApproval: () => true });
		assert.equal(resumed.status, "ok");
		assert.equal(resumed.output, "4242");
		assert.equal(effects, 2);
	} finally { await session.close(); await rm(root, { recursive: true, force: true }); }
});
