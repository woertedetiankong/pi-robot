import { sampleLesson } from "./fixtures/lesson.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig, parseConfig, defaults, savePreferences } from "../src/config.ts";
import { MarkdownSource, glob } from "../src/knowledge.ts";
import { clean, parseCard } from "../src/cards.ts";
import { MarkdownFavorites } from "../src/favorites.ts";
import { RequestGate } from "../src/scheduler.ts";
import { Companion } from "../src/controller.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const rawCard = {
  lesson: sampleLesson,
  scenario: { phase: "事前预防", goal: "减少缓存集中失效后的重复重建", constraints: "热点可预测，允许提前调整缓存策略" },
  title: "缓存的选择", kind: "judgment", body: "你会怎样防止大量请求同时重建缓存？", answer: "应根据请求规模与一致性需求选择。", sourceIds: [],
  options: [..."ABCD"].map(label => ({ label, text: `方案 ${label}`, explanation: `方案 ${label} 有适用条件。`, verdict: "conditional", feedback: "该选择在提前规划时合理，但还需要并发控制。" })),
};
export const modelResponse = (value = JSON.stringify(rawCard)) => ({ content: [{ type: "text", text: value }], stopReason: "stop" });
export function context(complete: (...args: any[]) => Promise<any>): ExtensionContext {
  return { hasUI: true, mode: "tui", cwd: process.cwd(), model: { provider: "test", id: "test" }, modelRegistry: { complete: (...args: any[]) => args[1]?.systemPrompt?.includes("题目一致性审校员") ? Promise.resolve(modelResponse('{"pass":true,"issues":[]}')) : complete(...args), find: () => undefined }, ui: {}, isIdle: () => false } as unknown as ExtensionContext;
}
async function temp(t: any): Promise<string> { const path = await mkdtemp(resolve(tmpdir(), "companion-test-")); t.after(() => rm(path, { recursive: true, force: true })); return path; }

test("config merges named collections, resolves each file's relative paths and respects project trust", async t => {
  const dir = await temp(t), user = resolve(dir, "user/companion.json");
  await mkdir(resolve(dir, "user")); await mkdir(resolve(dir, ".pi"));
  await writeFile(user, JSON.stringify({ mode: "wander", collections: { personal: { directories: ["notes"] }, shared: { directories: ["old"] } } }));
  await writeFile(resolve(dir, ".pi/companion.json"), JSON.stringify({ mode: "task", collections: { shared: { directories: ["docs"] } }, selectedCollections: ["personal", "shared"] }));
  const { config, warnings } = await loadConfig(dir, true, user);
  assert.deepEqual(warnings, []); assert.equal(config.mode, "task");
  assert.equal(config.collections.personal.directories[0], resolve(dir, "user/notes"));
  assert.equal(config.collections.shared.directories[0], resolve(dir, "docs"));
  assert.equal((await loadConfig(dir, false, user)).config.mode, "wander");
  await savePreferences({ ...config, model: undefined }, user);
  const saved = JSON.parse(await readFile(user, "utf8"));
  assert.deepEqual(saved.collections.shared.directories, ["old"]); assert.equal(saved.model, null);
});

test("invalid config reports errors, retaining valid user settings", async t => {
  const dir = await temp(t); await mkdir(resolve(dir, ".pi"));
  const user = resolve(dir, "user.json"); await writeFile(user, JSON.stringify({ format: "quiz" }));
  await writeFile(resolve(dir, ".pi/companion.json"), '{"intervalSeconds": 0}');
  const result = await loadConfig(dir, true, user);
  assert.equal(result.warnings.length, 1); assert.equal(result.config.format, "quiz");
  assert.throws(() => parseConfig({ collections: { x: { directories: "x" } } }, dir));
});

