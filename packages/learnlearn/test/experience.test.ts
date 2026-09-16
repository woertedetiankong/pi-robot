import { sampleLesson } from "./fixtures/lesson.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Companion } from "../src/controller.ts";
import { CompanionMenus } from "../src/menus.ts";
import { defaults, loadConfig, saveConfigPatch } from "../src/config.ts";
import { warmup } from "../src/warmups.ts";

const response = (text: string) => ({ stopReason: "stop", content: [{ type: "text", text }] });
function fixture(reply?: (input: any, options: any) => Promise<any>) {
  let calls = 0;
  const ctx = { cwd: process.cwd(), hasUI: true, mode: "tui", isProjectTrusted: () => true, model: { id: "offline" }, ui: { notify: () => {} }, modelRegistry: { complete: async (_model: any, input: any, options: any) => {
    calls++;
    if (reply) return reply(input, options);
    if (input.systemPrompt.includes("审校员")) return response('{"pass":true,"issues":[]}');
    const payload = JSON.parse(input.messages[0].content[0].text.slice(6));
    return response(JSON.stringify({ lesson: sampleLesson, kind: "text", title: `卡片 ${calls}`, body: "一个具体的小问题。", answer: "先看发生了什么，再解释为什么。", sourceIds: payload.sources?.map((s: any) => s.id) ?? [] }));
  } } } as unknown as ExtensionContext;
  const state = new Companion({ ...defaults, format: "text", mode: "task" }, ctx, () => {});
  return { state, ctx, calls: () => calls };
}
async function sandbox(t: any) {
  const dir = await mkdtemp(resolve(tmpdir(), "companion-ux-"));
  const old = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = resolve(dir, "user");
  t.after(async () => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; await rm(dir, { recursive: true, force: true }); });
  return dir;
}

test("automatic cards wait without replacing unread work; history restores answers, drafts and messages", async () => {
  const { state, calls } = fixture(); state.running = true;
  await state.next(); const first = state.card!;
  state.messages.push({ role: "user", text: "保留这条追问" }); state.reading.draft = "尚未发送"; state.reading.chatScroll = 4;
  await state.next(); assert.equal(state.card, first); assert(state.pending); assert.equal(calls(), 2);
  await state.next(); assert.equal(calls(), 2);
  await state.next(true); assert.notEqual(state.card, first); assert(!state.pending); assert.equal(calls(), 2);
  state.previous(); assert.equal(state.card, first); assert.equal(state.messages[0].text, "保留这条追问"); assert.equal(state.reading.draft, "尚未发送"); assert.equal(state.reading.chatScroll, 4);
  await state.next(true); assert.equal(calls(), 2); state.close();
});

test("background reply survives dismissal, another task and card navigation, and attaches only to its original card", async () => {
  let finish!: (value: any) => void;
  const { state } = fixture(async () => new Promise(r => { finish = r; }));
  state.card = warmup("quiz", [], "缓存"); const first = state.card.id; state.choose("B");
  state.enter(); const work = state.ask("为什么不选 B？"); await delay(0); state.leave();
  assert(state.chat.busy);
  state.card = warmup("text", [], "重试"); state.newTask("新的主任务");
  finish(response("这是第一张卡片的解答")); await work;
  assert.equal(state.messages.length, 0); assert.equal(state.backgroundReplies, 1);
  state.visit(first); assert.equal(state.selected, "B"); assert(state.revealed); assert.equal(state.messages[1].text, "这是第一张卡片的解答"); state.close();
});

test("retry preserves the question without duplicate messages and stop ignores late output", async () => {
  let attempt = 0, late!: (value: any) => void;
  const { state } = fixture(async () => {
    attempt++; if (attempt === 1) throw new Error("temporary failure");
    if (attempt === 2) return new Promise(r => { late = r; });
    return response("重试成功");
  });
  state.card = warmup("text", []);
  await state.ask("解释一下"); assert(state.canRetry); assert(state.chatError.includes("temporary"));
  const old = state.retry(); await delay(0); state.stopChat(); await old;
  assert(state.canRetry); assert.equal(state.messages.length, 1);
  await state.retry(); late(response("过期回复")); await delay(0);
  assert.deepEqual(state.messages.map(m => m.text), ["解释一下", "重试成功"]); assert(!state.canRetry); state.close();
});

