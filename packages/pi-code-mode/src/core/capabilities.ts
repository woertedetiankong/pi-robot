/**
 * Empirical capability probing. The prompt promises the model an exact
 * import list and the type checker enforces tool stubs — both are probed
 * against the installed monty at startup rather than hardcoded, so they stay
 * truthful across monty upgrades.
 */
import { type Monty, MontyTypingError } from "@pydantic/monty";
import { renderTypeStub, renderUncheckedStub, type ToolRegistry } from "./registry.ts";

/** Stdlib modules worth probing — common agent-code imports. */
const CANDIDATE_MODULES = [
	"json",
	"re",
	"datetime",
	"math",
	"os",
	"sys",
	"typing",
	"asyncio",
	"pathlib",
	"time",
	"random",
	"collections",
	"itertools",
	"functools",
	"string",
	"textwrap",
	"base64",
	"hashlib",
	"statistics",
	"io",
	"copy",
	"enum",
	"dataclasses",
	"uuid",
	"csv",
	"unicodedata",
	"urllib",
];

/**
 * Determines which modules the installed monty can import by trying each in
 * one throwaway session (a single worker round trip for the whole list).
 */
export async function probeImportableModules(pool: Monty, candidates: string[] = CANDIDATE_MODULES): Promise<string[]> {
	const code = [
		"_ok = []",
		...candidates.map((name) =>
			[`try:`, `    import ${name}`, `    _ok.append('${name}')`, `except Exception:`, `    pass`].join("\n"),
		),
		"_ok",
	].join("\n");
	const session = await pool.checkout();
	try {
		const result = await session.feedRun(code);
		return Array.isArray(result) ? result.map(String) : [];
	} finally {
		await session.close();
	}
}

/**
 * Runtime names monty's bundled type checker historically didn't know.
 * Each is probed before being declared, so the workaround self-prunes once
 * ty learns a name.
 */
const TY_GAP_CANDIDATES = [
	"open",
	"bytearray",
	"PermissionError",
	"FileNotFoundError",
	"IsADirectoryError",
	"NotADirectoryError",
];

/** Cache of stub-text → passes-ty, so repeated extension loads skip probing. */
const stubValidityCache = new Map<string, boolean>();

/**
 * Assembles the typeCheckStubs text for a session: `Any` declarations for
 * names ty can't resolve, plus a validated stub per registered tool. A tool
 * whose param/return strings aren't real type expressions degrades to an
 * unchecked `name: Any = None` declaration instead of poisoning every run.
 */
export async function buildTypeCheckStubs(pool: Monty, registry: ToolRegistry): Promise<string> {
	const parts: string[] = ["from typing import Any"];

	for (const name of TY_GAP_CANDIDATES) {
		if (!(await checksClean(pool, "", `_gap = ${name}\nNone`, { [name]: null }))) {
			parts.push(`${name}: Any = None`);
		}
	}

	for (const tool of registry.list()) {
		const stub = renderTypeStub(tool);
		let valid = stubValidityCache.get(stub);
		if (valid === undefined) {
			// Reference the tool by name under its stub: ty rejecting the
			// reference (or the stub itself) means the stub is unusable.
			valid = await checksClean(pool, `from typing import Any\n${stub}`, `_probe = ${tool.name}\nNone`, {
				[tool.name]: () => null,
			});
			stubValidityCache.set(stub, valid);
		}
		parts.push(valid ? stub : renderUncheckedStub(tool));
	}

	return parts.join("\n\n");
}

/** True when `code` passes ty under `stubs` (runtime errors don't count against it). */
async function checksClean(
	pool: Monty,
	stubs: string,
	code: string,
	externalLookup: Record<string, unknown>,
): Promise<boolean> {
	const session = await pool.checkout({ typeCheck: true, typeCheckStubs: stubs });
	try {
		await session.feedRun(code, { externalLookup });
		return true;
	} catch (err) {
		if (err instanceof MontyTypingError) return false;
		// Runtime failures (e.g. NameError for a genuinely missing builtin)
		// mean ty was satisfied — which is all this probe measures.
		return true;
	} finally {
		await session.close();
	}
}
