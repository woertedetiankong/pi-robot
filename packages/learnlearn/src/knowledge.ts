import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, relative, extname } from "node:path";
import { createHash } from "node:crypto";
import type { Collection, KnowledgeSource, Source } from "./types.ts";

export function glob(pattern: string): RegExp {
  let result = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      i++;
      if (pattern[i + 1] === "/") { i++; result += "(?:.*/)?"; } else result += ".*";
    } else if (c === "*") result += "[^/]*";
    else if (c === "?") result += "[^/]";
    else result += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(result + "$");
}
function tokens(text: string): string[] {
  const lower = text.toLowerCase();
  const latin = lower.match(/[a-z0-9_]{2,}/g) ?? [];
  const han = lower.match(/\p{Script=Han}+/gu) ?? [];
  return [...new Set([...latin, ...han.flatMap(s => s.length === 1 ? [s] : Array.from({ length: s.length - 1 }, (_, i) => s.slice(i, i + 2)))])];
}
export function chunks(text: string, path: string, collection: string): Source[] {
  const result: Source[] = [];
  const lines = text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, m => "\n".repeat(m.split("\n").length - 1)).split(/\r?\n/);
  let heading = "", body: string[] = [], start = 1, fenced = false;
  const flush = () => {
    const content = body.join("\n").trim(); body = [];
    if (content.length < 20) return;
    result.push({ id: createHash("sha256").update(`${path}:${start}:${content}`).digest("hex").slice(0, 20), path, heading, line: start, text: content.slice(0, 2400), collection });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const title = !fenced && /^#{1,6}\s+(.+)/.exec(line);
    if (title) { flush(); heading = title[1]; start = i + 2; }
    else {
      if (!body.length) start = i + 1;
      body.push(line);
      if (body.join("\n").length >= 1800) flush();
    }
  }
  flush(); return result;
}
export class MarkdownSource implements KnowledgeSource {
  private cache = new Map<string, { stamp: string; sources: Source[] }>();
  private entries: Source[] = [];
  warnings: string[] = [];
  get stats(): { files: number; fragments: number } {
    return { files: new Set(this.entries.map(s => s.path)).size, fragments: this.entries.length };
  }
  constructor(private collections: Record<string, Collection>, private selected: string[]) {}
  async refresh(signal?: AbortSignal): Promise<void> {
    const next: Source[] = [], seen = new Set<string>();
    this.warnings = [];
    let count = 0, bytes = 0;
    for (const name of this.selected) {
      const c = this.collections[name];
      if (!c) { this.warnings.push(`合集不存在：${name}`); continue; }
      const include = (c.include ?? ["**/*.md", "**/*.markdown"]).map(glob);
      const exclude = (c.exclude ?? []).map(glob);
      for (const directory of c.directories) {
        const root = resolve(directory);
        const walk = async (dir: string): Promise<void> => {
          signal?.throwIfAborted();
          if (bytes > 32 * 1024 * 1024 || count > 5000) return;
          let files;
          try { files = await readdir(dir, { withFileTypes: true }); }
          catch { this.warnings.push(`无法读取目录：${dir}`); return; }
          for (const file of files) {
            signal?.throwIfAborted();
            if (bytes > 32 * 1024 * 1024 || count > 5000) return;
            if (file.name.startsWith(".") || ["node_modules", "vendor", "dist"].includes(file.name)) continue;
            const path = resolve(dir, file.name), rel = relative(root, path).split("\\").join("/");
            if (exclude.some(r => r.test(rel) || r.test(rel + "/"))) continue;
            if (file.isDirectory()) { if (count < 5000) await walk(path); continue; }
            if (!file.isFile() || ![".md", ".markdown"].includes(extname(path).toLowerCase()) || !include.some(r => r.test(rel)) || seen.has(path)) continue;
            seen.add(path);
            if (++count > 5000) continue;
            try {
              const info = await stat(path);
              bytes += info.size;
              if (bytes > 32 * 1024 * 1024) { this.warnings.push("知识库超过 32 MiB 索引预算，请缩小合集目录"); break; }
              if (info.size > 512 * 1024) { this.warnings.push(`跳过大文件：${rel}`); continue; }
              const stamp = `${info.mtimeMs}:${info.size}:${name}`;
              let item = this.cache.get(path);
              if (!item || item.stamp !== stamp) {
                item = { stamp, sources: chunks(await readFile(path, "utf8"), path, name) }; this.cache.set(path, item);
              }
              next.push(...item.sources);
            } catch { this.warnings.push(`无法读取笔记：${rel}`); }
          }
        };
        await walk(root);
      }
    }
    if (count > 5000) this.warnings.push("知识库超过 5000 个文件，已限制索引范围；请缩小合集目录");
    for (const path of this.cache.keys()) if (!seen.has(path)) this.cache.delete(path);
    this.entries = next;
  }
  async search(query: string, limit = 3, signal?: AbortSignal): Promise<Source[]> {
    await this.refresh(signal);
    const terms = tokens(query);
    return this.entries.map(source => {
      const title = source.heading.toLowerCase(), body = source.text.toLowerCase();
      return { source, score: terms.reduce((sum, t) => sum + (title.includes(t) ? 4 : 0) + (body.includes(t) ? 1 : 0), 0) };
    }).filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(s => s.source);
  }
  async sample(exclude: Set<string>, limit = 3, signal?: AbortSignal): Promise<Source[]> {
    await this.refresh(signal);
    const candidates = this.entries.filter(s => !exclude.has(s.id));
    // Fisher-Yates over indices, never mutate the index itself.
    for (let i = candidates.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [candidates[i], candidates[j]] = [candidates[j], candidates[i]]; }
    return candidates.slice(0, limit);
  }
  async read(id: string): Promise<Source | undefined> { return this.entries.find(s => s.id === id); }
}
