import test from "node:test";
import assert from "node:assert/strict";
import { TuiMainScreen, Input, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Companion } from "../src/controller.ts";
import { defaults } from "../src/config.ts";
import { CardView, Discussion, CompanionView, explanationLines } from "../src/ui.ts";
import { parseCard } from "../src/cards.ts";
import { warmup } from "../src/warmups.ts";

class TestTerminal implements Terminal {
  columns = 140; rows = 40; kittyProtocolActive = false;
  onInput: (data: string) => void = () => {};
  onResize: () => void = () => {};
  writes: string[] = [];
  start(input: (data: string) => void, resize: () => void): void { this.onInput = input; this.onResize = resize; }
  stop(): void {} async drainInput(): Promise<void> {}
  write(data: string): void { this.writes.push(data); }
  moveBy(): void {} hideCursor(): void {} showCursor(): void {} clearLine(): void {} clearFromCursor(): void {} clearScreen(): void {} setTitle(): void {} setProgress(): void {}
}
const theme = { fg: (_color: string, value: string) => value, bg: (_color: string, value: string) => `\x1b[44m${value}\x1b[0m` } as unknown as Theme;
const diagram = "[缓存过期]\n    |\n    +--一个查库\n    |\n    +--其余等待";

test("fenced diagrams preserve indentation and branches while surrounding prose wraps", () => {
  const lines = explanationLines(`白话解释。\n\n\`\`\`text\n${diagram}\n\`\`\`\n${"一句总结。".repeat(20)}`, 32);
  assert(lines.join("\n").includes(diagram));
  assert(!lines.join("\n").includes("```"));
  assert(lines.every(line => visibleWidth(line) <= 32));
  assert.deepEqual(explanationLines(`~~~text\n${diagram}`, 32), diagram.split("\n"));
});

test("narrow diagrams show a resize hint, preserving prose and restoring the original on resize", () => {
  const text = `例子\n\`\`\`text\n${diagram}\n\`\`\`\n总结`;
  const narrow = explanationLines(text, 8);
  assert(narrow.join("").includes("请放大终端"));
  assert.equal(narrow[0], "例子"); assert.equal(narrow.at(-1), "总结");
  assert(!narrow.join("").includes("一个查库"));
  assert(narrow.every(line => visibleWidth(line) <= 8));
  assert(explanationLines(text, 32).join("\n").includes(diagram));
});

test("card detail and follow-up both expose diagrams with intact connections when scrolled", () => {
  for (const chat of [false, true]) {
    const terminal = new TestTerminal(), tui = new TuiMainScreen(terminal), state = fixture();
    state.card!.answer = `例子：同一价格只查一次。\n\`\`\`text\n${diagram}\n\`\`\``;
    state.messages = [{ role: "assistant", text: state.card!.answer }];
    const panel = new Discussion(state, tui, theme, () => {}, async () => {}, chat);
    if (!chat) { panel.handleInput("1"); panel.render(48); panel.handleInput("d"); }
    let shown = "";
    for (let i = 0; i < 10; i++) {
      const lines = panel.render(48);
      assert(lines.every(line => visibleWidth(line) <= 48));
      shown += lines.join("\n"); panel.handleInput("\x1b[6~");
    }
    assert(shown.includes("    +--一个查库")); assert(shown.includes("    +--其余等待"));
    assert(!shown.includes("```")); state.close();
  }
});

function fixture(): Companion {
  const state = new Companion({ ...defaults, format: "quiz" }, { ui: {}, cwd: process.cwd() } as ExtensionContext, () => {});
  state.card = parseCard(JSON.stringify({ scenario: { phase: "事前预防", goal: "减少缓存集中失效后的重复重建", constraints: "热点可预测，允许提前调整缓存策略" }, kind: "knowledge", title: "缓存问题", body: "什么情况下应该考虑缓存失效？", answer: "数据改变时应考虑失效策略。", correct: "B", sourceIds: [], options: [..."ABCD"].map(label => ({ label, text: `中文选项 ${label}`, explanation: `${label} 的解释。` })) }), []);
  return state;
}

