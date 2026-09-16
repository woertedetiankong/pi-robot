/** Builtin host tools: path-escape safety and the http_get deadline. */
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createBuiltinTools } from "../src/core/builtins.ts";
import { HostToolError } from "../src/core/types.ts";
import type { HostTool } from "../src/core/types.ts";

let root: string;
let outside: string;
before(async () => {
	root = await mkdtemp(join(tmpdir(), "pcm-builtins-root-"));
	outside = await mkdtemp(join(tmpdir(), "pcm-builtins-outside-"));
	await writeFile(join(root, "inside.txt"), "inside");
	await writeFile(join(outside, "secret.txt"), "secret");
	// Windows directory junctions need no symlink privilege and exercise the
	// same realpath escape check as a directory symlink on POSIX.
	await symlink(outside, join(root, "sneaky"), process.platform === "win32" ? "junction" : "dir");
});
after(async () => {
	await rm(root, { recursive: true, force: true });
	await rm(outside, { recursive: true, force: true });
});

function tool(name: string, options: Parameters<typeof createBuiltinTools>[0]): HostTool {
	const found = createBuiltinTools(options).find((t) => t.name === name);
	assert.ok(found, `${name} not found`);
	return found;
}

describe("read_file path safety", () => {
	it("reads inside the root and blocks absolute, traversal, and symlink escapes", async () => {
		const readFile = tool("read_file", { root });
		assert.equal(await readFile.execute(["inside.txt"], {}), "inside");
		for (const path of ["/etc/passwd", "../" + "secret.txt", "sneaky/secret.txt"]) {
			await assert.rejects(
				async () => readFile.execute([path], {}),
				(err: unknown) => err instanceof HostToolError && err.pythonType === "PermissionError",
				`expected PermissionError for ${path}`,
			);
		}
	});

	it("accepts the virtual /workspace prefix when virtualRoot is set", async () => {
		const readFile = tool("read_file", { root, virtualRoot: "/workspace" });
		assert.equal(await readFile.execute(["/workspace/inside.txt"], {}), "inside");
		const listFiles = tool("list_files", { root, virtualRoot: "/workspace" });
		const entries = (await listFiles.execute(["/workspace"], {})) as string[];
		assert.ok(Array.isArray(entries) && entries.includes("inside.txt"));
		// Symlink/junction escapes still blocked through the prefixed spelling.
		await assert.rejects(
			async () => readFile.execute(["/workspace/sneaky/secret.txt"], {}),
			(err: unknown) => err instanceof HostToolError && err.pythonType === "PermissionError",
		);
	});

	it("still rejects absolute paths without virtualRoot, and other absolutes with it", async () => {
		const plain = tool("read_file", { root });
		await assert.rejects(
			async () => plain.execute(["/workspace/inside.txt"], {}),
			(err: unknown) => err instanceof HostToolError && err.pythonType === "PermissionError",
		);
		const prefixed = tool("read_file", { root, virtualRoot: "/workspace" });
		await assert.rejects(
			async () => prefixed.execute(["/etc/passwd"], {}),
			(err: unknown) => err instanceof HostToolError && err.pythonType === "PermissionError",
		);
	});
});

describe("http_get deadline", () => {
	it("times out hung requests with a TimeoutError (regression)", async () => {
		const hangingFetch: typeof fetch = (_url, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new Error("socket hang up")));
			});
		const httpGet = tool("http_get", { root, httpTimeoutMs: 50, fetchImpl: hangingFetch });
		await assert.rejects(
			async () => httpGet.execute(["https://example.invalid/slow"], {}),
			(err: unknown) =>
				err instanceof HostToolError && err.pythonType === "TimeoutError" && err.message.includes("timed out"),
		);
	});

	it("honors the run's abort signal", async () => {
		const hangingFetch: typeof fetch = (_url, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
			});
		const httpGet = tool("http_get", { root, httpTimeoutMs: 60_000, fetchImpl: hangingFetch });
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);
		await assert.rejects(
			async () => httpGet.execute(["https://example.invalid/slow"], {}, controller.signal),
			(err: unknown) => err instanceof HostToolError && err.message.includes("aborted"),
		);
	});
});
