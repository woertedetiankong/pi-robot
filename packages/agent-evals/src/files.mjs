import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
export function inside(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
export function contained(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw new Error(`Expected a relative path: ${relative}`);
  const target = path.resolve(root, relative);
  if (!inside(root, target)) throw new Error(`Path escapes root: ${relative}`);
  return target;
}
export async function safePath(root, relative) {
  const target = contained(root, relative);
  let current = target;
  while (!(await exists(current))) current = path.dirname(current);
  if (!inside(await fs.realpath(root), await fs.realpath(current))) throw new Error(`Symlink escapes root: ${relative}`);
  return target;
}
export async function walk(root, prefix = '', {excludePaths = [], excludeNames = []} = {}) {
  const result = [];
  for (const entry of (await fs.readdir(path.join(root, prefix), { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    const rel = path.posix.join(prefix, entry.name);
    if (excludeNames.includes(entry.name) || excludePaths.some(excluded=>inside(excluded,path.join(root,rel)))) continue;
    if (entry.isSymbolicLink()) throw new Error(`Symlinks are not allowed in eval inputs or output: ${rel}`);
    if (entry.isDirectory()) result.push(...await walk(root, rel, {excludePaths,excludeNames}));
    else if (entry.isFile()) result.push(rel);
  }
  return result;
}
export async function snapshot(root) {
  const result = {};
  for (const file of await walk(root)) {
    const stat = await fs.stat(path.join(root, file));
    if (stat.size > 8 * 1024 * 1024) { result[file] = `large:${stat.size}:${stat.mtimeMs}`; continue; }
    result[file] = crypto.createHash('sha256').update(await fs.readFile(path.join(root, file))).digest('hex');
  }
  return result;
}
export async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2) + '\n');
}
export async function readText(file, limit = 2 * 1024 * 1024) {
  if ((await fs.stat(file)).size > limit) throw new Error(`File exceeds ${limit} bytes: ${file}`);
  const value = await fs.readFile(file, 'utf8');
  if (value.includes('\0')) throw new Error(`Binary grading targets are unsupported: ${file}`);
  return value;
}
