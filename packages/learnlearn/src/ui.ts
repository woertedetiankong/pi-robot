import { Input, matchesKey, truncateToWidth, wrapTextWithAnsi, visibleWidth, type Component, type Focusable, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { clean } from "./cards.ts";
import type { Companion } from "./controller.ts";

export function explanationLines(text: string, width: number): string[] {
  const columns = Math.max(1, width), rows: string[] = [];
  let fence: string | undefined, block: string[] = [];
  const flush = () => {
    // Wrapping a diagram changes its connections. Keep it intact or explain why it is hidden.
    if (block.some(line => visibleWidth(line) > columns)) {
      rows.push(...wrapTextWithAnsi("[图示/代码较宽，请放大终端或收藏后查看原文]", columns));
    } else rows.push(...block);
    block = [];
  };
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (fence) {
      const closing = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/)?.[1];
      if (closing && closing[0] === fence[0] && closing.length >= fence.length) { flush(); fence = undefined; }
      else block.push(line.replace(/\t/g, "    "));
    } else {
      const opening = line.match(/^ {0,3}(`{3,}|~{3,})[^`]*$/)?.[1];
      if (opening) fence = opening;
      else rows.push(...wrapTextWithAnsi(line, columns));
    }
  }
  if (fence) flush();
  return rows;
}
function wrapped(lines: string[], width: number): string[] {
  return lines.flatMap(line => explanationLines(line, width));
}
export const canFloat = (width: number, height: number) => width >= 96 && height >= 22;
export const panelWidth = (width: number) => Math.max(48, Math.floor(width * .48));
function pad(value: string, width: number): string {
  const clipped = truncateToWidth(value, width);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}