test("Markdown sources span collections, filter paths, refresh edited and deleted files, search Chinese and English", async t => {
  const dir = await temp(t); await mkdir(resolve(dir, "vault")); await mkdir(resolve(dir, "project"));
  await mkdir(resolve(dir, "vault/private"));
  await writeFile(resolve(dir, "vault/cache.md"), "---\ntags: [cache]\n---\n# 缓存雪崩\n缓存过期时间加入随机偏移，可以减少很多请求同时重建缓存。\n");
  await writeFile(resolve(dir, "vault/private/secret.md"), "# Private\nThis excluded document contains private cache details.");
  await writeFile(resolve(dir, "project/design.markdown"), "# Retry strategy\nExponential backoff reduces the load when a service is unavailable.");
  const source = new MarkdownSource({ personal: { directories: [resolve(dir, "vault")], exclude: ["private/**"] }, project: { directories: [resolve(dir, "project")] } }, ["personal", "project"]);
  const chinese = await source.search("缓存过期"); assert.equal(chinese.length, 1); assert.equal(chinese[0].line, 5); assert.equal(chinese[0].heading, "缓存雪崩");
  assert.equal((await source.search("exponential backoff"))[0].collection, "project");
  assert.equal((await source.search("private")).length, 0);
  const id = chinese[0].id;
  assert.equal((await source.read(id))?.heading, "缓存雪崩");
  await writeFile(resolve(dir, "vault/cache.md"), "# 数据库事务\n事务用来保证一组操作的原子性，并根据隔离级别定义并发可见性。");
  assert.equal((await source.search("缓存")).length, 0);
  await rm(resolve(dir, "project/design.markdown"));
  assert.equal((await source.search("backoff")).length, 0);
  const sampled = await source.sample(new Set()); assert.equal(sampled.length, 1);
  assert.equal((await source.sample(new Set(sampled.map(s => s.id)))).length, 0);
  assert(glob("**/*.md").test("a.md")); assert(glob("**/*.md").test("a/b.md"));
});

test("missing source is a warning and cannot fail unrelated collections", async t => {
  const dir = await temp(t);
  const source = new MarkdownSource({ missing: { directories: [resolve(dir, "absent")] } }, ["missing", "unknown"]);
  assert.deepEqual(await source.search("anything"), []); assert.equal(source.warnings.length, 2);
});

test("cards validate choice shapes and reject invented source IDs", () => {
  const judgment = parseCard(JSON.stringify(rawCard), []); assert.equal(judgment.correct, undefined);
  assert.throws(() => parseCard(JSON.stringify({ ...rawCard, kind: "knowledge" }), []));
  assert.throws(() => parseCard(JSON.stringify({ ...rawCard, options: rawCard.options.slice(0, 3) }), []));
  assert.throws(() => parseCard(JSON.stringify({ ...rawCard, sourceIds: ["made-up"] }), []));
  assert.equal(parseCard(JSON.stringify({ ...rawCard, kind: "knowledge", correct: "B" }), []).correct, "B");
  assert.equal(clean("\x1b[31mred\x1b[0m\x07"), "red");
});

test("favorite writes are separate files and optionally contain follow-up", async t => {
  const dir = await temp(t), store = new MarkdownFavorites(), card = parseCard(JSON.stringify(rawCard), []);
  const a = await store.save(card, [], dir), b = await store.save(card, [{ role: "user", text: "Why B?" }], dir);
  assert.notEqual(a, b); assert(!(await readFile(a, "utf8")).includes("Why B?"));
  assert((await readFile(b, "utf8")).includes("Why B?"));
  assert((await readFile(a, "utf8")).includes("方案 D"));
});

test("JSON answers and Markdown favorites retain complete fenced diagrams", async t => {
  const answer = "例子：一个请求查库，其余等待。\n```text\n[缓存失效]\n    |\n    v\n[合并重建]\n```\n失败或超时需另外处理。";
  const card = parseCard(JSON.stringify({ ...rawCard, answer, lesson: undefined }), []);
  assert.equal(card.answer, answer);
  const path = await new MarkdownFavorites().save(card, [{ role: "assistant", text: answer }], await temp(t));
  const saved = await readFile(path, "utf8");
  assert(saved.includes(`## 解答\n\n${answer}`));
  assert(saved.includes(`### 陪伴助手\n\n${answer}`));
});

