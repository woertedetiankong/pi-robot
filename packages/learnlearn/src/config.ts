import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Config, Collection } from "./types.ts";

export const defaults: Config = {
  enabled: true, mode: "mixed", format: "mixed", layout: "summary", usage: "standard", intervalSeconds: 120,
  selectedCollections: [], collections: {},
};
export function expandPath(path: string, base: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(base, path);
}
export function userConfigPath(): string {
  return resolve(process.env.PI_CODING_AGENT_DIR || resolve(homedir(), ".pi/agent"), "companion.json");
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === "string");
}
export function parseConfig(value: unknown, base: string): Partial<Config> {
  if (!object(value)) throw new Error("配置必须是 JSON 对象");
  const result: Partial<Config> = {};
  for (const [key, allowed] of Object.entries({ mode: ["task", "wander", "mixed"], format: ["text", "quiz", "mixed"], layout: ["summary", "widget", "overlay"], usage: ["standard", "economy"] })) {
    if (key in value) {
      if (!allowed.includes(value[key] as string)) throw new Error(`${key} 配置无效`);
      Object.assign(result, { [key]: value[key] });
    }
  }
  if ("enabled" in value) {
    if (typeof value.enabled !== "boolean") throw new Error("enabled 必须是布尔值");
    result.enabled = value.enabled;
  }
  if ("intervalSeconds" in value) {
    if (typeof value.intervalSeconds !== "number" || !Number.isFinite(value.intervalSeconds) || value.intervalSeconds < 30 || value.intervalSeconds > 86400) throw new Error("更新间隔必须在 30–86400 秒之间");
    result.intervalSeconds = value.intervalSeconds;
  }
  if ("model" in value && value.model !== null) {
    if (!object(value.model) || typeof value.model.provider !== "string" || typeof value.model.id !== "string" || !value.model.id || !value.model.provider) throw new Error("model 需要 provider 和 id");
    result.model = { provider: value.model.provider, id: value.model.id };
  } else if (value.model === null) result.model = undefined;
  if ("selectedCollections" in value) {
    if (!strings(value.selectedCollections)) throw new Error("selectedCollections 必须是字符串数组");
    result.selectedCollections = [...new Set(value.selectedCollections)];
  }
  if ("saveDirectory" in value) {
    if (typeof value.saveDirectory !== "string" || !value.saveDirectory.trim()) throw new Error("saveDirectory 必须是非空路径");
    result.saveDirectory = expandPath(value.saveDirectory, base);
  }
  if ("collections" in value) {
    if (!object(value.collections)) throw new Error("collections 必须是对象");
    const collections: Record<string, Collection> = Object.create(null);
    for (const [name, c] of Object.entries(value.collections)) {
      if (!object(c) || !strings(c.directories) || !c.directories.length || c.directories.some(p => !p.trim())) throw new Error(`合集 ${name} 需要 directories`);
      for (const field of ["include", "exclude"]) {
        if (field in c && !strings(c[field])) throw new Error(`${name}.${field} 必须是字符串数组`);
      }
      collections[name] = { directories: c.directories.map(p => expandPath(p, base)), include: c.include as string[] | undefined, exclude: c.exclude as string[] | undefined };
    }
    result.collections = collections;
  }
  return result;
}
async function readConfig(path: string, base: string): Promise<Partial<Config>> {
  try { return parseConfig(JSON.parse(await readFile(path, "utf8")), base); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}; throw new Error(`${path}: ${(e as Error).message}`); }
}
export async function loadConfig(cwd: string, trusted = true, userPath = userConfigPath()): Promise<{ config: Config; warnings: string[] }> {
  const warnings: string[] = [];
  const safe = async (path: string, base: string) => {
    try { return await readConfig(path, base); } catch (e) { warnings.push((e as Error).message); return {}; }
  };
  const user = await safe(userPath, dirname(userPath));
  const project = trusted ? await safe(resolve(cwd, ".pi/companion.json"), cwd) : {};
  const config = { ...defaults, ...user, ...project, collections: { ...user.collections, ...project.collections } };
  return { config, warnings };
}
// Only explicit settings actions persist; session-only switches never call this.
export async function savePreferences(config: Config, path = userConfigPath()): Promise<void> {
  const { collections: _collections, ...preferences } = config;
  await saveConfigPatch({ ...preferences, model: config.model ?? null }, path);
}
export type ConfigPatch = Omit<Partial<Config>, "model"> & { model?: Config["model"] | null };
// Merge only explicitly edited fields. Inherited project settings must never leak into global defaults.
export async function saveConfigPatch(patch: ConfigPatch, path = userConfigPath()): Promise<void> {
  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(await readFile(path, "utf8")); if (!object(existing)) throw new Error("配置不是对象"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const next = { ...existing, ...patch, ...(patch.collections ? { collections: { ...(object(existing.collections) ? existing.collections : {}), ...patch.collections } } : {}) };
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, path);
}
