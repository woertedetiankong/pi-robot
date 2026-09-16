import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { Card, ChatMessage, FavoriteStore } from "./types.ts";

export class MarkdownFavorites implements FavoriteStore {
  async save(card: Card, messages: ChatMessage[], directory: string): Promise<string> {
    const safeTitle = card.title.replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 60) || "companion";
    const path = resolve(directory, `${card.createdAt.slice(0, 10)}-${safeTitle}-${randomUUID().slice(0, 8)}.md`);
    const lines = ["---", `title: ${JSON.stringify(card.title)}`, `created: ${JSON.stringify(card.createdAt)}`, `kind: ${card.kind}`, "origin: pi-curiosity-companion", "---", "", `# ${card.title}`, "", card.body];
    if (card.scenario) lines.push("", `场景：${card.scenario.phase}`, `目标：${card.scenario.goal}`, `条件：${card.scenario.constraints}`);
    if (card.options) lines.push("", ...card.options.map(o => `- **${o.label}.** ${o.text}`));
    lines.push("", "## 解答", "", ...(card.correct ? [`参考答案：${card.correct}`, ""] : []));
    if (card.lesson) {
      lines.push(card.lesson.summary, "", `适用范围：${card.lesson.scope}`, "", `例子：${card.lesson.example}`);
      if (card.lesson.diagram) lines.push("", "```text", card.lesson.diagram, "```");
      lines.push("", "### 补充说明", "");
    }
    lines.push(card.answer);
    if (card.options) lines.push("", ...card.options.map(o => `- **${o.label}：** ${o.feedback ? o.feedback + " " : ""}${o.explanation}`));
    lines.push("", "## 来源", "", ...(card.sources.length ? card.sources.map(s => `- [${s.collection} / ${s.heading || s.path.split("/").pop()}](${pathToFileURL(s.path).href}) — 第 ${s.line} 行`) : [card.origin === "builtin" ? "插件内置的精选暖场题；未引用本地笔记。" : "模型生成的启发；未引用本地笔记。"]));
    if (messages.length) lines.push("", "## 独立追问", "", ...messages.flatMap(m => [`### ${m.role === "user" ? "我" : "陪伴助手"}`, "", m.text, ""]));
    await mkdir(directory, { recursive: true });
    await writeFile(path, lines.join("\n") + "\n", { flag: "wx" });
    return path;
  }
}
