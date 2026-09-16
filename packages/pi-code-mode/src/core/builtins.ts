/**
 * Starter host tools: read_file / list_files (rooted, escape-proof) and
 * http_get (host-side fetch — the sandbox itself has no network access).
 */
import { open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { stripVirtualRoot } from "./paths.ts";
import { argAt, requireString } from "./store.ts";
import { HostToolError } from "./types.ts";
import type { HostTool } from "./types.ts";

export interface BuiltinToolsOptions {
	/** Workspace root; file tools cannot escape it. */
	root: string;
	/** Virtual workspace prefix accepted in paths and stripped before resolution (e.g. "/workspace" when the read-only mount is enabled). Default: none. */
	virtualRoot?: string;
	/** Include the read_file tool. Disable when a workspace mount replaces it. Default true. */
	readFile?: boolean;
	/** Include the list_files tool. Disable when pi's bridged `ls` replaces it. Default true. */
	listFiles?: boolean;
	/** Cap on returned file bytes; longer files are truncated. Default 256 KiB. */
	maxFileBytes?: number;
	/** Cap on returned HTTP body bytes. Default 256 KiB. */
	maxHttpBytes?: number;
	/** Deadline for http_get in milliseconds (headers + body). Default 30 000. */
	httpTimeoutMs?: number;
	/** Injectable fetch (tests). Default: global fetch. */
	fetchImpl?: typeof fetch;
}

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const TRUNCATION_MARKER = "\n[...truncated]";

export function createBuiltinTools(options: BuiltinToolsOptions): HostTool[] {
	const root = resolve(options.root);
	const virtualRoot = options.virtualRoot;
	const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_BYTES;
	const maxHttpBytes = options.maxHttpBytes ?? DEFAULT_MAX_BYTES;
	const httpTimeoutMs = options.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
	const fetchImpl = options.fetchImpl ?? fetch;

	// Resolves a workspace-relative path and rejects anything outside the
	// root, including symlink escapes. Paths carrying the sandbox's virtual
	// workspace prefix ("/workspace/...") are normalized first, so helpers
	// accept the same spelling the read-only mount exposes for reads.
	async function resolveInRoot(input: string): Promise<string> {
		const relPath = virtualRoot ? stripVirtualRoot(input, virtualRoot) : input;
		if (isAbsolute(relPath)) {
			throw new HostToolError(`absolute paths are not allowed: '${input}'`, "PermissionError");
		}
		const resolved = resolve(root, relPath);
		if (resolved !== root && !resolved.startsWith(root + sep)) {
			throw new HostToolError(`path escapes the workspace root: '${input}'`, "PermissionError");
		}
		let real: string;
		try {
			real = await realpath(resolved);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") {
				throw new HostToolError(`no such file or directory: '${relPath}'`, "FileNotFoundError");
			}
			throw new HostToolError(String((e as Error).message), "OSError");
		}
		const realRoot = await realpath(root);
		if (real !== realRoot && !real.startsWith(realRoot + sep)) {
			throw new HostToolError(`path escapes the workspace root: '${relPath}'`, "PermissionError");
		}
		return real;
	}

	const readFileTool: HostTool = {
		name: "read_file",
		description: "Read a UTF-8 text file from the workspace.",
		params: [{ name: "path", type: "str", description: "Path relative to the workspace root." }],
		returns: "str",
		returnsDescription: `the file text, truncated with '[...truncated]' beyond ${maxFileBytes} bytes`,
		async execute(args, kwargs) {
			const path = requireString(argAt(args, kwargs, 0, "path"), "path");
			const real = await resolveInRoot(path);
			try {
				return await readUtf8FileLimited(real, maxFileBytes);
			} catch (e) {
				const err = e as NodeJS.ErrnoException;
				if (err.code === "EISDIR") {
					throw new HostToolError(`is a directory: '${path}'`, "IsADirectoryError");
				}
				throw new HostToolError(err.message, "OSError");
			}
		},
	};

	const listFilesTool: HostTool = {
		name: "list_files",
		description: 'List directory entries in the workspace. Directories end with "/".',
		params: [
			{ name: "path", type: "str", description: "Directory path relative to the workspace root.", optional: true },
		],
		returns: "list[str]",
		returnsDescription: 'sorted entry names; subdirectories have a trailing "/"',
		async execute(args, kwargs) {
			const raw = argAt(args, kwargs, 0, "path") ?? ".";
			const path = requireString(raw, "path");
			const real = await resolveInRoot(path);
			try {
				const entries = await readdir(real, { withFileTypes: true });
				return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
			} catch (e) {
				const err = e as NodeJS.ErrnoException;
				if (err.code === "ENOTDIR") {
					throw new HostToolError(`not a directory: '${path}'`, "NotADirectoryError");
				}
				throw new HostToolError(err.message, "OSError");
			}
		},
	};

	const httpGetTool: HostTool = {
		name: "http_get",
		description: "HTTP GET a URL and return the response body as text.",
		params: [{ name: "url", type: "str", description: "An http:// or https:// URL." }],
		returns: "str",
		returnsDescription: `the response body, truncated with '[...truncated]' beyond ${maxHttpBytes} bytes`,
		async execute(args, kwargs, signal) {
			const url = requireString(argAt(args, kwargs, 0, "url"), "url");
			if (!/^https?:\/\//i.test(url)) {
				throw new HostToolError(`only http(s) URLs are allowed: '${url}'`, "ValueError");
			}
			// The sandbox watchdog cannot see host-side work, so http_get
			// enforces its own deadline; the run's abort signal composes in.
			// A plain ref'ed timer, not AbortSignal.timeout(): the latter is
			// unref'ed and never fires once the event loop drains.
			const deadline = new AbortController();
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				deadline.abort();
			}, httpTimeoutMs);
			const combined = signal ? AbortSignal.any([deadline.signal, signal]) : deadline.signal;
			try {
				const response = await fetchImpl(url, { signal: combined });
				if (!response.ok) {
					throw new HostToolError(`HTTP ${response.status} for ${url}`, "OSError");
				}
				return await readResponseTextLimited(response, maxHttpBytes);
			} catch (e) {
				if (e instanceof HostToolError) throw e;
				if (timedOut) {
					throw new HostToolError(`request timed out after ${httpTimeoutMs / 1000}s: ${url}`, "TimeoutError");
				}
				if (signal?.aborted) {
					throw new HostToolError(`request aborted: ${url}`, "OSError");
				}
				throw new HostToolError(`request failed: ${(e as Error).message}`, "OSError");
			} finally {
				clearTimeout(timer);
			}
		},
	};

	const tools = [httpGetTool];
	if (options.listFiles ?? true) tools.unshift(listFilesTool);
	if (options.readFile ?? true) tools.unshift(readFileTool);
	return tools;
}