test("history is bounded and eviction/power-off cancel owned requests", async () => {
  let aborted = 0;
  const { state } = fixture(async (_input, options) => new Promise(() => options.signal.addEventListener("abort", () => aborted++)));
  state.card = warmup("text", []); const old = state.ask("旧问题"); await delay(0);
  for (let i = 0; i < 20; i++) state.card = warmup("text", []);
  await old; assert.equal(state.history.length, 20); assert.equal(aborted, 1);
  const current = state.ask("新问题"); await delay(0);
  state.reconfigure({ ...state.config, enabled: false }); await current; assert.equal(aborted, 2); state.close();
});

test("economy uses text and a ten-minute cadence; session feedback reaches generation and bypasses stale queued cards", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const payloads: any[] = [];
  const { state } = fixture(async input => {
    const payload = JSON.parse(input.messages[0].content[0].text.slice(6)); payloads.push(payload);
    return response(JSON.stringify({ lesson: sampleLesson, kind: "text", title: `题目 ${payloads.length}`, body: "场景", answer: "解答", sourceIds: [] }));
  });
  state.reconfigure({ ...state.config, format: "quiz", usage: "economy", intervalSeconds: 30 });
  state.start(); await delay(0); assert.equal(payloads[0].requiredFormat, "text");
  t.mock.timers.tick(599999); await delay(0); assert.equal(payloads.length, 1);
  t.mock.timers.tick(1); await delay(0); assert.equal(payloads.length, 2); assert(state.pending);
  state.feedback("hard"); state.feedback("less"); await state.next(true);
  assert.equal(payloads.length, 3); assert.equal(payloads[2].learningPreferences.difficulty, "easier"); assert.deepEqual(payloads[2].learningPreferences.avoidTopics, ["题目 1"]);
  assert.equal(state.history.length, 3); state.close();
});

test("scoped settings persist only edited fields and preserve other named collections", async t => {
  const dir = await sandbox(t), user = resolve(process.env.PI_CODING_AGENT_DIR!, "companion.json");
  await saveConfigPatch({ mode: "wander", collections: { personal: { directories: ["/notes"] } } }, user);
  const { state, ctx } = fixture(); (ctx as any).cwd = dir;
  state.config.mode = "task"; const menus = new CompanionMenus(state, () => true, () => {});
  await menus.update({ layout: "widget" }); assert.equal(JSON.parse(await readFile(user, "utf8")).layout, undefined);
  menus.scope = "user"; await menus.update({ layout: "overlay" });
  let stored = JSON.parse(await readFile(user, "utf8")); assert.equal(stored.mode, "wander"); assert.equal(stored.layout, "overlay");
  menus.scope = "project"; await menus.update({ mode: "task", collections: { work: { directories: [resolve(dir, "docs")] } } });
  assert.equal((await loadConfig(dir, true, user)).config.mode, "task");
  stored = JSON.parse(await readFile(user, "utf8")); assert(!stored.collections.work); assert(stored.collections.personal);
  (ctx as any).isProjectTrusted = () => false;
  await assert.rejects(menus.update({ layout: "summary" }), /信任/); state.close();
});

test("first favorite remembers only its directory, not temporary or project preferences", async t => {
  const dir = await sandbox(t), user = resolve(process.env.PI_CODING_AGENT_DIR!, "companion.json");
  await saveConfigPatch({ mode: "wander", enabled: false, usage: "economy" }, user);
  const { state, ctx } = fixture(); (ctx as any).cwd = dir; state.card = warmup("text", []);
  ctx.ui.input = async () => "favorites";
  const menus = new CompanionMenus(state, () => true, () => {}); await menus.save();
  const stored = JSON.parse(await readFile(user, "utf8"));
  assert.deepEqual(stored, { mode: "wander", enabled: false, usage: "economy", saveDirectory: resolve(dir, "favorites") }); state.close();
});

