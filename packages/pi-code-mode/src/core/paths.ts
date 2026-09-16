/**
 * Path normalization shared by host tools: the sandbox exposes the workspace
 * as a read-only virtual mount (default "/workspace"), so models naturally
 * try `open("/workspace/x")` for reads AND `write("/workspace/x", ...)` for
 * host-side mutations. Helpers resolve paths against the real workspace
 * root, where a "/workspace" prefix is just a rejected absolute path.
 * `stripVirtualRoot` lets helpers accept both spellings.
 */

/**
 * Maps a path that may carry the virtual workspace prefix (e.g.
 * "/workspace/out/x.csv") to a workspace-relative path ("out/x.csv").
 * The exact virtual root itself maps to ".". Everything else is returned
 * unchanged — other absolute paths still fail later containment checks.
 */
export function stripVirtualRoot(path: string, virtualRoot: string): string {
	if (path === virtualRoot) return ".";
	const prefix = virtualRoot.endsWith("/") ? virtualRoot : `${virtualRoot}/`;
	if (path.startsWith(prefix)) {
		const rest = path.slice(prefix.length);
		return rest === "" ? "." : rest;
	}
	return path;
}
