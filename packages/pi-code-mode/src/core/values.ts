/**
 * Value conversion between the monty sandbox and host tools.
 *
 * Monty hands sandbox values to JS as: dicts → Map, sets → Set, tuples →
 * Array tagged with a non-enumerable __tuple__, big ints → BigInt, bytes →
 * Buffer. Host tools want idiomatic JS, and the model wants Python-ish
 * reprs — both conversions live here.
 */

/**
 * Normalize a sandbox value for host-tool consumption: string-keyed Maps
 * become plain objects, tuples become plain arrays, safe BigInts become
 * numbers. Non-string-keyed Maps and Sets pass through unchanged (there is
 * no faithful plain-JS equivalent). Sandbox values are acyclic by
 * construction, so plain recursion is safe.
 */
export function toHostValue(value: unknown): unknown {
	if (typeof value === "bigint") {
		return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
	}
	if (Array.isArray(value)) return value.map(toHostValue);
	if (value instanceof Map) {
		if ([...value.keys()].every((k) => typeof k === "string")) {
			return Object.fromEntries([...value].map(([k, v]) => [k, toHostValue(v)]));
		}
		return new Map([...value].map(([k, v]) => [toHostValue(k), toHostValue(v)]));
	}
	if (value instanceof Set) return new Set([...value].map(toHostValue));
	return value;
}

/** Cap for nested collection rendering, so a huge structure can't flood the prompt. */
const MAX_REPR_DEPTH = 8;

/**
 * Render a sandbox result value in Python-ish notation for the model.
 * Strings are quoted (repr-style); None/True/False use Python spelling.
 */
export function pyRepr(value: unknown, depth = 0): string {
	if (value === null || value === undefined) return "None";
	if (typeof value === "boolean") return value ? "True" : "False";
	if (typeof value === "number") {
		if (Number.isNaN(value)) return "nan";
		if (value === Infinity) return "inf";
		if (value === -Infinity) return "-inf";
		return String(value);
	}
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "string") return JSON.stringify(value);
	if (value instanceof Uint8Array) return `<bytes, ${value.length} bytes>`;
	if (depth >= MAX_REPR_DEPTH) return "…";
	if (Array.isArray(value)) {
		const items = value.map((v) => pyRepr(v, depth + 1)).join(", ");
		const isTuple = (value as { __tuple__?: boolean }).__tuple__ === true;
		return isTuple ? `(${items}${value.length === 1 ? "," : ""})` : `[${items}]`;
	}
	if (value instanceof Map) {
		if (value.size === 0) return "{}";
		return `{${[...value].map(([k, v]) => `${pyRepr(k, depth + 1)}: ${pyRepr(v, depth + 1)}`).join(", ")}}`;
	}
	if (value instanceof Set) {
		if (value.size === 0) return "set()";
		return `{${[...value].map((v) => pyRepr(v, depth + 1)).join(", ")}}`;
	}
	if (typeof value === "object") {
		const marker = (value as { __monty_type__?: string }).__monty_type__;
		if (typeof marker === "string") {
			const entries = Object.entries(value as Record<string, unknown>).filter(([k]) => k !== "__monty_type__");
			return `${marker}(${entries.map(([k, v]) => `${k}=${pyRepr(v, depth + 1)}`).join(", ")})`;
		}
		return `{${Object.entries(value as Record<string, unknown>)
			.map(([k, v]) => `${JSON.stringify(k)}: ${pyRepr(v, depth + 1)}`)
			.join(", ")}}`;
	}
	return String(value);
}

/**
 * Convert a host value into something JSON.stringify can round-trip losslessly
 * enough for display: BigInt → number/string, Map → object or pair-array,
 * Set → array, bytes → a placeholder string. Used for the persisted copy of an
 * approval request, which is display-only after restore (resume() rebuilds the
 * live request from the restored snapshot's own args).
 */
export function jsonSafe(value: unknown): unknown {
	if (typeof value === "bigint") {
		return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
			? Number(value)
			: value.toString();
	}
	if (typeof value === "symbol" || typeof value === "function") return String(value);
	if (value instanceof Uint8Array) return `<bytes, ${value.length} bytes>`;
	if (Array.isArray(value)) return value.map(jsonSafe);
	if (value instanceof Map) {
		if ([...value.keys()].every((k) => typeof k === "string")) {
			return Object.fromEntries([...value].map(([k, v]) => [k, jsonSafe(v)]));
		}
		return [...value].map(([k, v]) => [jsonSafe(k), jsonSafe(v)]);
	}
	if (value instanceof Set) return [...value].map(jsonSafe);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, jsonSafe(v)]));
	}
	return value;
}

/** Render a tool call like `bash('ls -la')` for approval dialogs and traces. */
export function formatCall(
	request: { tool: string; args: unknown[]; kwargs: Record<string, unknown> },
	maxLength = 400,
): string {
	const parts = [
		...request.args.map((a) => pyRepr(a)),
		...Object.entries(request.kwargs).map(([k, v]) => `${k}=${pyRepr(v)}`),
	];
	const rendered = `${request.tool}(${parts.join(", ")})`;
	return rendered.length > maxLength ? `${rendered.slice(0, maxLength)}…` : rendered;
}