interface Row { text: string; selected?: boolean; accent?: boolean; muted?: boolean; answerStart?: boolean; sourceStart?: boolean }
function frame(rows: Row[], width: number, theme: Theme, title: string, footer: string): string[] {
  if (width < 8) return [truncateToWidth(title, width)];
  const inside = width - 4;
  const edge = (left: string, content: string, right: string) => theme.fg("border", left + pad(truncateToWidth(content, width - 2, ""), width - 2) + right);
  return [edge("╭", "─ " + title + " " + "─".repeat(width), "╮"), ...rows.map(row => {
    let value = " " + pad(row.text, inside) + " ";
    if (row.selected) value = theme.bg("selectedBg", theme.fg("accent", value));
    else if (row.accent) value = theme.fg("accent", value);
    else if (row.muted) value = theme.fg("dim", value);
    return theme.fg("border", "│") + value + theme.fg("border", "│");
  }), edge("├", "─".repeat(width), "┤"), ...wrapTextWithAnsi(footer, inside).map(line => theme.fg("border", "│") + " " + theme.fg("dim", pad(line, inside)) + " " + theme.fg("border", "│")), edge("╰", "─".repeat(width), "╯")];
}
function contentRows(state: Companion, width: number, selection = -1, full = false, details = false, sources = false): Row[] {
  const card = state.card, rows: Row[] = [];
  const add = (text: string, style: Partial<Row> = {}) => rows.push(...wrapped([text], width).map(text => ({ text, ...style })));
  if (!card) { add("留一点好奇心，给正在写代码的自己。", { accent: true }); add(state.status, { muted: true }); return rows; }
  const selected = card.options?.find(o => o.label === state.selected);
  const correct = card.options?.find(o => o.label === card.correct);
  const addOutcome = () => {
    if (correct) add(`正确答案：${correct.label} · ${correct.text}`, { accent: true, answerStart: true });
    else {
      const suitable = card.options?.filter(o => o.verdict === "suitable") ?? [];
      const conditional = card.options?.filter(o => o.verdict === "conditional") ?? [];
      add("当前场景建议（不设唯一正确答案）", { accent: true, answerStart: true });
      for (const o of suitable.length ? suitable : conditional) add(`${suitable.length ? "可选" : "需满足额外条件"}：${o.label} · ${o.text}`, { accent: true });
    }
    if (selected) {
      const verdict = selected.verdict === "suitable" ? "当前条件下合适" : selected.verdict === "conditional" ? "有条件适用／只能部分解决" : selected.verdict === "unsuitable" ? "当前条件下不合适" : card.correct === selected.label ? "选择正确" : "这项不符合题目条件";
      add(`你选了 ${selected.label} · ${verdict}`, { accent: true });
    }
  };
  const kind = card.kind === "text" ? "灵感" : card.kind === "knowledge" ? "知识题" : "取舍题";
  add(`${kind} · 第 ${state.cardNumber} 张${state.pinned ? " · 已固定" : state.paused ? " · 暂停更新" : ""}${selection >= 0 ? " · 已聚焦" : ""}`, { muted: true });
  add(card.title, { accent: true }); add("");
  if (state.revealed && card.options && !full) { addOutcome(); add(""); }
  add(card.body); add("");
  if (card.scenario) { add(`场景 · ${card.scenario.phase}`, { muted: true }); add(`目标 · ${card.scenario.goal}`, { muted: true }); add(`条件 · ${card.scenario.constraints}`, { muted: true }); add(""); }
  card.options?.forEach((option, i) => add(`${state.selected === option.label ? "●" : selection === i ? "›" : " "} ${option.label}  ${option.text}`, { selected: selection === i }));
  if (state.revealed && (full || card.kind === "text")) {
    add("");
    if (card.options) addOutcome();
    if (card.lesson) {
      add(`${correct ? `为什么选 ${correct.label}` : "一句话理解"}：${card.lesson.summary}`);
      add(`适用范围：${card.lesson.scope}`, { muted: true }); add("");
    } else if (correct) { add(`为什么选 ${correct.label}：${correct.explanation}`); add(""); }
    if (card.lesson) {
      add(`例子：${card.lesson.example}`);
      if (card.lesson.diagram) { add(""); add("```text\n" + card.lesson.diagram + "\n```"); }
      add("");
    }
    if (selected && selected !== correct) {
      add(`${correct ? `为什么不选 ${selected.label}` : `你的选择 ${selected.label}`}：${selected.feedback ?? selected.explanation}`); add("");
    }
    if (card.lesson) {
      if (details) { add(""); add("补充说明", { muted: true }); add(card.answer); }
    } else if (card.kind === "text" || card.kind === "judgment" || details) add(card.answer);
    if (full && details && card.options) {
      const options = card.options.filter(o => o !== selected && o !== correct);
      if (options.length) { add(""); add("其他选项", { muted: true }); }
      for (const o of options) add(`${o.label}：${o.explanation}`);
    }
  }
  add("");
  add(card.sources.length ? `来源 · ${card.sources.map(s => s.collection + " / " + (s.heading || "笔记")).join("；")} · 含模型解读` : card.origin === "builtin" ? "精选暖场 · 通用知识" : "自由灵感 · 模型生成", { muted: true });
  if (full && sources) {
    if (!card.sources.length) add("这张卡片未引用本地笔记", { muted: true, sourceStart: true });
    for (const source of card.sources) { add(`${source.path}:${source.line}`, { muted: true, sourceStart: true }); add(source.text); add(""); }
  }
  return rows;
}
export function statusLine(state: Companion): string {
  return [state.generation.busy ? state.status || "正在准备下一张…" : state.status,
    state.pending ? "有新卡 · n 查看" : "", state.backgroundChats ? `追问回答中 ${state.backgroundChats}` : "",
    state.backgroundReplies ? `新回复 ${state.backgroundReplies} · h 历史` : "",
    state.pinned ? "已固定" : "", state.paused ? "自动更新已暂停" : "",
    state.taskFinished && !state.status.includes("主任务已完成") ? "主任务已完成" : "", state.config.usage === "economy" ? "省用量" : ""].filter(Boolean).join(" · ");
}
export class SummaryView implements Component {
  constructor(private state: Companion, private theme: Theme, private height = 4) {}
  invalidate(): void {}
  render(width: number): string[] {
    const card = this.state.card;
    const correct = this.state.revealed ? card?.options?.find(o => o.label === card.correct) : undefined;
    const lines = [this.theme.fg("accent", `✦ ${card?.title ?? "好奇心陪伴"}`),
      correct ? `正确答案：${correct.label} · ${correct.text}` : (card?.body ?? "独立卡片陪伴主任务"),
      statusLine(this.state) || "Ctrl+Alt+J 展开 · /companion 菜单",
      "Ctrl+Alt+J 展开 · Ctrl+Alt+N 下一张 · /companion 菜单"];
    if (this.height < 3) lines[0] = `✦ ${statusLine(this.state) || card?.title || "好奇心陪伴"}`;
    return lines.slice(0, Math.max(1, this.height)).map(line => truncateToWidth(line.replace(/\n/g, " "), width));
  }
}
export class CardView implements Component {
  constructor(private state: Companion, private theme: Theme, private compact = true, private maxRows = 16) {}
  invalidate(): void {}
  render(width: number): string[] {
    let rows = contentRows(this.state, Math.max(1, width - 4));
    if (this.compact && rows.length > this.maxRows) rows = [...rows.slice(0, this.maxRows - 1), { text: "…聚焦查看完整卡片", muted: true }];
    return frame(rows, width, this.theme, "✦ 好奇心陪伴", `${truncateToWidth(statusLine(this.state), Math.max(1, width - 4))}\nCtrl+Alt+J 聚焦 · Ctrl+Alt+N 换卡 · /companion 设置`);
  }
}
export class CompanionView {
  private overlay?: OverlayHandle;
  private tui?: TUI;
  private mounted = false;
  private suspended = false;
  layoutDescription(): string {
    if (this.state.config.layout === "summary") return "摘要（最多 4 行）";
    if (this.state.config.layout === "widget") return "输入框上方";
    if (this.tui && (!canFloat(this.tui.terminal.columns, this.tui.terminal.rows) || this.tui.terminal.rows < 28)) return `已选择右侧浮层；小窗口暂用摘要（当前 ${this.tui.terminal.columns} × ${this.tui.terminal.rows}）`;
    return "右侧浮层";
  }
  private chatRender?: () => void;
  private chatClose?: () => void;
  constructor(private state: Companion) {}
  changed(): void {
    if (this.suspended) return;
    if (!this.state.config.enabled) { this.hide(); return; }
    if (!this.mounted) this.mount();
    this.tui?.requestRender(); this.chatRender?.();
  }
  private mount(): void {
    this.mounted = true;
    this.state.ctx.ui.setWidget("curiosity-companion", (tui, theme) => {
      this.tui = tui;
      const component = new CardView(this.state, theme, true, 12);
      const summary = () => new SummaryView(this.state, theme, Math.min(4, Math.max(1, Math.floor(tui.terminal.rows / 4))));
      const floating = { render: (width: number) => new CardView(this.state, theme, true, Math.max(8, Math.min(16, tui.terminal.rows - 10))).render(width), invalidate: () => {} };
      if (this.state.config.layout === "overlay") {
        this.overlay = tui.showOverlay(floating, { nonCapturing: true, anchor: "top-right", width: "48%", minWidth: 48, margin: { top: 1, right: 1 }, visible: (w, h) => canFloat(w, h) && h >= 28 && !this.state.interacting });
      }
      return {
        render: (width: number) => {
          if (this.chatClose) return [];
          if (this.state.config.layout === "summary" || tui.terminal.rows < 28 || (this.state.config.layout === "overlay" && !canFloat(width, tui.terminal.rows))) return summary().render(width);
          if (this.state.config.layout !== "overlay") return component.render(width);
          if (canFloat(width, tui.terminal.rows) && !this.state.interacting) return [];
          const lines = component.render(width);
          return lines;
        },
        invalidate: () => component.invalidate(),
        dispose: () => { this.overlay?.hide(); this.overlay = undefined; },
      };
    });
  }
  hide(): void { this.chatClose?.(); this.chatClose = undefined; this.overlay?.hide(); this.overlay = undefined; this.state.ctx.ui.setWidget("curiosity-companion", undefined); this.mounted = false; }
  remount(): void { this.hide(); this.changed(); }
  suspend(): void { this.suspended = true; this.hide(); }
  resume(): void { this.suspended = false; this.changed(); }
  async open(save: () => Promise<void>, chat = false, history: () => Promise<void> = async () => {}, feedback: (clarify?: boolean) => Promise<boolean> = async () => false): Promise<void> {
    if (!this.state.card || this.state.interacting) return;
    this.state.enter();
    let handle: OverlayHandle | undefined;
    let active = true;
    try {
      await this.state.ctx.ui.custom<void>((tui, theme, _keys, done) => {
        this.chatClose = () => done();
        const uncover = async <T,>(action: () => Promise<T>): Promise<T> => {
          // Pi select/input dialogs render below overlays: temporarily uncover them.
          handle?.setHidden(true);
          try { return await action(); } finally { if (active) { handle?.setHidden(false); handle?.focus(); } }
        };
        const panel = new Discussion(this.state, tui, theme, done, () => uncover(save), chat, () => uncover(history), clarify => uncover(() => feedback(clarify)));
        this.chatRender = () => tui.requestRender();
        return panel;
      }, { overlay: true, overlayOptions: () => ({ width: this.tui && canFloat(this.tui.terminal.columns, this.tui.terminal.rows) ? panelWidth(this.tui.terminal.columns) : "96%", maxHeight: this.tui ? Math.max(8, this.tui.terminal.rows - 3) : "90%", anchor: this.state.config.layout === "overlay" ? "top-right" : "bottom-center", margin: { top: 1, right: 1, bottom: 1 } }), onHandle: value => { handle = value; } });
    } finally { active = false; this.chatClose = undefined; this.chatRender = undefined; this.state.leave(); }
  }
}
export class Discussion implements Component, Focusable {
  private input = new Input({ prompt: "追问 › ", placeholder: "Enter 发送，Esc 返回后继续回答" });
  private active = false;
  private selection = 0;
  private selectionMoved = false;
  private focusSource = false;
  private saving = false;
  private notice = "";
  private cardId?: string;
  private wasRevealed = false;
  private get scroll(): number { return this.chatMode ? this.state.reading.chatScroll : this.state.reading.scroll; }
  private set scroll(value: number) { if (this.chatMode) this.state.reading.chatScroll = value; else this.state.reading.scroll = value; }
  get focused(): boolean { return this.active; }
  set focused(value: boolean) { this.active = value; this.input.focused = value && this.chatMode; }
  constructor(private state: Companion, private tui: TUI, private theme: Theme, private done: () => void, private save: () => Promise<void>, private chatMode = false, private history: () => Promise<void> = async () => {}, private feedback: (clarify?: boolean) => Promise<boolean> = async () => false) {
    this.cardId = state.card?.id; this.wasRevealed = state.revealed && state.reading.scroll > 0; this.input.setValue(state.reading.draft);
    this.input.onSubmit = value => {
      if (state.chat.busy && value.trim()) {
        this.notice = "上一条还在回答，草稿已保留；回答完成后按 Enter 发送";
      } else if (value.trim()) {
        this.notice = "";
        state.reading.followReply = true;
        const retry = state.canRetry && state.messages.at(-1)?.role === "user" && state.messages.at(-1)?.text === value.trim();
        this.input.setValue(""); state.reading.draft = "";
        void state.ask(value, retry); this.scroll = Number.MAX_SAFE_INTEGER;
      }
    };
  }
  invalidate(): void { this.input.invalidate(); }
  // Entry-owned requests and reading state survive dismissal.
  dispose(): void {}
  private async dialog(action: () => Promise<void>): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    try { await action(); } catch (e) { this.notice = clean((e as Error).message, 200); }
    finally { this.saving = false; this.tui.requestRender(); }
  }
  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      if (this.chatMode) { this.chatMode = false; this.input.focused = false; this.tui.requestRender(); }
      else this.done();
      return;
    }
    if (this.chatMode && (matchesKey(data, "pageUp") || matchesKey(data, "pageDown"))) {
      this.state.reading.followReply = false;
      this.state.reading.replyStart = undefined;
    }
    if (matchesKey(data, "pageUp")) { this.scroll = Math.max(0, this.scroll - 6); this.tui.requestRender(); return; }
    if (matchesKey(data, "pageDown")) { this.scroll += 6; this.tui.requestRender(); return; }
    if (matchesKey(data, "ctrl+s") || (!this.chatMode && data === "s")) { void this.dialog(this.save); return; }
    if (this.chatMode) {
      if (matchesKey(data, "ctrl+x")) this.state.stopChat();
      else if (matchesKey(data, "ctrl+r")) void this.state.retry();
      else { this.input.handleInput(data); this.state.reading.draft = this.input.getValue(); }
      this.tui.requestRender(); return;
    }
    if (data === "q") { this.done(); return; }
    if (data === "t") { this.chatMode = true; this.input.focused = this.active; this.tui.requestRender(); return; }
    if (data === "h") { void this.dialog(this.history); return; }
    if (data === "f" || data === "?") { void this.dialog(async () => { if (await this.feedback(data === "?")) { this.chatMode = true; this.input.focused = this.active; } }); return; }
    if (data === "[") { this.state.previous(); return; }
    if (data === "p") { this.state.pinned = !this.state.pinned; this.state.changed(); return; }
    if (data === "n") { void this.state.nextFocused(); return; }
    if (data === "d" && this.state.revealed) this.state.reading.details = !this.state.reading.details;
    else if (data === "o") { this.state.reading.sources = !this.state.reading.sources; this.focusSource = this.state.reading.sources; }
    else if (matchesKey(data, "ctrl+r")) this.state.revealed = true;
    else if (!this.state.revealed && this.state.card?.options) {
      if (/^[a-d]$/i.test(data)) { this.selection = "ABCD".indexOf(data.toUpperCase()); this.selectionMoved = true; }
      else if (/^[1-4]$/.test(data)) { this.selection = Number(data) - 1; this.state.choose("ABCD"[this.selection]); }
      else if (matchesKey(data, "up")) { this.selection = (this.selection + 3) % 4; this.selectionMoved = true; }
      else if (matchesKey(data, "down")) { this.selection = (this.selection + 1) % 4; this.selectionMoved = true; }
      else if (matchesKey(data, "return") || data === " ") this.state.choose("ABCD"[this.selection]);
    } else if (matchesKey(data, "down")) this.scroll++;
    else if (matchesKey(data, "up")) this.scroll = Math.max(0, this.scroll - 1);
    this.tui.requestRender();
  }
  render(width: number): string[] {
    if (this.cardId !== this.state.card?.id) {
      this.cardId = this.state.card?.id; this.selection = 0; this.wasRevealed = this.state.revealed && this.state.reading.scroll > 0; this.selectionMoved = false;
      this.input.setValue(this.state.reading.draft); this.notice = "";
    }
    const w = Math.max(1, width - 4);
    if (this.input.getValue() !== this.state.reading.draft) this.input.setValue(this.state.reading.draft);
    const rows: Row[] = this.chatMode ? wrapped([`当前卡片 · ${this.state.card?.title ?? ""}`], w).map(text => ({ text, accent: true })) : contentRows(this.state, w, this.state.revealed ? -1 : this.selection, true, this.state.reading.details, this.state.reading.sources);
    if (this.chatMode) {
      this.state.acknowledgeReply();
      for (const [index, message] of this.state.messages.entries()) {
        if (this.state.reading.replyStart === index) {
          this.scroll = rows.length + 1;
          this.state.reading.replyStart = undefined;
        }
        rows.push({ text: "" }, { text: message.role === "user" ? "你" : "陪伴助手", accent: true }, ...wrapped([message.text], w).map(text => ({ text })));
      }
      if (!this.state.messages.length) rows.push({ text: "可以问：为什么？举个例子？", muted: true });
      if (this.state.chatError) rows.push(...wrapped([`${this.state.chatError} · Ctrl+R 重试上一条`], w).map(text => ({ text, accent: true })));
    }
    if (!this.state.chat.busy && this.notice.startsWith("上一条还在回答")) this.notice = "草稿已保留，按 Enter 发送";
    if (this.notice) rows.push(...wrapped([this.notice], w).map(text => ({ text, muted: true })));
    const actions = this.chatMode ? `${this.state.chat.busy ? "回答中，可返回主任务 · " : ""}Ctrl+X 停止 · Ctrl+R 重试\nCtrl+S 收藏 · PgUp/PgDn 滚动 · Esc 返回卡片` : !this.state.revealed && this.state.card?.options ? "↑↓ / A–D 选择 · Enter 确认 · 1–4 快答 · Ctrl+R 看答案\n[ 上一张 · n 下一张 · h 历史 · t 追问\ns 收藏 · p 固定 · f 反馈 · o 原文 · Esc 返回" : `? 没看懂 · d ${this.state.reading.details ? "收起" : "展开"}详解 · o ${this.state.reading.sources ? "收起" : "查看"}原文 · f 反馈\n[ 上一张 · n 下一张 · h 历史 · t 追问\ns 收藏 · p 固定 · ↑↓ 滚动 · Esc 返回`;
    const status = statusLine(this.state);
    const compactActions = this.chatMode ? "Esc 返回 · Ctrl+X 停止\nCtrl+R 重试 · Ctrl+S 收藏" : this.state.revealed ? "? 没看懂 · d 详解 · f 反馈\nt 追问 · ↑↓ 滚动 · Esc 返回" : "Enter 确认 · Ctrl+R 答案\nt 追问 · h 历史 · Esc 返回";
    const hints = this.tui.terminal.rows < 22 ? compactActions.split("\n").map(line => truncateToWidth(line, w)).join("\n") : actions;
    const footer = (status ? truncateToWidth(status, w) + "\n" : "") + hints;
    const footerRows = wrapped([footer], w).length;
    const budget = Math.max(1, Math.min(32, this.tui.terminal.rows - 3) - 3 - footerRows - (this.chatMode ? 2 : 0));
    if (this.state.revealed && !this.wasRevealed && !this.chatMode) {
      const feedback = rows.findIndex(row => row.answerStart);
      if (feedback >= 0) this.scroll = feedback;
    }
    this.wasRevealed = this.state.revealed;
    if (this.focusSource) {
      const source = rows.findIndex(row => row.sourceStart);
      if (source >= 0) this.scroll = source;
      this.focusSource = false;
    }
    const contentBudget = rows.length > budget ? Math.max(1, budget - 1) : budget;
    this.scroll = Math.min(this.scroll, Math.max(0, rows.length - (this.chatMode ? contentBudget : 1)));
    if (!this.chatMode && !this.state.revealed && this.selectionMoved) {
      const selected = rows.findIndex(row => row.selected);
      if (selected >= 0 && (selected < this.scroll || selected >= this.scroll + contentBudget)) this.scroll = Math.max(0, selected - contentBudget + 1);
    }
    this.selectionMoved = false;
    const visible = rows.slice(this.scroll, this.scroll + contentBudget);
    if (rows.length > budget && budget > 1) visible.push({ text: `↕ ${this.scroll + 1}–${Math.min(this.scroll + contentBudget, rows.length)} / ${rows.length} 行 · PgUp/PgDn`, muted: true });
    if (this.chatMode) visible.push({ text: "" }, ...this.input.render(w).map(text => ({ text })));
    return frame(visible, width, this.theme, this.chatMode ? "✦ 独立追问 · 返回后继续回答" : "✦ 好奇心陪伴", footer);
  }
}