test("card layout never exceeds terminal width, including Chinese and narrow terminals", () => {
  const state = fixture(), view = new CardView(state, theme);
  for (const width of [12, 30, 44, 80, 140]) {
    const lines = view.render(width);
    assert(lines.every(line => visibleWidth(line) <= width), `width ${width}`);
  }
});

test("real TUI passive overlay leaves editor typing intact; quiz confirmation and dismissal restore focus", () => {
  const terminal = new TestTerminal(), tui = new TuiMainScreen(terminal);
  const editor = new Input(); editor.setValue("主任务草稿 "); tui.addChild(editor); tui.setFocus(editor); tui.start(); terminal.onInput("\x05");
  const state = fixture();
  const passive = tui.showOverlay(new CardView(state, theme), { nonCapturing: true, anchor: "top-right", width: 44 });
  terminal.onInput("a"); assert.equal(editor.getValue(), "主任务草稿 a");
  let closed = false;
  const panel = new Discussion(state, tui, theme, () => { closed = true; handle.hide(); }, async () => {});
  const handle = tui.showOverlay(panel, { width: 80 });
  terminal.onInput("b"); assert.equal(state.selected, undefined);
  terminal.onInput("\r"); assert.equal(state.selected, "B"); assert.equal(state.revealed, true);
  assert.equal(editor.getValue(), "主任务草稿 a");
  terminal.onInput("\x1b"); assert(closed);
  terminal.onInput("c"); assert.equal(editor.getValue(), "主任务草稿 ac");
  passive.hide(); tui.stop(); state.close();
});

test("overlay layout falls back on narrow terminals and hide removes overlays", () => {
  const terminal = new TestTerminal(), tui = new TuiMainScreen(terminal), state = fixture();
  let widget: any;
  state.config.layout = "overlay";
  state.ctx.ui.setWidget = (_key: string, factory: any) => { widget?.dispose?.(); widget = factory?.(tui, theme); };
  const view = new CompanionView(state); view.changed();
  assert.deepEqual(widget.render(140), []);
  assert(widget.render(80).join("\n").includes("缓存问题"));
  assert(widget.render(80).length <= 4);
  terminal.rows = 20; assert(widget.render(140).length > 0);
  assert(view.layoutDescription().includes("140 × 20"));
  assert(widget.render(140).length <= 4);
  terminal.rows = 40; assert.deepEqual(widget.render(140), []);
  assert.equal(view.layoutDescription(), "右侧浮层");
  view.hide(); assert.equal(widget, undefined); state.close();
});

test("focused card highlights full row, reveals in place, requires t to chat, and reaches last content line", () => {
  const terminal = new TestTerminal(), tui = new TuiMainScreen(terminal), state = fixture();
  let closed = 0;
  const panel = new Discussion(state, tui, theme, () => { closed++; }, async () => {});
  panel.focused = true;
  const before = panel.render(64);
  assert(before.every(line => visibleWidth(line) === 64));
  assert(before.some(line => line.includes("\\x1b[44m".replace("\\x1b", "\x1b")) && line.includes("A")));
  panel.handleInput("b"); assert.equal(state.selected, undefined);
  assert(panel.render(64).some(line => line.includes("\x1b[44m") && line.includes("B")));
  panel.handleInput(" "); assert.equal(state.selected, "B");
  assert(!panel.render(64).join("\n").includes("追问 ›"));
  panel.handleInput("t"); assert(panel.render(64).join("\n").includes("追问 ›"));
  state.messages = [{ role: "assistant", text: "长回答\n".repeat(50) + "最终一行完整可见" }];
  for (let i = 0; i < 20; i++) panel.handleInput("\x1b[6~");
  assert(panel.render(64).join("\n").includes("最终一行完整可见"));
  panel.handleInput("\x1b"); assert.equal(closed, 0);
  panel.handleInput("\x1b"); assert.equal(closed, 1); state.close();
});

