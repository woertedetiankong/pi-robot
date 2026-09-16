/** Offline SVG snapshots of the actual terminal components. */
import { writeFileSync, mkdirSync } from "node:fs";
import type { Theme, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Companion } from "../src/controller.ts";
import { SummaryView, Discussion } from "../src/ui.ts";
import { defaults } from "../src/config.ts";
import { warmup } from "../src/warmups.ts";
const colors: Record<string, number> = { border: 36, accent: 35, dim: 90 };
const theme = { fg: (color: string, s: string) => `\x1b[${colors[color] ?? 30}m${s}\x1b[39m`, bg: (_color: string, s: string) => `\x1b[44m${s}\x1b[49m` } as Theme;
const state = new Companion({ ...defaults, format: "quiz" }, { ui: {} } as ExtensionContext, () => {});
state.card = warmup("quiz", [], "缓存"); state.status = "有新卡等待查看 · 主任务继续运行";
const tui = { terminal: { rows: 40, columns: 150 }, requestRender: () => {} } as unknown as TUI;
const focus = new Discussion(state, tui, theme, () => {}, async () => {}); focus.focused = true;
const panels: [string, string, string[]][] = [["summary", "平时 · 最多四行，留出主任务空间", new SummaryView(state, theme).render(64)]];
focus.handleInput("b"); panels.push(["focused", "聚焦 · 原地答题", focus.render(64)]);
focus.handleInput("\r"); panels.push(["answer", "回答 · 结论旁说明范围，直接展示例子和图", focus.render(64)]);
focus.handleInput("\x1b[6~");
panels.push(["diagram", "继续阅读 · 图解默认可见，d 展开补充说明", focus.render(64)]);
state.messages = [{ role: "user", text: "能用更通俗的话解释吗？" }, { role: "assistant", text: "同一份数据过期后，只让一个请求重新取一次，其他请求等它的结果。就像一桌人要菜单，只需要一个人去拿一份，不用每个人都跑去前台。实际系统里，还需要处理等待时间过长或取数据失败的情况。" }];
focus.handleInput("t"); panels.push(["chat", "追问 · 离开后继续，回来接着看", focus.render(64)]);
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const cell = 9, line = 24, width = 616;
const palette: Record<string, string> = { "30": "#29353b", "35": "#555599", "36": "#789994", "90": "#66706f", "39": "#29353b" };
mkdirSync("artifacts", { recursive: true });
for (const [name, title, rows] of panels) {
  const height = rows.length * line + 85;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#f2f5f4"/><text x="20" y="30" font-family="sans-serif" font-size="16" fill="#53645f">${title}</text>`;
  rows.forEach((row, y) => {
    let col = 0, fg = "#29353b", bg = "transparent";
    for (const token of row.replace(/\x1b_[^\x07]*\x07/g, "").split(/(\x1b\[[0-9;]*m)/)) {
      const ansi = /^\x1b\[([0-9;]*)m$/.exec(token);
      if (ansi) { if (ansi[1] === "44") bg = "#deddee"; else if (ansi[1] === "49" || ansi[1] === "0") bg = "transparent"; else fg = palette[ansi[1]] ?? fg; continue; }
      const w = visibleWidth(token) * cell;
      if (bg !== "transparent") svg += `<rect x="${20 + col}" y="${48 + y * line}" width="${w}" height="${line}" fill="${bg}"/>`;
      if (token) svg += `<text x="${20 + col}" y="${66 + y * line}" font-family="Menlo, monospace" font-size="15" fill="${fg}" textLength="${w}" lengthAdjust="spacingAndGlyphs" xml:space="preserve">${escape(token)}</text>`;
      col += w;
    }
  });
  writeFileSync(`artifacts/companion-${name}.svg`, svg + "</svg>");
}
state.close();