async function readUtf8FileLimited(path: string, maxBytes: number): Promise<string> {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(maxBytes + 1);
		const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
		const truncated = bytesRead > maxBytes;
		return buffer.subarray(0, truncated ? maxBytes : bytesRead).toString() + (truncated ? TRUNCATION_MARKER : "");
	} finally {
		await handle.close();
	}
}

async function readResponseTextLimited(response: Response, maxBytes: number): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return truncateBytes(await response.text(), maxBytes);

	const chunks: Uint8Array[] = [];
	let collected = 0;
	let truncated = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const chunk = value ?? new Uint8Array();
			const remaining = maxBytes - collected;
			if (chunk.byteLength > remaining) {
				if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
				truncated = true;
				break;
			}
			chunks.push(chunk);
			collected += chunk.byteLength;
			if (collected === maxBytes) {
				const next = await reader.read();
				truncated = !next.done;
				break;
			}
		}
	} finally {
		if (truncated) await reader.cancel().catch(() => {});
		reader.releaseLock();
	}

	return Buffer.concat(chunks).toString() + (truncated ? TRUNCATION_MARKER : "");
}

function truncateBytes(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text) <= maxBytes) return text;
	return Buffer.from(text).subarray(0, maxBytes).toString() + TRUNCATION_MARKER;
}
