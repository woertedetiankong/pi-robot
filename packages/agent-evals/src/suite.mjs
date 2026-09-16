import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { minimatch } from 'minimatch';
import { contained, exists, readText, safePath } from './files.mjs';

const CASE_KEYS = ['schema_version','name','description','tags','runs','expected_outcome','model','provider','max_turns','timeout_seconds','allowed_tools','append_system_prompt','env'];
const GRADER_KEYS = ['name','type','weight','arm','pattern','flags','match','target','tool','input_match','min','max','before','after','path','exists','criteria','focus','baseline_file'];
export function keys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a mapping`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unsupported ${label} field: ${key}`);
}
export function number(value, fallback, min, max, label, integer = false) {
  value ??= fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`Invalid ${label}: ${value}`);
  return value;
}
export function markdown(text) {
  text = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return { meta: {}, body: text.trim() };
  const end = text.indexOf('\n---\n', 4);
  if (end < 0) throw new Error('Unclosed Markdown frontmatter');
  return { meta: parse(text.slice(4, end)) ?? {}, body: text.slice(end + 5).trim() };
}
function strings(value, label) {
  if (!Array.isArray(value) || value.some(x => typeof x !== 'string')) throw new Error(`${label} must be a string array`);
  return value;
}
function target(value) {
  if (value === undefined) return;
  if (['last_message','trace','files','mock_calls'].includes(value)) return;
  keys(value, ['source','path'], 'grader target');
  if (value.source !== 'file' || typeof value.path !== 'string') throw new Error('Target requires source: file and path');
  contained('/workspace', value.path);
}
export function validateGrader(g) {
  keys(g, GRADER_KEYS, 'grader');
  if (!['regex','tool_used','tool_order','file_exists','llm','baseline'].includes(g.type)) throw new Error(`Unsupported grader: ${g.type}`);
  g.weight = number(g.weight, 1, Number.MIN_VALUE, 1e6, 'weight');
  if (g.arm && !['both','with-only'].includes(g.arm)) throw new Error(`Invalid arm: ${g.arm}`);
  target(g.target); target(g.focus);
  if (g.type === 'regex') {
    if (typeof g.pattern !== 'string') throw new Error('regex requires pattern');
    new RegExp(g.pattern, g.flags ?? '');
    if (g.match && !['contains','not_contains'].includes(g.match) && !/^count:\d+$/.test(g.match)) throw new Error(`Invalid regex match: ${g.match}`);
  }
  if (g.type === 'tool_used') {
    if (typeof g.tool !== 'string') throw new Error('tool_used requires tool');
    g.min = number(g.min, 1, 0, 1e6, 'min', true);
    g.max = number(g.max, 1e6, g.min, 1e6, 'max', true);
    if (g.input_match) new RegExp(g.input_match);
  }
  if (g.type === 'tool_order') for (const spec of [g.before,g.after]) {
    if (typeof spec === 'string') continue;
    keys(spec, ['tool','input_match'], 'tool matcher');
    if (typeof spec.tool !== 'string') throw new Error('tool_order requires tool names');
    if (spec.input_match) new RegExp(spec.input_match);
  }
  if (g.type === 'file_exists') {
    if (typeof g.path !== 'string') throw new Error('file_exists requires path');
    if (g.exists !== undefined && typeof g.exists !== 'boolean') throw new Error('exists must be boolean');
  }
  if (['llm','baseline'].includes(g.type) && (typeof g.criteria !== 'string' || !g.criteria.trim())) throw new Error(`${g.type} requires a nonempty rubric`);
  if (g.type === 'baseline' && typeof g.baseline_file !== 'string') throw new Error('baseline requires baseline_file');
  return g;
}

