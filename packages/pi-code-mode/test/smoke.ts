/**
 * Deployment smoke test — verifies the full stack on this machine without
 * needing pi or an API key: monty's platform binary, the worker pool, the
 * extension init (probes + type-check stubs), sandboxing, gating, and
 * state persistence.
 *
 * Run: npm run smoke
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APPROVAL_CHOICES, createCodeModeExtension } from "../src/pi/extension.ts";

const workspace = mkdtempSync(join(tmpdir(), "pi-code-mode-smoke-"));
writeFileSync(join(workspace, "hello.txt"), "hello from the workspace\n");

const tools: any[] = [];
const handlers = new Map<string, any[]>();
const stubPi = {
	registerTool: (t: any) => tools.push(t),
	registerCommand: () => {},
	on: (e: string, h: any) => handlers.set(e, [...(handlers.get(e) ?? []), h]),
};

const t0 = Date.now();
await createCodeModeExtension({ root: workspace, toolStore: false, bridgePiTools: false })(stubPi as never);
console.log(`extension initialized in ${Date.now() - t0} ms (pool + capability probes + type stubs)`);

const tool = tools[0];
let uiChoice: string = APPROVAL_CHOICES.approve;
const ctx = {
	hasUI: true,
	ui: { select: async () => uiChoice, notify: () => {} },
	sessionManager: { getBranch: () => [] },
};
const run = async (params: Record<string, unknown>) => {
	const r = await tool.execute("smoke", params, undefined, undefined, ctx);
	return r.content[0]?.text ?? "";
};

let failures = 0;
const check = async (label: string, params: Record<string, unknown>, expect: (t: string) => boolean) => {
	const text = await run(params);
	const ok = expect(text);
	if (!ok) failures += 1;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}\n      ${text.split("\n").join("\n      ")}`);
};

await check("expression", { code: "6 * 7" }, (t) => t === "=> 42");
await check("state persists", { code: "x = 'kept'" }, (t) => t.includes("no output"));
await check("state readable", { code: "x" }, (t) => t === '=> "kept"');
await check("print streams", { code: "print('side channel')\n'value'" }, (t) => t.includes("side channel"));
await check(
	"workspace mount (read-only)",
	{ code: "open('/workspace/hello.txt').read().strip()" },
	(t) => t.includes("hello from the workspace"),
);
await check("filesystem escape blocked", { code: "open('/etc/passwd').read()" }, (t) => !t.includes("root:"));
await check("type checking gates bad calls", { code: "http_get(123)" }, (t) => t.includes("invalid-argument-type"));
await check("traceback on error", { code: "1 / 0" }, (t) => t.includes("ZeroDivisionError"));
await check("session survives errors", { code: "x + '!'" }, (t) => t === '=> "kept!"');

for (const h of handlers.get("session_shutdown") ?? []) await h({}, ctx);
rmSync(workspace, { recursive: true, force: true });

console.log(failures === 0 ? "\nAll smoke checks passed." : `\n${failures} smoke check(s) FAILED.`);
process.exitCode = failures === 0 ? 0 : 1;