test("knowledge wizard checks notes, saves to the chosen scope, and previews only the new collection", async t => {
  const dir = await sandbox(t); await mkdir(resolve(dir, "notes"));
  await writeFile(resolve(dir, "notes/cache.md"), "# 缓存\n缓存是临时保存的数据，过期后需要重新获取，再让后续请求复用。\n");
  const { state, ctx } = fixture(); (ctx as any).cwd = dir;
  const inputs = ["./notes", "我的知识"];
  ctx.ui.input = async () => inputs.shift(); ctx.ui.select = async (_title, options) => options[0];
  const menus = new CompanionMenus(state, () => true, () => {}); menus.scope = "project";
  state.enter(); assert(await menus.addCollection()); state.leave();
  assert.equal(state.card?.sources[0].collection, "我的知识"); assert.equal(state.config.mode, "task");
  const project = JSON.parse(await readFile(resolve(dir, ".pi/companion.json"), "utf8"));
  assert.deepEqual(project.selectedCollections, ["我的知识"]); assert.equal(project.collections["我的知识"].directories[0], resolve(dir, "notes")); state.close();
});

test("knowledge wizard refuses empty directories and cancellation does not create configuration", async t => {
  const dir = await sandbox(t); await mkdir(resolve(dir, "empty"));
  const { state, ctx } = fixture(); (ctx as any).cwd = dir;
  const inputs = ["empty", "空合集"]; ctx.ui.input = async () => inputs.shift();
  let warning = ""; ctx.ui.notify = text => { warning = text; };
  const menus = new CompanionMenus(state, () => true, () => {}); assert.equal(await menus.addCollection(), false);
  assert(warning.includes("未找到可用笔记")); assert.deepEqual(state.config.collections, {}); state.close();
});

test("targeted clarification sends the selected question and input without changing learning preferences", async () => {
  for (const [focus, input, expected] of [
    ["换个例子", "", "换一个具体的小例子"],
    ["这个词是什么意思", "再次委派", "再次委派"],
    ["为什么会这样", "检查后直接返回", "检查后直接返回"],
    ["我的理解对吗", "所有子智能体都不能找帮手", "所有子智能体都不能找帮手"],
  ]) {
    const { state, ctx } = fixture(async () => response("针对问题的回复"));
    state.card = warmup("quiz", [], "缓存");
    const choices = ["解释不清楚", focus];
    ctx.ui.select = async () => choices.shift();
    ctx.ui.input = async () => input;
    const menus = new CompanionMenus(state, () => true, () => {});
    assert.equal(await menus.feedback(), true);
    await delay(0);
    assert.equal(state.messages.length, 2);
    assert(state.messages[0].text.includes(expected));
    assert.deepEqual(state.preferences, { difficulty: "balanced", avoidTopics: [] });
    assert.equal(state.selected, undefined); state.close();
  }
});

test("clarification cancellation, blank input, stale card and active reply do not submit another request", async () => {
  for (const reason of ["cancel-menu", "cancel-input", "blank", "changed-card", "busy", "too-long"]) {
    const { state, ctx, calls } = fixture(async () => new Promise(() => {}));
    state.card = warmup("quiz", [], "缓存");
    const choices = ["解释不清楚", "这个词是什么意思"];
    let notices = "";
    ctx.ui.notify = text => { notices += text; };
    ctx.ui.select = async () => {
      if (reason === "cancel-menu" && choices.length === 1) return undefined;
      return choices.shift();
    };
    ctx.ui.input = async () => {
      if (reason === "changed-card") state.card = warmup("text", []);
      return reason === "cancel-input" ? undefined : reason === "blank" ? "  " : reason === "too-long" ? "字".repeat(1001) : "委派";
    };
    if (reason === "busy") void state.ask("已有追问");
    const menus = new CompanionMenus(state, () => true, () => {});
    assert.equal(await menus.feedback(), reason === "busy");
    assert.equal(calls(), reason === "busy" ? 1 : 0);
    if (reason === "busy") assert(notices.includes("正在回答"));
    assert.deepEqual(state.preferences, { difficulty: "balanced", avoidTopics: [] }); state.close();
  }
});

