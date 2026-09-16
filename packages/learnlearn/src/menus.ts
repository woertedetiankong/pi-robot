import { resolve } from "node:path";
import type { Companion } from "./controller.ts";
import { expandPath, loadConfig, saveConfigPatch, userConfigPath, type ConfigPatch } from "./config.ts";
import { MarkdownSource } from "./knowledge.ts";
import { MarkdownFavorites } from "./favorites.ts";
import type { Config } from "./types.ts";

export class CompanionMenus {
  scope: "session" | "project" | "user" = "session";
  private favorites = new MarkdownFavorites();
  constructor(private state: Companion, private valid: () => boolean, private remount: () => void) {}
  private get ui() { return this.state.ctx.ui; }
  private get scopeLabel(): string { return { session: "当前会话", project: "当前项目", user: "所有项目的默认值" }[this.scope]; }
  async update(patch: ConfigPatch): Promise<void> {
    if (!this.valid()) return;
    if (this.scope === "project" && !this.state.ctx.isProjectTrusted()) throw new Error("请先信任当前项目，才能保存项目设置；也可选择当前会话或用户默认值");
    if (this.scope !== "session") await saveConfigPatch(patch, this.scope === "project" ? resolve(this.state.ctx.cwd, ".pi/companion.json") : userConfigPath());
    if (!this.valid()) return;
    const config: Config = { ...this.state.config, ...patch, model: "model" in patch ? patch.model ?? undefined : this.state.config.model, collections: { ...this.state.config.collections, ...patch.collections } };
    this.state.reconfigure(config); this.remount();
    this.ui.notify(`已应用到${this.scopeLabel}${this.scope === "user" ? "；项目显式配置下次加载仍优先" : ""}`, "info");
  }
  async save(): Promise<void> {
    const card = this.state.card;
    if (!card) { this.ui.notify("还没有可收藏的卡片", "info"); return; }
    const messages = [...this.state.messages];
    let directory = this.state.config.saveDirectory;
    const rememberDirectory = !directory;
    if (!directory) {
      const input = await this.ui.input("收藏目录（直接 Enter 使用 .pi/companion-favorites；首次收藏会记住目录）", ".pi/companion-favorites");
      if (input === undefined || !this.valid()) return;
      directory = expandPath(input.trim() || ".pi/companion-favorites", this.state.ctx.cwd);
    }
    const include = messages.length ? await this.ui.select("收藏内容", ["卡片与追问", "仅卡片"]) : "仅卡片";
    if (!include || !this.valid()) return;
    const path = await this.favorites.save(card, include === "卡片与追问" ? messages : [], directory);
    this.state.config.saveDirectory = directory;
    if (rememberDirectory) {
      try { await saveConfigPatch({ saveDirectory: directory }); }
      catch { this.ui.notify("卡片已收藏；目录未能记住，下次需重新选择", "warning"); }
    }
    this.ui.notify(`已收藏：${path}`, "info");
  }
  async history(): Promise<boolean> {
    if (!this.state.history.length) { this.ui.notify("还没有卡片，可先换一张", "info"); return false; }
    const entries = [...this.state.history].reverse();
    const labels = entries.map(e => `${e.card.id === this.state.card?.id ? "✓ " : ""}第 ${e.number} 张 · ${e.card.title}${e.gate.busy ? " · 回答中" : e.unreadReply ? " · 新回复" : e.unread ? " · 未读" : ""}`);
    const pick = await this.ui.select("最近 20 张 · 本次会话（保留答案与追问）", labels);
    if (!pick || !this.valid()) return false;
    this.state.visit(entries[labels.indexOf(pick)].card.id); return true;
  }
  async feedback(clarify = false): Promise<boolean> {
    const cardId = this.state.card?.id;
    const current = () => this.valid() && !!cardId && this.state.card?.id === cardId;
    const pick = clarify ? "解释不清楚" : await this.ui.select("这张卡片怎么样？仅影响本次会话", ["这个话题少一点", "太简单", "太难", "解释不清楚", "恢复默认偏好"]);
    if (!pick || !current()) return false;
    if (pick === "解释不清楚") {
      if (this.state.chat.busy) { this.ui.notify("这张卡片正在回答，稍后可继续追问", "info"); return true; }
      const focus = await this.ui.select("哪里没懂？选择后进入独立追问", ["换个例子", "这个词是什么意思", "为什么会这样", "我的理解对吗"]);
      if (!focus || !current()) return false;
      let question = "请换一个具体的小例子讲清当前卡片，先说谁做了什么、实际发生什么，并说明适用条件。不要重讲所有选项；流程有助于理解时配一张短图。";
      if (focus !== "换个例子") {
        const title = focus === "这个词是什么意思" ? "输入没看懂的词或一句话" : focus === "为什么会这样" ? "输入想弄清原因的那句话" : "用自己的话说说你的理解";
        const input = await this.ui.input(title, focus === "这个词是什么意思" ? "例如：再次委派" : focus === "为什么会这样" ? "例如：为什么检查后就直接返回了？" : "例如：是不是所有子智能体都不能再找帮手？");
        if (!input?.trim() || !current()) return false;
        if (input.trim().length > 1000) { this.ui.notify("请把问题缩短到 1000 字以内再发送", "info"); return false; }
        const quoted = JSON.stringify(input.trim());
        question = focus === "这个词是什么意思"
          ? `我没看懂这个词或句子：${quoted}。请先用日常语言解释它在当前卡片中的意思，说清谁做什么，再给一个短例子。不要拿另一个陌生术语解释它，也不要重讲整张卡片。`
          : focus === "为什么会这样"
            ? `我想弄清这句话的原因：${quoted}。请按“做了什么，所以发生什么”解释，必要时画短流程图。区分来源中能确定的行为与对设计原因的猜测，不要编造动机。`
            : `我的理解是：${quoted}。请先明确哪些对、哪些需要修正，指出适用条件；不要把这段代码的局部规则说成所有系统的通用规则，然后给一句更准确的表述。`;
      }
      if (!current()) return false;
      if (this.state.chat.busy) { this.ui.notify("这张卡片正在回答，稍后可继续追问", "info"); return true; }
      void this.state.ask(question); return true;
    }
    if (pick === "恢复默认偏好") { this.state.preferences = { difficulty: "balanced", avoidTopics: [] }; this.state.status = "已恢复默认偏好"; this.state.changed(); return false; }
    const kind = pick === "这个话题少一点" ? "less" : pick === "太简单" ? "easy" : "hard";
    this.state.feedback(kind);
    return false;
  }
  async addCollection(): Promise<boolean> {
    const input = await this.ui.input("添加知识库目录（支持 Obsidian 文件夹、~/ 和项目相对路径）", "./docs");
    if (!input?.trim() || !this.valid()) return false;
    const directory = expandPath(input.trim(), this.state.ctx.cwd);
    const name = await this.ui.input("合集名称", directory.split("/").pop() || "我的笔记");
    if (name === undefined || !this.valid()) return false;
    const label = name.trim() || directory.split("/").pop() || "我的笔记";
    if (Object.hasOwn(this.state.config.collections, label)) { this.ui.notify("合集名称已存在，请使用新名称；已有合集可在选择合集中启用", "warning"); return false; }
    this.ui.notify("正在检查可读笔记…", "info");
    const collection = { directories: [directory] };
    const source = new MarkdownSource({ [label]: collection }, [label]);
    await source.refresh();
    if (!this.valid()) return false;
    const { files, fragments } = source.stats;
    if (!fragments) { this.ui.notify(source.warnings[0] ?? "未找到可用笔记：需要 .md/.markdown，且正文片段至少 20 字符", "warning"); return false; }
    if (source.warnings.length) this.ui.notify(source.warnings.slice(0, 3).join("\n"), "warning");
    const pick = await this.ui.select(`找到 ${files} 篇可读笔记、${fragments} 个片段 · 保存到${this.scopeLabel}`, ["添加并预览一张（独立模型用量）", "仅添加", "取消"]);
    if (!pick || pick === "取消" || !this.valid()) return false;
    await this.update({ collections: { [label]: collection }, selectedCollections: [...new Set([...this.state.config.selectedCollections, label])] });
    if (pick.startsWith("添加并预览")) {
      // Preview explicitly uses only the newly checked collection, without changing the saved content mode.
      await this.state.previewCollection(label); return true;
    }
    return false;
  }
  async settings(): Promise<boolean> {
    let preview = false;
    while (this.valid()) {
      const action = await this.ui.select(`设置 · 修改应用到${this.scopeLabel}`, ["保存范围", "内容", "知识库", "显示", "模型与用量", "收藏目录", this.state.config.enabled ? "关闭陪伴" : "开启陪伴", "重新加载配置", "返回"]);
      if (!action || action === "返回" || !this.valid()) break;
      if (action === "保存范围") {
        const choices = ["当前会话（关闭后不保留）", "当前项目", "所有项目的默认值"];
        const pick = await this.ui.select("之后的修改保存到哪里？", choices);
        if (pick && this.valid()) this.scope = (["session", "project", "user"] as const)[choices.indexOf(pick)];
      } else if (action === "内容") {
        const action = await this.ui.select("内容", ["内容模式", "卡片形式", "返回"]);
        if (action === "内容模式") {
          const names = ["任务相关", "知识漫游", "混合"];
          const pick = await this.ui.select(`内容模式 · 当前 ${this.state.config.mode}`, names);
          if (pick) await this.update({ mode: (["task", "wander", "mixed"] as const)[names.indexOf(pick)] });
        } else if (action === "卡片形式") {
          const names = ["文字", "ABCD 选择题", "混合"];
          const pick = await this.ui.select(`卡片形式 · 当前 ${this.state.config.format}${this.state.config.usage === "economy" ? "（省用量模式实际生成文字）" : ""}`, names);
          if (pick) await this.update({ format: (["text", "quiz", "mixed"] as const)[names.indexOf(pick)] });
        }
      } else if (action === "知识库") {
        const action = await this.ui.select("知识库", ["添加目录", "选择合集", "检查当前合集", "返回"]);
        if (action === "添加目录") { if (await this.addCollection()) { preview = true; break; } }
        else if (action === "检查当前合集") {
          await this.state.knowledge.refresh();
          const stats = this.state.knowledge.stats;
          this.ui.notify(`${stats.files} 篇可读笔记、${stats.fragments} 个片段${this.state.knowledge.warnings.length ? "\n" + this.state.knowledge.warnings.join("\n") : ""}`, "info");
        } else if (action === "选择合集") {
          const names = Object.keys(this.state.config.collections), selected = new Set(this.state.config.selectedCollections);
          if (!names.length) { this.ui.notify("还没有合集，请选择添加目录", "info"); continue; }
          while (this.valid()) {
            const labels = names.map(n => `${selected.has(n) ? "☑" : "☐"} ${n}`);
            const pick = await this.ui.select("选择合集（可多选，完成后生效）", ["完成", ...labels]);
            if (!pick) break;
            if (pick === "完成") { await this.update({ selectedCollections: [...selected] }); break; }
            const name = names[labels.indexOf(pick)]; if (selected.has(name)) selected.delete(name); else selected.add(name);
          }
        }
      } else if (action === "显示") {
        const layouts = [{ value: "summary" as const, label: "摘要（最多 4 行）" }, { value: "widget" as const, label: "完整卡片 · 输入框上方" }, { value: "overlay" as const, label: "完整卡片 · 右侧浮层（可能遮挡输出）" }];
        const labels = layouts.map(l => l.label + (l.value === this.state.config.layout ? " ✓ 当前" : ""));
        const pick = await this.ui.select("卡片位置 · 小窗口自动使用摘要", labels);
        if (pick) await this.update({ layout: layouts[labels.indexOf(pick)].value });
      } else if (action === "模型与用量") {
        const action = await this.ui.select(`独立模型请求会产生额外用量 · 当前 ${this.state.config.usage === "economy" ? "省用量" : "标准"}`, ["选择模型", "标准用量", "省用量（文字卡片、自动间隔至少 10 分钟）", "更新间隔", "返回"]);
        if (action === "选择模型") {
          const models = this.state.ctx.modelRegistry.getAvailable();
          const choices = ["跟随主任务模型", ...models.map(m => `${m.provider} / ${m.id}`)];
          const pick = await this.ui.select("陪伴模型", choices);
          if (pick === choices[0]) await this.update({ model: null });
          else if (pick) { const model = models[choices.indexOf(pick) - 1]; await this.update({ model: { provider: model.provider, id: model.id } }); }
        } else if (action === "标准用量") await this.update({ usage: "standard" });
        else if (action?.startsWith("省用量")) await this.update({ usage: "economy" });
        else if (action === "更新间隔") {
          const input = await this.ui.input("自动更新间隔（秒，30–86400；省用量模式至少 600）", String(this.state.config.intervalSeconds));
          if (input !== undefined) {
            const seconds = Number(input);
            if (!Number.isFinite(seconds) || seconds < 30 || seconds > 86400) this.ui.notify("请输入 30–86400 之间的秒数", "warning");
            else await this.update({ intervalSeconds: seconds });
          }
        }
      } else if (action === "收藏目录") {
        const input = await this.ui.input("收藏目录", this.state.config.saveDirectory ?? ".pi/companion-favorites");
        if (input?.trim()) await this.update({ saveDirectory: expandPath(input.trim(), this.state.ctx.cwd) });
      } else if (action === "关闭陪伴" || action === "开启陪伴") await this.update({ enabled: !this.state.config.enabled });
      else if (action === "重新加载配置") {
        const { config, warnings } = await loadConfig(this.state.ctx.cwd, this.state.ctx.isProjectTrusted());
        if (this.valid()) { this.state.reconfigure(config); this.remount(); if (warnings.length) this.ui.notify(warnings.join("\n"), "warning"); }
      }
    }
    return preview;
  }
}
