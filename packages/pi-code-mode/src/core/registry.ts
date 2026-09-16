/**
 * Holds host tools and renders the two Python views of them: prompt stubs
 * (docstring'd function signatures the model reads) and type stubs (enforced
 * pre-execution by monty's bundled `ty` when type checking is on).
 */
import type { HostTool, HostToolParam } from "./types.ts";

export class ToolRegistry {
	private readonly tools = new Map<string, HostTool>();

	constructor(tools: HostTool[] = []) {
		for (const tool of tools) this.add(tool);
	}

	add(tool: HostTool): void {
		if (!/^[a-z_][a-z0-9_]*$/i.test(tool.name)) {
			throw new Error(`Tool name '${tool.name}' is not a valid Python identifier`);
		}
		if (this.tools.has(tool.name)) {
			throw new Error(`Tool '${tool.name}' is already registered`);
		}
		this.tools.set(tool.name, tool);
	}

	get(name: string): HostTool | undefined {
		return this.tools.get(name);
	}

	has(name: string): boolean {
		return this.tools.has(name);
	}

	list(): HostTool[] {
		return [...this.tools.values()];
	}

	/** Python stubs for every registered tool, for the tool description / prompt. */
	renderStubs(): string {
		return this.list().map(renderToolStub).join("\n\n");
	}
}

function renderParams(tool: HostTool, optionalSuffix: (p: HostToolParam) => string): string {
	return tool.params.map((p) => `${p.name}: ${p.type}${p.optional ? optionalSuffix(p) : ""}`).join(", ");
}

/**
 * Renders one tool as a Python function stub with a docstring:
 *
 *     def read_file(path: str) -> str:
 *         """Read a text file.
 *
 *         Args:
 *             path: Path relative to the workspace root.
 *         """
 */
export function renderToolStub(tool: HostTool): string {
	const params = renderParams(tool, () => " = ...");

	const doc: string[] = [tool.description.trim()];
	const described = tool.params.filter((p) => p.description);
	if (described.length > 0) {
		doc.push("", "Args:");
		for (const p of described) doc.push(`    ${p.name}: ${p.description}`);
	}
	if (tool.returnsDescription) {
		doc.push("", "Returns:", `    ${tool.returns}: ${tool.returnsDescription}`);
	}

	const body = doc.length === 1 ? `"""${doc[0]}"""` : `"""${doc.join("\n")}\n"""`;
	const indented = body
		.split("\n")
		.map((line) => (line === "" ? "" : `    ${line}`))
		.join("\n");
	return `def ${tool.name}(${params}) -> ${tool.returns}:\n${indented}`;
}

/**
 * The type-checker stub for one tool. Bodies must raise (`...` bodies trip
 * ty's empty-body rule) and optional params default to None (`= ...` is only
 * legal in .pyi files). Validated against ty by buildTypeCheckStubs(); a
 * stub ty can't parse degrades to an unchecked `name: Any = None`.
 */
export function renderTypeStub(tool: HostTool): string {
	const params = renderParams(tool, () => " | None = None");
	return `def ${tool.name}(${params}) -> ${tool.returns}:\n    raise NotImplementedError`;
}

/** The unchecked fallback declaration for a tool whose stub ty rejects. */
export function renderUncheckedStub(tool: HostTool): string {
	return `${tool.name}: "Any" = None`;
}

/**
 * Ground rules for the model writing sandboxed Python, reflecting monty
 * 0.0.23 behavior. Pass the result of `probeImportableModules()` so the
 * import list reflects the installed interpreter rather than a guess.
 */
export function renderPythonToolRules(importableModules: string[]): string {
	const blocked = ["time", "random", "collections", "requests", "numpy"].filter(
		(m) => !importableModules.includes(m),
	);
	return `\
- Call tools as plain functions, WITHOUT \`await\`.
- Use print() to surface anything you need to see; printed output is returned to you.
- The value of the last top-level expression is returned as the result (expressions
  inside if/try blocks are not).
- Imports: ONLY these modules exist: ${importableModules.join(", ")}. Anything else
  (e.g. ${blocked.join(", ")}) raises ModuleNotFoundError — there are no third-party
  packages.
- Classes, function decorators, dataclasses and some dunder protocols work.
  Python support is partial; do not assume all CPython protocols are implemented.
  Class inheritance and match statements are not supported.
- Tool failures raise normal Python exceptions you can catch (e.g. ValueError,
  FileNotFoundError, OSError).`;
}
