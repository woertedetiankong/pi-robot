/**
 * Agent-built reusable tools, stored as plain Python files in a directory
 * (one `<name>.py` per tool, first line `# <description>`). User-inspectable
 * and -editable. `hostTools()` exposes save/delete/list/read to the sandbox
 * so the agent grows its own toolbox; saved code is fed into brand-new
 * sessions as a prelude (see CodeSession.prelude).
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HostToolError } from "./types.ts";
import type { HostTool } from "./types.ts";
import type { PreludeSnippet } from "./session.ts";

export interface SavedTool {
	name: string;
	description: string;
	code: string;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;

export class ToolStore {
	readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	async list(): Promise<SavedTool[]> {
		let files: string[];
		try {
			files = await readdir(this.dir);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw e;
		}
		const tools: SavedTool[] = [];
		for (const file of files.filter((f) => f.endsWith(".py")).sort()) {
			const name = file.slice(0, -3);
			if (!IDENTIFIER.test(name)) continue;
			tools.push(parseToolFile(name, await readFile(join(this.dir, file), "utf8")));
		}
		return tools;
	}

	async get(name: string): Promise<SavedTool | undefined> {
		if (!IDENTIFIER.test(name)) return undefined;
		try {
			return parseToolFile(name, await readFile(join(this.dir, `${name}.py`), "utf8"));
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw e;
		}
	}

	/** Writes a tool; overwriting an existing tool is allowed. Callers validate first. */
	async save(name: string, code: string, description: string): Promise<void> {
		if (!IDENTIFIER.test(name)) {
			throw new HostToolError(`'${name}' is not a valid Python identifier`, "ValueError");
		}
		if (!new RegExp(`(^|\\n)def\\s+${name}\\s*\\(`).test(code)) {
			throw new HostToolError(`code must define a function named '${name}'`, "ValueError");
		}
		await mkdir(this.dir, { recursive: true });
		const header = `# ${description.replace(/\s*\n\s*/g, " ").trim()}\n`;
		await writeFile(join(this.dir, `${name}.py`), header + code.replace(/\n*$/, "\n"));
	}

	async delete(name: string): Promise<boolean> {
		if (!IDENTIFIER.test(name)) return false;
		try {
			await rm(join(this.dir, `${name}.py`));
			return true;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw e;
		}
	}

	/** Saved snippets in prelude form, for CodeSession's dependency-tolerant loader. */
	async prelude(): Promise<PreludeSnippet[]> {
		return (await this.list()).map((t) => ({ name: t.name, code: t.code }));
	}

	/** One line per saved tool, for the prompt's "Saved tools" section. */
	async renderSummary(): Promise<string> {
		return (await this.list()).map((t) => `- ${t.name}: ${t.description}`).join("\n");
	}

	/**
	 * Host tools that let the sandboxed code manage the store.
	 * `isReserved` guards against shadowing real host tools. `validate` runs
	 * the candidate code in isolation (a fresh session with only saved tools
	 * loaded) and returns an error string when it can't stand alone —
	 * catching code that leans on session-local imports or variables that
	 * won't exist next session.
	 */
	hostTools(isReserved: (name: string) => boolean, validate?: (code: string) => Promise<string | null>): HostTool[] {
		const saveTool: HostTool = {
			name: "save_tool",
			description:
				"Save a Python function as a reusable tool for future sessions. The code must " +
				"define a function with the given name and be self-contained (its own imports). " +
				"Saved tools auto-load into new sessions; to use the function right now, also " +
				"define it normally. Overwrites any existing tool with that name.",
			params: [
				{ name: "name", type: "str", description: "Tool name (Python identifier)." },
				{ name: "code", type: "str", description: "Python source defining the function." },
				{ name: "description", type: "str", description: "One line: what it does, args, returns." },
			],
			returns: "str",
			returnsDescription: "confirmation string naming the saved tool",
			execute: async (args, kwargs) => {
				const name = requireString(argAt(args, kwargs, 0, "name"), "name");
				const code = requireString(argAt(args, kwargs, 1, "code"), "code");
				const description = requireString(argAt(args, kwargs, 2, "description"), "description");
				if (isReserved(name)) {
					throw new HostToolError(`'${name}' is a built-in tool name and cannot be replaced`, "ValueError");
				}
				if (validate) {
					const problem = await validate(code);
					if (problem !== null) {
						throw new HostToolError(
							`the code does not work in a fresh session (${problem}); make it ` +
								"self-contained — include any imports it needs inside the code",
							"ValueError",
						);
					}
				}
				await this.save(name, code, description);
				return `Saved tool '${name}'. It loads automatically in new sessions.`;
			},
		};

		const deleteTool: HostTool = {
			name: "delete_tool",
			description: "Delete a previously saved tool.",
			params: [{ name: "name", type: "str" }],
			returns: "str",
			returnsDescription: "confirmation string naming the deleted tool",
			execute: async (args, kwargs) => {
				const name = requireString(argAt(args, kwargs, 0, "name"), "name");
				if (!(await this.delete(name))) {
					throw new HostToolError(`no saved tool named '${name}'`, "KeyError");
				}
				return `Deleted tool '${name}'.`;
			},
		};

		const listTools: HostTool = {
			name: "list_saved_tools",
			description: "List saved tools.",
			params: [],
			returns: "list[dict]",
			returnsDescription: 'dicts with keys "name" and "description"',
			execute: async () => (await this.list()).map((t) => ({ name: t.name, description: t.description })),
		};

		const readTool: HostTool = {
			name: "read_tool",
			description: "Read the source code of a saved tool.",
			params: [{ name: "name", type: "str" }],
			returns: "str",
			returnsDescription: "Python source code for the saved tool, excluding the description header",
			execute: async (args, kwargs) => {
				const name = requireString(argAt(args, kwargs, 0, "name"), "name");
				const tool = await this.get(name);
				if (!tool) throw new HostToolError(`no saved tool named '${name}'`, "KeyError");
				return tool.code;
			},
		};

		return [saveTool, deleteTool, listTools, readTool];
	}
}

function parseToolFile(name: string, content: string): SavedTool {
	const firstLine = content.split("\n", 1)[0] ?? "";
	const hasHeader = firstLine.startsWith("# ");
	return {
		name,
		description: hasHeader ? firstLine.slice(2).trim() : "",
		code: hasHeader ? content.slice(firstLine.length + 1) : content,
	};
}

/** Positional-or-keyword argument extraction with Python-flavored errors. */
export function argAt(args: unknown[], kwargs: Record<string, unknown>, index: number, name: string): unknown {
	if (index < args.length) {
		if (name in kwargs) throw new HostToolError(`got multiple values for argument '${name}'`, "TypeError");
		return args[index];
	}
	return kwargs[name];
}

export function requireString(value: unknown, name: string): string {
	if (typeof value !== "string") {
		throw new HostToolError(`argument '${name}' must be a string`, "TypeError");
	}
	return value;
}