test("wrong answer shows the correct letter and text before long explanations, including after reopening", () => {
  const terminal = new TestTerminal(); terminal.rows = 22;
  const tui = new TuiMainScreen(terminal), state = fixture();
  state.card = warmup("quiz", [], "缓存");
  state.card.options![1].explanation = "很长的错误选项解释。".repeat(100);
  const panel = new Discussion(state, tui, theme, () => {}, async () => {});
  assert(!panel.render(48).join("\n").includes("正确答案"));
  panel.handleInput("b"); panel.handleInput("\r");
  const shown = panel.render(48).join("\n");
  assert(shown.includes("正确答案：A · 合并同一键的重建请求"));
  assert(shown.includes("你选了 B"));
  assert(shown.includes("为什么选 A"));
  assert(!shown.includes("很长的错误选项解释"));
  assert(new CardView(state, theme, true, 12).render(48).join("\n").includes("正确答案：A · 合并同一键的重建请求"));
  const reopened = new Discussion(state, tui, theme, () => {}, async () => {});
  assert(reopened.render(48).join("\n").includes("正确答案：A · 合并同一键的重建请求"));
  state.close();
});

test("correct answers and direct reveal both bring the answer into view without inventing a selection", () => {
  for (const choose of [true, false]) {
    const terminal = new TestTerminal(); terminal.rows = 22;
    const tui = new TuiMainScreen(terminal), state = fixture();
    state.card = warmup("quiz", [], "缓存");
    const panel = new Discussion(state, tui, theme, () => {}, async () => {});
    assert(panel.render(64).join("\n").includes("Ctrl+R 看答案"));
    panel.handleInput(choose ? "1" : "\x12");
    const shown = panel.render(64).join("\n");
    assert(shown.includes("正确答案：A · 合并同一键的重建请求"));
    assert.equal(shown.includes("选择正确"), choose);
    assert.equal(shown.includes("你选了"), choose);
    state.close();
  }
});

test("judgment feedback lists suitable choices or conditional alternatives without a unique answer", () => {
  for (const conditionalOnly of [false, true]) {
    const terminal = new TestTerminal(); terminal.rows = 22;
    const tui = new TuiMainScreen(terminal), state = fixture();
    state.card = warmup("quiz", [], "缓存");
    state.card.kind = "judgment"; delete state.card.correct;
    for (const option of state.card.options!) {
      option.verdict = option.label === "A" ? conditionalOnly ? "conditional" : "suitable" : "unsuitable";
      option.feedback = option.explanation;
    }
    const panel = new Discussion(state, tui, theme, () => {}, async () => {});
    panel.render(64); panel.handleInput("2");
    const shown = panel.render(64).join("\n");
    assert(shown.includes("当前场景建议（不设唯一正确答案）"));
    assert(shown.includes(`${conditionalOnly ? "需满足额外条件" : "可选"}：A · 合并同一键的重建请求`));
    assert(!shown.includes("正确答案："));
    assert(shown.includes("你选了 B · 当前条件下不合适"));
    state.close();
  }
});

test("small windows reserve space for the main agent and summary always exposes request state", () => {
  const terminal = new TestTerminal(), tui = new TuiMainScreen(terminal), state = fixture();
  let widget: any;
  state.ctx.ui.setWidget = (_key: string, factory: any) => { widget?.dispose?.(); widget = factory?.(tui, theme); };
  const view = new CompanionView(state);
  for (const layout of ["summary", "widget", "overlay"] as const) {
    state.config.layout = layout; view.remount();
    for (const [columns, rows] of [[80, 20], [140, 22], [32, 12]]) {
      terminal.columns = columns; terminal.rows = rows; state.status = "正在准备下一张…";
      const lines = widget.render(columns);
      assert(lines.length <= 4); assert(lines.every((line: string) => visibleWidth(line) <= columns));
      assert(lines.join("\n").includes("正在准备下一张"));
    }
  }
  state.stop(); assert(widget.render(80).join("\n").includes("主任务已完成"));
  view.hide(); state.close();
});