test("favorites include the lesson scope and diagram before extra detail", async t => {
  const card = parseCard(JSON.stringify(rawCard), []);
  const path = await new MarkdownFavorites().save(card, [], await temp(t));
  const saved = await readFile(path, "utf8");
  assert(saved.includes(`适用范围：${sampleLesson.scope}`));
  assert(saved.includes(`\`\`\`text\n${sampleLesson.diagram}\n\`\`\``));
  assert(saved.indexOf(sampleLesson.diagram) < saved.indexOf("### 补充说明"));
  assert(saved.includes(card.answer));
});

test("request gate releases on cancellation, ignores late values, and enforces timeout", async () => {
  const gate = new RequestGate();
  let resolveOld!: (value: number) => void;
  const old = gate.run(() => new Promise<number>(r => { resolveOld = r; }));
  await delay(0); assert(gate.busy); assert.equal(await gate.run(async () => 99), undefined);
  gate.cancel(); assert.equal(await old, undefined); assert(!gate.busy);
  assert.equal(await gate.run(async () => 2), 2); resolveOld(1);
  const keeper = setTimeout(() => {}, 100);
  try { await assert.rejects(gate.run(() => new Promise(() => {}), 10), /超时/); } finally { clearTimeout(keeper); }
  assert(!gate.busy);
});

test("main task starts synchronously and stale card responses cannot overwrite an active discussion", async () => {
  let resolveModel!: (value: any) => void, calls = 0;
  const ctx = context(async () => { calls++; return new Promise(r => { resolveModel = r; }); });
  const state = new Companion({ ...defaults, format: "quiz" }, ctx, () => {});
  state.newTask("修复缓存"); assert.equal(state.start(), undefined);
  await delay(10); assert.equal(calls, 1);
  state.enter(); resolveModel(modelResponse()); await delay(0);
  assert.equal(state.card, undefined); state.leave(); state.close();
});

test("generation, quiz selection and follow-up remain independent and stop when disabled", async () => {
  const requests: any[] = [];
  const ctx = context(async (...args) => { requests.push(args); return requests.length === 1 ? modelResponse() : modelResponse("B 在合适条件下可行。"); });
  const state = new Companion({ ...defaults, format: "quiz", mode: "task" }, ctx, () => {});
  state.newTask("缓存逻辑"); await state.next(true);
  assert.equal(state.card?.kind, "judgment"); assert.equal(state.revealed, false);
  state.enter(); state.choose("B"); await state.ask("为什么？");
  assert.equal(state.messages.length, 2); assert(state.messages[1].text.includes("B"));
  assert.equal(requests[1][1].messages[0].content[0].text.includes("选择了 B"), true);
  state.leave(); state.reconfigure({ ...state.config, enabled: false }); await state.next(true);
  assert.equal(requests.length, 2); state.close();
});

test("failed model calls preserve the existing card and expose a small error", async () => {
  const state = new Companion({ ...defaults, format: "quiz" }, context(async () => { throw new Error("rate limited"); }), () => {});
  state.card = parseCard(JSON.stringify(rawCard), []); const id = state.card.id;
  await state.next(true); assert.equal(state.card.id, id); assert.equal(state.status, "rate limited"); state.close();
});