test("reply arrival preserves manual reading and otherwise requests the answer beginning", async () => {
  for (const manualReading of [false, true]) {
    let finish!: (value: any) => void;
    const { state } = fixture(async () => new Promise(resolve => { finish = resolve; }));
    state.card = warmup("quiz", [], "缓存");
    const work = state.ask("讲清楚这个例子"); await delay(0);
    state.reading.chatScroll = 3;
    if (manualReading) state.reading.followReply = false;
    finish(response("开头\n" + "长回答\n".repeat(50))); await work;
    assert.equal(state.reading.chatScroll, 3);
    assert.equal(state.reading.replyStart, manualReading ? undefined : 1);
    state.close();
  }
});

test("direct clarification skips the feedback menu", async () => {
  const { state, ctx } = fixture(async () => response("换个例子"));
  state.card = warmup("quiz", [], "缓存");
  const titles: string[] = [];
  ctx.ui.select = async title => { titles.push(title); return "换个例子"; };
  assert(await new CompanionMenus(state, () => true, () => {}).feedback(true));
  await delay(0);
  assert.equal(titles.length, 1); assert(titles[0].includes("哪里没懂"));
  assert(state.messages[0].text.includes("换一个具体的小例子")); state.close();
});

test("opening a disabled companion explains how to enable it without model calls", async t => {
  const directory = await sandbox(t);
  await mkdir(resolve(directory, "user"), { recursive: true });
  await writeFile(resolve(directory, "user/companion.json"), JSON.stringify({ enabled: false }));
  const { default: extension } = await import("../index.ts");
  const events = new Map<string, (...args: any[]) => any>();
  let command: any;
  extension({ on: (name: string, handler: any) => events.set(name, handler), registerCommand: (_name: string, definition: any) => { command = definition; }, registerShortcut: () => {} } as any);
  const { ctx, calls, state } = fixture();
  ctx.cwd = directory;
  const notices: string[] = [];
  ctx.ui.notify = message => { notices.push(message); };
  ctx.ui.setWidget = () => {};
  await events.get("session_start")!({}, ctx);
  await command.handler("open", ctx);
  assert(notices.some(message => message.includes("陪伴已关闭") && message.includes("/companion on")));
  assert.equal(calls(), 0);
  events.get("session_shutdown")!({}, ctx); state.close();
});

test("card generation gets a three-minute budget and exposes the current stage", async () => {
  const { state } = fixture();
  const stages: string[] = [];
  state.changed = () => { stages.push(state.status); };
  const original = state.generation.run.bind(state.generation);
  let budget: number | undefined;
  state.generation.run = (work, timeout) => { budget = timeout; return original(work, timeout); };
  await state.next(true);
  assert.equal(budget, 180000);
  assert(stages.includes("正在读取知识库…"));
  assert(stages.includes("正在生成卡片…"));
  assert(state.card); state.close();
});

test("generation timeout preserves the card and provides a concrete recovery action", async () => {
  const { RequestTimeoutError } = await import("../src/scheduler.ts");
  const { state } = fixture();
  state.card = warmup("quiz", [], "缓存"); const previous = state.card;
  state.generation.run = async () => { throw new RequestTimeoutError(); };
  await state.next(true);
  assert.equal(state.card, previous);
  assert(state.status.includes("180 秒"));
  assert(state.status.includes("模型与用量"));
  state.close();
});
