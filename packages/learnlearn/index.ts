import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./src/config.ts";
import { Companion } from "./src/controller.ts";
import { CompanionView } from "./src/ui.ts";
import { CompanionMenus } from "./src/menus.ts";
import { clean } from "./src/cards.ts";

export default function companionExtension(pi: ExtensionAPI): void {
  let state: Companion | undefined, view: CompanionView | undefined, menus: CompanionMenus | undefined;
  let menuOpen = false, epoch = 0;
  const valid = (ctx: ExtensionContext) => ctx.hasUI && ctx.mode === "tui";
  const notifyError = (ctx: ExtensionContext, e: unknown) => ctx.ui.notify(clean((e as Error).message, 300), "error");
  const teardown = () => { epoch++; state?.close(); view?.hide(); state = undefined; view = undefined; menus = undefined; menuOpen = false; };
  pi.on("session_start", async (_event, ctx) => {
    teardown(); if (!valid(ctx)) return;
    const current = epoch, { config, warnings } = await loadConfig(ctx.cwd, ctx.isProjectTrusted());
    if (current !== epoch) return;
    const created = new Companion(config, ctx, () => view?.changed());
    state = created; view = new CompanionView(created);
    menus = new CompanionMenus(created, () => state === created, () => view?.remount()); view.changed();
    if (warnings.length) ctx.ui.notify(warnings.join("\n"), "warning");
    if (config.enabled) ctx.ui.notify("陪伴使用独立模型请求，会产生额外用量。/companion economy 开启省用量（文字、至少 10 分钟一次）；/companion off 关闭。", "info");
  });
  pi.on("session_shutdown", teardown);
  pi.on("session_tree", () => { view?.hide(); state?.resetBranch(); });
  pi.on("before_agent_start", (event, ctx) => { if (state) { state.updateContext(ctx); state.newTask(event.prompt); } });
  pi.on("agent_start", (_event, ctx) => { if (state) { state.updateContext(ctx); state.start(); } });
  pi.on("agent_settled", () => state?.stop());
  pi.on("model_select", (_event, ctx) => state?.updateContext(ctx));

  async function toggle(ctx: ExtensionContext): Promise<void> {
    if (!state || !valid(ctx)) return;
    state.updateContext(ctx); state.reconfigure({ ...state.config, enabled: !state.config.enabled });
    if (state.config.enabled && state.running) void state.next();
  }
  async function open(ctx: ExtensionContext, chat = false): Promise<void> {
    if (!state || !view || !menus || !valid(ctx) || menuOpen) return;
    state.updateContext(ctx);
    if (!state.config.enabled) {
      ctx.ui.notify("陪伴已关闭。使用 /companion on 开启，再用 /companion open 查看卡片。", "info");
      return;
    }
    if (!state.card) { await state.next(true); if (!state.card) return; }
    const actions = menus;
    await view.open(() => actions.save(), chat, async () => { await actions.history(); }, clarify => actions.feedback(clarify));
  }
  async function menu(ctx: ExtensionContext, direct?: "history" | "settings" | "save"): Promise<void> {
    const current = state, actions = menus;
    if (!current || !actions || !valid(ctx) || current.interacting || menuOpen) return;
    current.updateContext(ctx); menuOpen = true; view?.suspend(); current.enter(false);
    let openAfter = false, nextAfter = false;
    try {
      if (direct === "history") openAfter = await actions.history();
      else if (direct === "settings") openAfter = await actions.settings();
      else if (direct === "save") await actions.save();
      else {
        const pick = await ctx.ui.select("✦ 好奇心陪伴", ["看卡片", current.pending ? "查看新卡" : "下一张", "最近卡片", current.paused ? "恢复自动更新" : "暂停自动更新", "设置"]);
        if (state !== current) return;
        if (pick === "看卡片") openAfter = true;
        else if (pick === "下一张" || pick === "查看新卡") nextAfter = true;
        else if (pick === "最近卡片") openAfter = await actions.history();
        else if (pick === "暂停自动更新" || pick === "恢复自动更新") { current.paused = !current.paused; current.schedule(); }
        else if (pick === "设置") openAfter = await actions.settings();
      }
    } finally { menuOpen = false; if (state === current) { current.leave(); view?.resume(); } }
    if (state !== current) return;
    if (nextAfter) { current.pinned = false; await current.next(true); }
    if (openAfter) await open(ctx);
  }
  pi.registerCommand("companion", {
    description: "好奇心卡片、最近历史、独立追问与设置",
    handler: async (args, ctx) => {
      if (!valid(ctx) || !state) return;
      state.updateContext(ctx);
      try {
        const command = args.trim();
        if (command === "on" || command === "off") { if (state.config.enabled !== (command === "on")) await toggle(ctx); }
        else if (command === "next") { if (!state.interacting) { state.pinned = false; await state.next(true); } }
        else if (command === "previous") state.previous();
        else if (command === "chat") await open(ctx, true);
        else if (command === "open") await open(ctx);
        else if (command === "save" || command === "history" || command === "settings") await menu(ctx, command);
        else if (command === "economy" || command === "standard") { state.reconfigure({ ...state.config, usage: command }); ctx.ui.notify(`已在本次会话使用${command === "economy" ? "省用量模式" : "标准模式"}；可在设置中选择保存范围`, "info"); }
        else await menu(ctx);
      } catch (e) { notifyError(ctx, e); }
    },
  });
  pi.registerShortcut("ctrl+alt+j", { description: "展开陪伴卡片 / 答题", handler: async ctx => { try { await open(ctx); } catch (e) { notifyError(ctx, e); } } });
  pi.registerShortcut("ctrl+alt+n", { description: "下一张陪伴卡片", handler: async ctx => { if (state && valid(ctx) && !state.interacting) { state.updateContext(ctx); state.pinned = false; await state.next(true); } } });
  pi.registerShortcut("ctrl+alt+h", { description: "开启 / 关闭好奇心陪伴", handler: toggle });
}
