import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { exists, inside, walk, safePath, readText, writeJson } from './files.mjs';
import { executable, runProcess } from './process.mjs';

const guard = fileURLToPath(new URL('./pi/guard.ts',import.meta.url));
const mockExtension = fileURLToPath(new URL('./pi/mocks.ts',import.meta.url));
const mockServer = fileURLToPath(new URL('./mcp-server.mjs',import.meta.url));
const aliases = {Read:'read',Glob:'find',Grep:'grep',Bash:'bash',Write:'write',Edit:'edit',Skill:'read'};
export const toolName = name => aliases[name] ?? name;
export function environment(extra = {}) {
  const env = {};
  for (const [k,v] of Object.entries(process.env)) {
    if (/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|LANG|LC_.*|TERM|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS)$/i.test(k) || /(_API_KEY|_AUTH_TOKEN|_OAUTH_TOKEN)$/.test(k) || /^EVAL_[A-Z0-9_]+$/.test(k)) env[k] = v;
  }
  return {...env,...extra,PI_OFFLINE:'1',PI_TELEMETRY:'0'};
}
async function copyIf(source,dest) {
  if (await exists(source)) { await fs.copyFile(source,dest); await fs.chmod(dest,0o600); }
}
const excludedResourceNames=['evals','results','.git','node_modules','.pi','.codex','.agents'];
export async function skillFiles(inputs,excludePaths=[]) {
  const result = [];
  for (const input of inputs) {
    if(excludePaths.some(excluded=>inside(excluded,input))) continue;
    if (!(await fs.stat(input)).isDirectory()) { if (path.basename(input) !== 'SKILL.md') throw new Error(`Expected SKILL.md: ${input}`); result.push(input); continue; }
    if (await exists(path.join(input,'SKILL.md'))) result.push(path.join(input,'SKILL.md'));
    else for (const rel of await walk(input,'',{excludePaths,excludeNames:excludedResourceNames})) if (path.basename(rel) === 'SKILL.md') result.push(path.join(input,rel));
  }
  return [...new Set(result)];
}
async function installSkills(inputs,dest,excludePaths=[]) {
  await fs.mkdir(dest,{recursive:true});
  const installed = [];
  let index = 0;
  for (const file of await skillFiles(inputs,excludePaths)) {
    const source = path.dirname(file), target = path.join(dest,`${++index}-${path.basename(source)}`);
    await fs.mkdir(target);
    for (const rel of await walk(source,'',{excludePaths,excludeNames:excludedResourceNames})) {
      const output = path.join(target,rel);
      await fs.mkdir(path.dirname(output),{recursive:true}); await fs.copyFile(path.join(source,rel),output);
    }
    installed.push(path.join(target,'SKILL.md'));
  }
  return installed;
}

export function normalizePi(events) {
  let reply = '', costUsd = 0, hasPrice = false, unknownPrice = false, turns = 0, error = null, completed = false, model = null;
  const calls = [], usage = {input:0,output:0};
  for (const e of events) {
    if (e.type === 'turn_start') turns++;
    if (e.type === 'agent_end') completed = true;
    if (e.type === 'tool_execution_start') calls.push({id:e.toolCallId,tool:e.toolName,input:e.args ?? {},index:calls.length});
    if (e.type === 'message_end' && e.message?.role === 'assistant') {
      const m = e.message;
      reply = (m.content ?? []).filter(c=>c.type==='text').map(c=>c.text).join('\n');
      model = `${m.provider ?? ''}/${m.model ?? ''}`;
      const cost=m.usage?.cost?.total;
      if (typeof cost==='number' && cost>0) {costUsd+=cost;hasPrice=true;}
      else if ((m.usage?.totalTokens ?? 0)>0 || (m.usage?.input ?? 0)+(m.usage?.output ?? 0)>0) unknownPrice=true;
      usage.input += m.usage?.input ?? 0; usage.output += m.usage?.output ?? 0;
      if (['error','aborted'].includes(m.stopReason)) error = m.errorMessage ?? m.stopReason;
    }
  }
  return {reply,calls,costUsd:unknownPrice || !hasPrice?null:costUsd,usage,turns,error,completed,model};
}
export function normalizeCodex(events) {
  let reply = '', error = null, completed = false, usage = {}, model = null;
  const calls = [], seen = new Map();
  for (const e of events) {
    if (e.type === 'turn.completed') { completed=true; usage=e.usage ?? {}; }
    if (e.type === 'turn.failed' || e.type === 'error') error = e.error?.message ?? e.message ?? 'Codex run failed';
    const item = e.item;
    if (!item) continue;
    if (e.type === 'item.completed' && item.type === 'agent_message') reply = item.text;
    if (!['item.started','item.completed'].includes(e.type)) continue;
    let call;
    if (item.type === 'command_execution') call = {tool:'shell',input:{command:item.command}};
    if (item.type === 'mcp_tool_call') call = {tool:`mcp__${item.server}__${item.tool}`,input:item.arguments ?? {}};
    if (item.type === 'file_change') call = {tool:'apply_patch',input:{changes:item.changes}};
    if (item.type === 'web_search') call = {tool:'web_search',input:{query:item.query}};
    if (call) {
      if(seen.has(item.id))Object.assign(calls[seen.get(item.id)],call,{error:item.error ?? null});
      else {seen.set(item.id,calls.length);calls.push({id:item.id,...call,index:calls.length,error:item.error ?? null});}
    }
  }
  return {reply,calls,costUsd:null,usage,turns:completed?1:0,error,completed,model};
}

