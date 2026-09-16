import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Card, CardReadingState, ChatMessage, Config, LearningPreferences } from "./types.ts";
import { MarkdownSource } from "./knowledge.ts";
import { clean, generate, followup } from "./cards.ts";
import { RequestGate, RequestTimeoutError, CARD_TIMEOUT_MS } from "./scheduler.ts";

export interface HistoryEntry {
  card: Card;
  number: number;
  messages: ChatMessage[];
  selected?: string;
  revealed: boolean;
  unread: boolean;
  unreadReply: boolean;
  gate: RequestGate;
  error: string;
  retryQuestion: string;
  reading: CardReadingState;
}
const reading = (): CardReadingState => ({ draft: "", scroll: 0, chatScroll: Number.MAX_SAFE_INTEGER, details: false, sources: false });
export class Companion {
  readonly history: HistoryEntry[] = [];
  private current?: HistoryEntry;
  private pendingId?: string;
  private freshPreference = false;
  private emptyMessages: ChatMessage[] = [];
  private emptyReading = reading();
  private emptyGate = new RequestGate();
  get card(): Card | undefined { return this.current?.card; }
  set card(card: Card | undefined) { if (card) this.addCard(card, true); else this.current = undefined; }
  get messages(): ChatMessage[] { return this.current?.messages ?? this.emptyMessages; }
  set messages(value: ChatMessage[]) { if (this.current) this.current.messages = value; else this.emptyMessages = value; }
  get selected(): string | undefined { return this.current?.selected; }
  set selected(value: string | undefined) { if (this.current) this.current.selected = value; }
  get revealed(): boolean { return this.current?.revealed ?? false; }
  set revealed(value: boolean) { if (this.current) this.current.revealed = value; }
  get chat(): RequestGate { return this.current?.gate ?? this.emptyGate; }
  get chatError(): string { return this.current?.error ?? ""; }
  get canRetry(): boolean { return !!this.current?.retryQuestion && !this.chat.busy; }
  get reading(): CardReadingState { return this.current?.reading ?? this.emptyReading; }
  get pending(): HistoryEntry | undefined { return this.history.find(e => e.card.id === this.pendingId); }
  get cardNumber(): number { return this.current?.number ?? 1; }
  get backgroundReplies(): number { return this.history.filter(e => e.unreadReply).length; }
  get backgroundChats(): number { return this.history.filter(e => e.gate.busy).length; }
  preferences: LearningPreferences = { difficulty: "balanced", avoidTopics: [] };
  running = false;
  taskFinished = false;
  paused = false;
  pinned = false;
  interacting = false;
  status = "主任务开始后生成卡片 · /companion 设置";
  task = "";
  private timer?: ReturnType<typeof setInterval>;
  private seen: string[] = [];
  private titles: string[] = [];
  private sequence = 0;
  private freshTask = false;
  private version = 0;
  private closed = false;
  readonly generation = new RequestGate();
  knowledge: MarkdownSource;
  constructor(public config: Config, public ctx: ExtensionContext, public changed: () => void) {
    this.knowledge = new MarkdownSource(config.collections, config.selectedCollections);
  }
  private addCard(card: Card, activate: boolean): void {
    const entry: HistoryEntry = { card, number: ++this.sequence, messages: [], revealed: card.kind === "text", unread: true, unreadReply: false, gate: new RequestGate(), error: "", retryQuestion: "", reading: reading() };
    this.history.push(entry);
    if (activate) { this.current = entry; this.pendingId = undefined; } else this.pendingId = card.id;
    while (this.history.length > 20) {
      const index = this.history.findIndex(e => e !== this.current);
      this.history.splice(index, 1)[0].gate.cancel();
    }
  }
  visit(id: string): void {
    const entry = this.history.find(e => e.card.id === id);
    if (!entry) return;
    this.generation.cancel(); this.status = ""; this.current = entry; entry.unread = false;
    if (this.pendingId === id) this.pendingId = undefined;
    this.schedule(); this.changed();
  }
  previous(): void {
    const index = this.history.findIndex(e => e === this.current);
    if (index > 0) this.visit(this.history[index - 1].card.id);
    else { this.status = "已经是最早保留的卡片"; this.changed(); }
  }
  acknowledgeReply(): void { if (this.current) this.current.unreadReply = false; }
  resetBranch(): void {
    this.close(); this.closed = false; this.history.length = 0; this.current = undefined; this.pendingId = undefined;
    this.sequence = 0; this.seen = []; this.titles = []; this.pinned = false; this.task = ""; this.taskFinished = false;
    this.status = "已切换分支，等待新的主任务"; this.changed();
  }
  updateContext(ctx: ExtensionContext): void { this.ctx = ctx; }
  activityEnded(_tool: string, _failed: boolean): void {}
  newTask(prompt: string): void {
    this.version++; this.generation.cancel(); this.freshTask = true; this.task = clean(prompt, 2500); this.taskFinished = false;
  }
  start(): void { this.running = true; this.schedule(); if (!this.card || this.freshTask) { this.freshTask = false; void this.next(); } }
  stop(): void {
    this.running = false; this.taskFinished = true; this.generation.cancel(); this.clearTimer();
    this.status = "主任务已完成 · 可返回查看结果"; this.changed();
  }
  schedule(): void {
    this.clearTimer();
    if (!this.config.enabled || !this.running || this.paused) return;
    const seconds = this.config.usage === "economy" ? Math.max(600, this.config.intervalSeconds) : this.config.intervalSeconds;
    this.timer = setInterval(() => { void this.next(); }, seconds * 1000); this.timer.unref?.();
  }
  private clearTimer(): void { clearInterval(this.timer); this.timer = undefined; }
  reconfigure(config: Config): void {
    this.version++; this.generation.cancel(); this.status = "";
    // Only power-off terminates ongoing conversations; layout/content changes do not.
    if (!config.enabled) this.history.forEach(e => this.cancelEntry(e));
    this.config = config; this.knowledge = new MarkdownSource(config.collections, config.selectedCollections);
    this.schedule(); this.changed();
  }
  async next(manual = false, focused = false): Promise<void> {
    if (this.closed || !this.config.enabled || (this.interacting && !focused) || this.generation.busy || (!manual && (this.paused || this.pinned || !this.running || this.pending))) return;
    if (manual) {
      const index = this.history.findIndex(e => e === this.current), newer = this.history[index + 1];
      if (newer && !this.freshPreference) { this.visit(newer.card.id); return; }
    }
    const version = this.version;
    const mode = this.config.mode === "mixed" ? (this.sequence % 2 === 0 || !this.config.selectedCollections.length ? "task" : "wander") : this.config.mode;
    const format = this.config.usage === "economy" ? "text" : this.config.format === "mixed" ? (Math.floor(this.sequence / 2) % 2 === 0 ? "text" : "quiz") : this.config.format;
    if (mode === "wander" && !this.config.selectedCollections.length) { this.status = "请在设置 → 知识库中添加或选择合集"; this.changed(); return; }
    let stage = "正在读取知识库…";
    const progress = (value: string) => { stage = value; if (version === this.version && !this.closed) { this.status = value; this.changed(); } };
    progress(stage);
    try {
      const card = await this.generation.run(async signal => {
        const sources = mode === "task" ? await this.knowledge.search(this.task, 3, signal) : await this.knowledge.sample(new Set(this.seen), 3, signal);
        signal.throwIfAborted();
        if (mode === "wander" && !sources.length) throw new Error(this.knowledge.warnings[0] ?? "所选合集暂无新内容，请更换合集或稍后重试");
        return generate(this.ctx, this.config, mode, format, this.task, sources, this.titles, signal, this.preferences, progress);
      }, CARD_TIMEOUT_MS);
      if (version !== this.version || this.closed) return;
      if (card && (!this.interacting || focused) && (manual || !this.pinned)) {
        this.addCard(card, manual || !this.current);
        this.freshPreference = false;
        this.titles = [...this.titles, card.title].slice(-12);
        this.seen = [...this.seen, ...card.sources.map(s => s.id)].slice(-30);
        this.status = this.knowledge.warnings[0] ?? "";
      }
    } catch (e) { if (version === this.version) this.status = e instanceof RequestTimeoutError ? `${stage.replace(/…$/, "")}超时（总计 180 秒）；可在设置 → 模型与用量选择更快的模型，或改用文字卡片后重试` : clean((e as Error).message, 220); }
    finally { if (version === this.version) this.changed(); }
  }
  async nextFocused(): Promise<void> { this.pinned = false; await this.next(true, true); }
  async previewCollection(name: string): Promise<void> {
    const version = this.version;
    let stage = "正在读取知识库预览…";
    const progress = (value: string) => { stage = value; if (version === this.version && !this.closed) { this.status = value; this.changed(); } };
    progress(stage);
    try {
      const card = await this.generation.run(async signal => {
        const source = new MarkdownSource(this.config.collections, [name]);
        const sources = await source.sample(new Set(), 3, signal);
        if (!sources.length) throw new Error(source.warnings[0] ?? "这个合集没有可用片段");
        return generate(this.ctx, this.config, "wander", this.config.usage === "economy" || this.config.format !== "quiz" ? "text" : "quiz", "", sources, [], signal, this.preferences, progress);
      }, CARD_TIMEOUT_MS);
      if (card && !this.closed && version === this.version) { this.addCard(card, true); this.status = "知识库预览已就绪"; }
    } catch (e) { if (version === this.version) this.status = e instanceof RequestTimeoutError ? `${stage.replace(/…$/, "")}超时（总计 180 秒）；可在设置 → 模型与用量选择更快的模型后重试` : clean((e as Error).message, 220); }
    finally { if (!this.closed) this.changed(); }
  }
  enter(readCard = true): void { if (this.generation.busy) this.status = ""; this.interacting = true; this.generation.cancel(); if (readCard && this.current) this.current.unread = false; this.changed(); }
  leave(): void { this.interacting = false; this.schedule(); this.changed(); }
  choose(label: string): void {
    if (!this.card?.options?.some(o => o.label === label)) return;
    this.selected = label; this.revealed = true; this.changed();
  }
  feedback(kind: "less" | "easy" | "hard" | "unclear"): void {
    if (kind === "less" && this.card) this.preferences.avoidTopics = [...this.preferences.avoidTopics, this.card.title].slice(-12);
    if (kind === "easy") this.preferences.difficulty = "harder";
    if (kind === "hard") this.preferences.difficulty = "easier";
    this.status = kind === "less" ? "本次会话减少类似话题" : kind === "easy" ? "后续卡片增加一点难度" : kind === "hard" ? "后续卡片从基础讲起" : "可以追问：请换个生活中的例子解释";
    // A queued card was generated before this feedback; keep it in history but allow a fresh request.
    this.pendingId = undefined; this.freshPreference = true; this.changed();
  }
  private cancelEntry(entry: HistoryEntry): void {
    if (!entry.gate.busy) return;
    entry.gate.cancel(); entry.error = "回答已停止，可重试上一条";
    if (!entry.reading.draft) entry.reading.draft = entry.retryQuestion;
  }
  stopChat(): void { if (this.current) this.cancelEntry(this.current); this.changed(); }
  async retry(): Promise<void> { const question = this.current?.retryQuestion; if (question) await this.ask(question, true); }
  async ask(question: string, retry = false): Promise<void> {
    const entry = this.current;
    if (!entry || entry.gate.busy || !question.trim() || this.closed || !this.config.enabled) return;
    const message: ChatMessage = { role: "user", text: clean(question, 3000) };
    if (retry && entry.reading.draft === message.text) entry.reading.draft = "";
    if (!retry) entry.messages.push(message);
    entry.messages = entry.messages.slice(-30); entry.error = ""; entry.retryQuestion = message.text;
    const selection = entry.selected ? [{ role: "user" as const, text: `我选择了 ${entry.selected}。` }] : [];
    const ctx = this.ctx, config = this.config;
    entry.reading.followReply = true; entry.reading.replyStart = undefined;
    const request = entry.gate.run(signal => followup(ctx, config, entry.card, [...selection, ...entry.messages], signal));
    this.changed();
    try {
      const answer = await request;
      if (answer && !this.closed && this.history.includes(entry)) {
        entry.messages.push({ role: "assistant", text: answer }); entry.messages = entry.messages.slice(-30);
        entry.retryQuestion = ""; entry.unreadReply = true;
        if (Boolean(entry.reading.followReply)) entry.reading.replyStart = entry.messages.length - 1;
      }
    } catch (e) {
      if (!this.closed && this.history.includes(entry)) {
        entry.error = clean((e as Error).message, 220);
        if (!entry.reading.draft) entry.reading.draft = message.text;
      }
    }
    finally { if (!this.closed) this.changed(); }
  }
  close(): void {
    this.closed = true; this.version++; this.running = false; this.clearTimer(); this.generation.cancel(); this.history.forEach(e => e.gate.cancel());
  }
}