test("chat dismissal preserves the request and draft, reopening shows the completed reply", async () => {
  const terminal = new TestTerminal(), tui = new TuiMainScreen(terminal), state = fixture();
  state.status = "";
  let finish!: (value: any) => void;
  (state.ctx as any).model = { id: "fake" };
  (state.ctx as any).modelRegistry = { complete: async () => new Promise(r => { finish = r; }) };
  const pending = state.ask("解释一下"); await Promise.resolve();
  const panel = new Discussion(state, tui, theme, () => {}, async () => {}, true); panel.focused = true;
  panel.handleInput("接着问的草稿");
  panel.handleInput("\x1b"); panel.handleInput("\x1b"); panel.dispose();
  assert(state.chat.busy); assert.equal(state.reading.draft, "接着问的草稿");
  finish({ stopReason: "stop", content: [{ type: "text", text: "等待后得到的完整解释" }] }); await pending;
  const reopened = new Discussion(state, tui, theme, () => {}, async () => {}, true);
  const lines = reopened.render(64).join("\n");
  assert(lines.includes("等待后得到的完整解释")); assert(lines.replace(/\x1b\[[0-9;]*m/g, "").includes("接着问的草稿"));
  assert(!lines.includes("目标 ·")); state.close();
});

test("details and original notes expand on demand; D remains an answer key", () => {
  const terminal = new TestTerminal(), tui = new TuiMainScreen(terminal), state = fixture();
  state.status = "";
  state.card!.answer = "完整扩展讲解";
  state.card!.sources = [{ id: "note", path: "/notes/cache.md", heading: "缓存笔记", line: 3, collection: "笔记", text: "这是笔记原文，不是模型生成的概括。" }];
  const panel = new Discussion(state, tui, theme, () => {}, async () => {});
  panel.handleInput("d"); panel.handleInput("\r"); assert.equal(state.selected, "D");
  assert(!panel.render(64).join("\n").includes("完整扩展讲解"));
  panel.handleInput("d"); assert(state.reading.details);
  let all = "";
  for (let i = 0; i < 8; i++) { all += panel.render(64).join("\n"); panel.handleInput("\x1b[6~"); }
  assert(all.includes("完整扩展讲解")); assert(!all.includes("这是笔记原文"));
  panel.handleInput("o"); assert(panel.render(64).join("\n").includes("这是笔记原文")); state.close();
});

test("manual scrolling before answering does not jump back to the selected option", () => {
  const terminal = new TestTerminal(); terminal.rows = 22;
  const tui = new TuiMainScreen(terminal), state = fixture();
  state.card!.body = "很长的场景描述\n".repeat(30);
  const panel = new Discussion(state, tui, theme, () => {}, async () => {});
  panel.render(48); panel.handleInput("b"); panel.render(48);
  const atOption = state.reading.scroll;
  panel.handleInput("\x1b[5~"); panel.render(48);
  assert(state.reading.scroll < atOption); state.close();
});

test("native menus suspend widgets through layout changes, then restore the configured layout", () => {
  const terminal = new TestTerminal(), tui = new TuiMainScreen(terminal), state = fixture();
  let widget: any;
  state.ctx.ui.setWidget = (_key: string, factory: any) => { widget?.dispose?.(); widget = factory?.(tui, theme); };
  const view = new CompanionView(state); view.changed(); assert(widget);
  view.suspend(); state.enter(); assert.equal(widget, undefined);
  state.config.layout = "overlay"; view.remount(); view.changed(); assert.equal(widget, undefined);
  state.leave(); view.resume(); assert(widget); assert.deepEqual((widget as any).render(140), []);
  view.hide(); state.close();
});

test("focused cards and chat fit a short terminal while keeping exit controls visible", () => {
  const terminal = new TestTerminal(); terminal.rows = 12; terminal.columns = 32;
  const tui = new TuiMainScreen(terminal), state = fixture();
  state.messages = [{ role: "assistant", text: "长解释\n".repeat(50) }];
  for (const chat of [false, true]) {
    const panel = new Discussion(state, tui, theme, () => {}, async () => {}, chat);
    const lines = panel.render(32);
    assert(lines.length <= 9, `${chat}: ${lines.length}`); assert(lines.join("\n").includes("Esc"));
  }
  state.close();
});

test("new lessons show scope, example and diagram before optional detail without repeating the correct explanation", () => {
  const terminal = new TestTerminal(), tui = new TuiMainScreen(terminal), state = fixture();
  state.card = warmup("quiz", [], "缓存");
  state.card.answer = "补充内容只在展开后可见";
  state.card.options![0].explanation = "正确选项的重复讲解";
  const panel = new Discussion(state, tui, theme, () => {}, async () => {});
  panel.handleInput("1");
  const first = panel.render(72).join("\n");
  assert(first.includes("正确答案：A")); assert(first.includes("适用范围："));
  assert(first.includes("不同键、失败和超时"));
  let shown = first;
  for (let i = 0; i < 5; i++) { panel.handleInput("\x1b[6~"); shown += panel.render(72).join("\n"); }
  assert(shown.includes("1000 人同时查")); assert(shown.includes("[1 个查库，其余等待]"));
  assert(!shown.includes("补充内容只在展开后可见")); assert(!shown.includes("正确选项的重复讲解"));
  panel.handleInput("d");
  for (let i = 0; i < 10; i++) panel.handleInput("\x1b[5~");
  shown = "";
  for (let i = 0; i < 10; i++) { shown += panel.render(72).join("\n"); panel.handleInput("\x1b[6~"); }
  assert(shown.includes("补充内容只在展开后可见")); state.close();
});

test("compact footer exposes details and feedback after answering while retaining D selection before it", () => {
  const terminal = new TestTerminal(); terminal.rows = 20;
  const tui = new TuiMainScreen(terminal), state = fixture();
  const panel = new Discussion(state, tui, theme, () => {}, async () => {});
  assert(panel.render(48).join("\n").includes("Enter 确认"));
  panel.handleInput("d"); panel.handleInput("\r");
  assert.equal(state.selected, "D");
  const shown = panel.render(48).join("\n");
  assert(shown.includes("d 详解")); assert(shown.includes("f 反馈")); assert(shown.includes("Esc 返回"));
  panel.handleInput("d"); assert(state.reading.details); state.close();
});

test("examples and diagrams precede incorrect-choice analysis", () => {
  const state = fixture(), terminal = new TestTerminal();
  state.card = warmup("quiz", [], "缓存");
  const panel = new Discussion(state, new TuiMainScreen(terminal), theme, () => {}, async () => {});
  panel.handleInput("2");
  let shown = panel.render(72).join("\n");
  for (let i = 0; i < 12; i++) { panel.handleInput("\x1b[6~"); shown += panel.render(72).join("\n"); }
  assert(shown.indexOf("例子：") < shown.indexOf("为什么不选 B"));
  assert(shown.indexOf("[1 个查库，其余等待]") < shown.indexOf("为什么不选 B"));
  state.close();
});

test("question mark opens clarification directly and a long reply starts at its beginning", async () => {
  const state = fixture(), terminal = new TestTerminal();
  let clarify: boolean | undefined;
  const panel = new Discussion(state, new TuiMainScreen(terminal), theme, () => {}, async () => {}, false, async () => {}, async direct => { clarify = direct; return true; });
  panel.handleInput("?"); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(clarify, true);
  state.messages = [{ role: "user", text: "解释一下" }, { role: "assistant", text: "回答开头\n" + "中间内容\n".repeat(60) + "回答结尾" }];
  state.reading.replyStart = 1;
  const shown = panel.render(64).join("\n");
  assert(shown.includes("回答开头")); assert(!shown.includes("回答结尾"));
  panel.handleInput("\x1b[5~");
  assert.equal(state.reading.followReply, false);
  assert.equal(state.reading.replyStart, undefined);
  state.close();
});

test("submitting during a reply keeps the draft and explains the next action", async () => {
  const state = fixture(), terminal = new TestTerminal();
  const panel = new Discussion(state, new TuiMainScreen(terminal), theme, () => {}, async () => {}, true);
  const busy = state.chat.run(async () => new Promise<string>(() => {}));
  panel.handleInput("下一条问题"); panel.handleInput("\r");
  assert.equal(state.reading.draft, "下一条问题");
  assert(panel.render(80).join("\n").includes("上一条还在回答，草稿已保留"));
  state.chat.cancel(); await busy;
  assert(panel.render(80).join("\n").includes("草稿已保留，按 Enter 发送"));
  state.close();
});
