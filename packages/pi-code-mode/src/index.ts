/**
 * Library surface: use the code-mode core without pi (any agent harness can
 * drive CodeSession directly). The pi adapter is exported from
 * 'pi-code-mode/pi' to keep pi an optional peer dependency.
 */
export { createBuiltinTools, type BuiltinToolsOptions } from "./core/builtins.ts";
export { buildTypeCheckStubs, probeImportableModules } from "./core/capabilities.ts";
export {
	renderPythonToolRules,
	renderToolStub,
	renderTypeStub,
	ToolRegistry,
} from "./core/registry.ts";
export { drive, pythonError, type DriveContext, type DriveOutcome } from "./core/runner.ts";
export {
	CodeSession,
	type CodeSessionOptions,
	type PreludeSnippet,
	type SerializedState,
} from "./core/session.ts";
export { ToolStore, type SavedTool } from "./core/store.ts";
export {
	HostToolError,
	type ApprovalDecision,
	type ApprovalRequest,
	type HostTool,
	type HostToolParam,
	type RunErrorKind,
	type RunOptions,
	type RunResult,
	type SessionLimits,
	type ToolCallTrace,
} from "./core/types.ts";
export { formatCall, pyRepr, toHostValue } from "./core/values.ts";