test("automatic cadence respects pin, pause, interaction and settled state", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0;
  const state = new Companion({ ...defaults, format: "quiz", mode: "task", intervalSeconds: 30 }, context(async () => { calls++; return modelResponse(); }), () => {});
  t.after(() => state.close());
  state.newTask("缓存"); state.start(); await delay(0); assert.equal(calls, 1);
  t.mock.timers.tick(30000); await delay(0); assert.equal(calls, 2);
  state.pinned = true; t.mock.timers.tick(30000); await delay(0); assert.equal(calls, 2);
  state.pinned = false; state.paused = true; state.schedule(); t.mock.timers.tick(60000); await delay(0); assert.equal(calls, 2);
  state.paused = false; state.schedule(); state.enter(); t.mock.timers.tick(30000); await delay(0); assert.equal(calls, 2);
  state.leave(); t.mock.timers.tick(30000); await delay(0); assert.equal(calls, 2); // queued card stops further automatic requests
  await state.next(true); assert.equal(calls, 2); // consume the queued card
  t.mock.timers.tick(30000); await delay(0); assert.equal(calls, 3);
  state.stop(); t.mock.timers.tick(60000); await delay(0); assert.equal(calls, 3);
  state.newTask("另一个任务"); state.start(); await delay(0); assert.equal(calls, 3); // pending card remains available
  await state.next(true); t.mock.timers.tick(30000); await delay(0); assert.equal(calls, 4);
});

test("session disposal discards late model output and aborts retrieval", async () => {
  let resolveModel!: (value: any) => void;
  const state = new Companion({ ...defaults, format: "quiz" }, context(async () => new Promise(r => { resolveModel = r; })), () => {});
  const pending = state.next(true); await delay(0); state.close(); resolveModel(modelResponse()); await pending;
  assert.equal(state.card, undefined); assert(!state.generation.busy);
  const source = new MarkdownSource({ x: { directories: ["/not-read"] } }, ["x"]);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(source.search("test", 3, controller.signal));
});

test("extension stays inert outside interactive terminal mode", async () => {
  const { default: extension } = await import("../index.ts");
  const events = new Map<string, (...args: any[]) => any>();
  extension({ on: (name: string, handler: any) => events.set(name, handler), registerCommand: () => {}, registerShortcut: () => {} } as any);
  let calls = 0;
  const ctx = { ...context(async () => { calls++; return modelResponse(); }), mode: "rpc", isProjectTrusted: () => true };
  await events.get("session_start")!({}, ctx);
  assert.equal(events.get("before_agent_start")!({ prompt: "hello" }, ctx), undefined);
  assert.equal(events.get("agent_start")!({}, ctx), undefined);
  await delay(0); assert.equal(calls, 0);
  events.get("session_shutdown")!({}, ctx);
});

test("meta cards are replaced by concrete warmups without fabricated citations", async () => {
  const { generate } = await import("../src/cards.ts");
  const { warmup } = await import("../src/warmups.ts");
  let prompt = "";
  const ctx = context(async (_model, input) => { prompt = input.systemPrompt; return modelResponse(JSON.stringify({ ...rawCard, title: "缺少项目材料", body: "我还没有看到具体内容。" })); });
  const card = await generate(ctx, { ...defaults }, "task", "quiz", "缓存逻辑", [], [], new AbortController().signal);
  assert.equal(card.origin, "builtin"); assert.equal(card.kind, "knowledge"); assert(card.body.includes("缓存")); assert.deepEqual(card.sources, []);
  assert(prompt.includes("禁止谈论缺少材料"));
  const next = warmup("text", [card.title], "缓存"); assert.notEqual(next.title, card.title); assert.equal(next.options, undefined);
  await assert.rejects(generate(ctx, { ...defaults }, "wander", "quiz", "", [], [], new AbortController().signal), /不够具体/);
});

test("focused next replaces a card without dropping interaction or injecting tool telemetry", async () => {
  let request: any;
  const state = new Companion({ ...defaults, format: "quiz", mode: "task" }, context(async (_model, input) => { request = input; return modelResponse(); }), () => {});
  state.newTask("检查缓存"); state.activityEnded("bash", false); state.enter();
  await state.next(true); assert.equal(state.card, undefined);
  await state.nextFocused(); assert(state.card); assert(state.interacting);
  assert(!JSON.stringify(request.messages).includes("bash")); state.close();
});