async function loadCase(dir, name) {
  let yaml = {};
  if (await exists(path.join(dir, 'case.yaml'))) yaml = parse(await readText(path.join(dir,'case.yaml'))) ?? {};
  keys(yaml, ['schema_version','name','description','tags','runs','expected_outcome','execution','context','graders'], 'case.yaml');
  if (Object.keys(yaml).length && (yaml.schema_version !== '1.1' || typeof yaml.name !== 'string')) throw new Error('case.yaml requires schema_version: "1.1" and name');
  keys(yaml.execution ?? {}, CASE_KEYS.concat('prompt'), 'execution');
  const md = await exists(path.join(dir,'prompt.md')) ? markdown(await readText(path.join(dir,'prompt.md'))) : { meta: {}, body: yaml.execution?.prompt };
  keys(md.meta, CASE_KEYS, 'prompt.md');
  const c = { ...yaml, ...yaml.execution, ...md.meta, prompt: md.body, dir, name: md.meta.name ?? yaml.name ?? name };
  if (c.schema_version && c.schema_version !== '1.1') throw new Error(`Unsupported schema_version: ${c.schema_version}`);
  if (typeof c.name !== 'string' || !c.name.trim()) throw new Error('Case name must be nonempty');
  if (typeof c.prompt !== 'string' || !c.prompt.trim()) throw new Error(`${name} needs a nonempty prompt`);
  c.runs = number(c.runs, 3, 1, 50, 'runs', true);
  c.timeout_seconds = number(c.timeout_seconds, 300, 1, 3600, 'timeout_seconds');
  c.explicitMaxTurns = c.max_turns !== undefined;
  c.max_turns = number(c.max_turns, 10, 1, 200, 'max_turns', true);
  c.explicitAllowedTools = c.allowed_tools !== undefined;
  c.tags = strings(c.tags ?? [], 'tags'); c.allowed_tools = strings(c.allowed_tools ?? ['read','grep','find','ls'], 'allowed_tools');
  keys(c.env ?? {}, Object.keys(c.env ?? {}), 'env');
  for (const [key,value] of Object.entries(c.env ?? {})) if (!/^EVAL_[A-Z0-9_]+$/.test(key) || typeof value !== 'string') throw new Error('Case env keys must be EVAL_* and values strings');
  keys(c.context ?? {}, ['fixture_dir','scaffold_script','history_file'], 'context');
  if (c.context?.history_file) throw new Error('Native history_file is not portable; put the prior context in the prompt instead');
  for (const key of ['fixture_dir','scaffold_script']) if (c.context?.[key]) await safePath(dir, c.context[key]);
  c.graders = (yaml.graders ?? []).map((g,i) => validateGrader({name: `grader-${i+1}`, ...g}));
  const gradersDir = path.join(dir,'graders');
  if (await exists(gradersDir)) for (const entry of (await fs.readdir(gradersDir)).sort()) {
    if (!entry.endsWith('.md')) continue;
    const {meta,body} = markdown(await readText(await safePath(gradersDir, entry)));
    const g = { name: path.basename(entry,'.md'), ...meta };
    if (g.type === 'regex' && body) g.pattern = body;
    if (['llm','baseline'].includes(g.type) && body) g.criteria = body;
    c.graders.push(validateGrader(g));
  }
  if (!c.graders.length) throw new Error(`${name} has no graders`);
  if (new Set(c.graders.map(g=>g.name)).size !== c.graders.length) throw new Error(`${name} has duplicate grader names`);
  for (const g of c.graders) if (g.baseline_file) await safePath(dir, g.baseline_file);
  return c;
}

export async function loadTarget(root, options = {}) {
  root = path.resolve(root);
  const manifestPath = path.join(root,'eval.config.json');
  const config = await exists(manifestPath) ? JSON.parse(await readText(manifestPath)) : {};
  keys(config, ['eval_dir','skills','extensions','backend','model','provider','judge_backend','judge_model','judge_provider'], 'eval.config.json');
  const evalDir = await safePath(root, options.evalDir ?? config.eval_dir ?? 'evals');
  const pkg = await exists(path.join(root,'package.json')) ? JSON.parse(await readText(path.join(root,'package.json'))) : {};
  const skills = [], extensions = [];
  if (config.skills !== undefined) for (const s of strings(config.skills,'skills')) skills.push(await safePath(root,s));
  else if (await exists(path.join(root,'skills'))) skills.push(path.join(root,'skills'));
  else if (await exists(path.join(root,'SKILL.md'))) skills.push(root);
  else for (const s of strings(pkg.pi?.skills ?? [],'pi.skills')) skills.push(await safePath(root,s));
  for (const e of strings(config.extensions !== undefined ? config.extensions : pkg.pi?.extensions ?? [],'extensions')) extensions.push(await safePath(root,e));
  return {root,evalDir,config,skills,extensions};
}

export async function loadSuite(root, options = {}) {
  const target = await loadTarget(root,options);
  const {evalDir} = target;
  const cases = [];
  async function scan(dir, prefix = '') {
    if (await exists(path.join(dir,'prompt.md')) || await exists(path.join(dir,'case.yaml'))) { cases.push(await loadCase(dir,prefix)); return; }
    for (const entry of (await fs.readdir(dir, {withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      if (['results','mocks'].includes(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new Error('Symlinks are not allowed in the eval tree');
      if (entry.isDirectory()) await scan(path.join(dir,entry.name), [prefix,entry.name].filter(Boolean).join('/'));
    }
  }
  await scan(evalDir);
  if (new Set(cases.map(c=>c.name)).size !== cases.length) throw new Error('Duplicate case names');
  const filtered = cases.filter(c => (!options.case || minimatch(c.name,options.case)) && (!options.tags?.length || options.tags.some(t=>c.tags.includes(t))));
  if (!filtered.length) throw new Error('No eval cases found');
  return { ...target, cases: filtered };
}