export function preflight(suite,opts) {
  if (!['pi','codex'].includes(opts.backend)) throw new Error('backend must be pi or codex');
  if (opts.backend === 'codex') {
    if (suite.extensions.length) throw new Error('Codex cannot load pi extensions. Use a skill-only target or the pi backend.');
    if (suite.cases.some(c=>c.explicitMaxTurns)) throw new Error('Codex exec does not expose internal model turns; remove max_turns and use timeout_seconds.');
    if (opts.allowTools?.length || suite.cases.some(c=>c.explicitAllowedTools)) throw new Error('Codex uses --sandbox read-only|workspace-write, not a per-tool allowlist. Remove allowed_tools/--allow-tools for Codex cases.');
    if (opts.maxCostUsd !== undefined) throw new Error('Codex JSON events have no dollar costs. Use timeouts and run counts instead of --max-cost-usd.');
    if (suite.cases.some(c=>c.graders.some(g=>g.tool==='Skill'))) throw new Error('Codex has no Skill tool event. Grade the result or shell reads explicitly.');
  }
  if (suite.cases.some(c=>c.context?.scaffold_script) && !opts.scaffold) throw new Error('Suite requires scaffold_script. Pass --scaffold for scripts you trust.');
}

export async function executeAgent({backend,workspace,tempDir,skills=[],extensions=[],excludePaths=[],mocks=[],model,provider,prompt,allowedTools=[],allowTools=[],sandbox='read-only',timeoutSeconds=300,maxTurns=10,env:extraEnv={},signal,judge=false}) {
  const configDir = path.join(tempDir,'agent-config'); await fs.mkdir(configDir,{recursive:true});
  const env = environment(extraEnv);
  const {command,prefix} = executable(backend);
  const mockConfig=path.join(tempDir,'mocks.json'),mockLog=path.join(tempDir,'mock-calls.jsonl');
  await writeJson(mockConfig,mocks);
  env.AGENT_EVALS_MOCKS=mockConfig;
  let args;
  if (backend === 'pi') {
    const original = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(),'.pi','agent');
    for (const name of ['auth.json','models.json','models-store.json']) await copyIf(path.join(original,name),path.join(configDir,name));
    const settings = await exists(path.join(original,'settings.json')) ? JSON.parse(await readText(path.join(original,'settings.json'))) : {};
    const clean = {defaultProvider:provider ?? settings.defaultProvider,defaultModel:model ?? settings.defaultModel,defaultThinkingLevel:judge?'off':settings.defaultThinkingLevel,quietStartup:true};
    await writeJson(path.join(configDir,'settings.json'),clean);
    env.PI_CODING_AGENT_DIR = configDir;
    const installed = await installSkills(skills,path.join(tempDir,'target-skills'),excludePaths);
    const readonly = ['read','grep','find','ls'];
    const requested = allowedTools.map(toolName);
    const grants = allowTools.map(toolName);
    const tools = [...new Set([...requested.filter(t=>readonly.includes(t)),...grants,...mocks.map(m=>`mcp__${m.server}__${m.tool}`)])];
    const denied = requested.filter(t=>!tools.includes(t));
    if (denied.length) throw new Error(`Tools requested but not granted: ${denied.join(', ')}`);
    const policy = path.join(tempDir,'policy.json');
    await writeJson(policy,{workspace,readRoots:[path.join(tempDir,'target-skills')],tools});
    env.AGENT_EVALS_POLICY = policy;
    args = ['--print','--mode','json','--no-session','--no-extensions','--no-skills','--no-context-files','--no-prompt-templates','--no-themes','--offline','--approve','-e',guard];
    if (tools.length) args.push('--tools',tools.join(',')); else args.push('--no-tools');
    if (provider) args.push('--provider',provider);
    if (model) args.push('--model',model);
    if (judge) args.push('--thinking','off');
    for (const skill of installed) args.push('--skill',skill);
    for (const extension of extensions) args.push('-e',extension);
    if(mocks.length)args.push('-e',mockExtension);
  } else {
    const original = process.env.CODEX_HOME ?? path.join(os.homedir(),'.codex');
    await copyIf(path.join(original,'auth.json'),path.join(configDir,'auth.json'));
    const originalConfig = path.join(original,'config.toml');
    const config = await exists(originalConfig) ? parseToml(await readText(originalConfig)) : {};
    const clean = {approval_policy:'never',web_search:'disabled',model:model ?? config.model,model_reasoning_effort:config.model_reasoning_effort};
    for (const key of ['model_provider','model_providers','preferred_auth_method','cli_auth_credentials_store']) if (config[key] !== undefined) clean[key]=config[key];
    if(process.platform==='win32'){
      // Preserve the user's chosen native sandbox. Never downgrade or disable it.
      if(config.windows)clean.windows=config.windows;
      if(config.windows?.sandbox==='elevated'){
        for(const relative of ['.sandbox/setup_marker.json','.sandbox-secrets/sandbox_users.json']){
          await fs.mkdir(path.dirname(path.join(configDir,relative)),{recursive:true});
          await copyIf(path.join(original,relative),path.join(configDir,relative));
        }
      }
    }
    if(mocks.length)clean.mcp_servers=Object.fromEntries([...new Set(mocks.map(m=>m.server))].map(server=>[server,{command:process.execPath,args:[mockServer,mockConfig,server,mockLog],required:true,startup_timeout_sec:20}]));
    await fs.writeFile(path.join(configDir,'config.toml'),stringifyToml(Object.fromEntries(Object.entries(clean).filter(([,v])=>v!==undefined))),{mode:0o600});
    env.CODEX_HOME=configDir;
    // Also separate home-scoped skill discovery. Authentication remains in CODEX_HOME.
    env.HOME=path.join(tempDir,'home'); env.USERPROFILE=env.HOME; await fs.mkdir(env.HOME,{recursive:true});
    await installSkills(skills,path.join(workspace,'.agents','skills'),excludePaths);
    args = ['exec','--json','--ephemeral','--skip-git-repo-check','--color','never','--sandbox',judge?'read-only':sandbox,'-c','approval_policy="never"','-c','project_doc_max_bytes=0','-c','features.memories=false','-c','features.multi_agent=false'];
    if (model) args.push('--model',model);
    args.push('-');
  }
  let turns=0;
  const result = await runProcess(command,[...prefix,...args],{cwd:workspace,env,input:prompt,timeoutMs:timeoutSeconds*1000,signal,
    onEvent:e=>piMockCall(e)?.result?.aborted?.reason ?? (backend==='pi' && e.type==='turn_start' && ++turns>maxTurns ? `Exceeded max_turns ${maxTurns}` : null)});
  const mockCalls=result.events.map(piMockCall).filter(Boolean);
  if(await exists(mockLog))for(const line of (await readText(mockLog)).trim().split('\n'))if(line)mockCalls.push(JSON.parse(line));
  const aborted=mockCalls.find(c=>c.result?.aborted)?.result.aborted;
  const normalized = backend==='pi' ? normalizePi(result.events) : normalizeCodex(result.events);
  const loadError=backend==='pi' && /Failed to load extension|Error loading extension/i.test(result.stderr) ? 'A target or evaluation extension failed to load; inspect stderr' : null;
  const policyError=backend==='codex' && /CreateProcess.*blocked by policy|sandbox setup failed/i.test(result.stderr) ? 'Codex sandbox could not start a tool process; inspect stderr and the native sandbox configuration' : null;
  const mockPermissionError=normalized.calls.find(c=>mocks.some(m=>c.tool===`mcp__${m.server}__${m.tool}`) && /requires approval/i.test(c.error?.message ?? ''))?.error?.message;
  return {...normalized,mockCalls,aborted,events:result.events,error:aborted?.reason ?? result.error ?? normalized.error ?? loadError ?? policyError ?? mockPermissionError ?? (result.code!==0 ? `Process exited ${result.code}: ${result.stderr.slice(-1800)}` : !normalized.completed ? 'Agent ended without a completion event' : null),exitCode:result.code,stderr:result.stderr.slice(-4000)};
}

// pi owns JSON stdout. Extension output is not a transport for protocol events.
function piMockCall(event) {
  return event.type==='tool_execution_end' ? event.result?.details?.mockCall : undefined;
}
