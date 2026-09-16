import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { exists, readText } from './files.mjs';
import { createCase, generateCases } from './init.mjs';
import { validateSuite, runSuite } from './runner.mjs';
import { summary } from './report.mjs';
import { executable, runProcess } from './process.mjs';

const packageRoot=fileURLToPath(new URL('../',import.meta.url));
export const help=`agent-evals — behavioral tests for pi and Codex

  agent-evals init <target> --bare <case>        Create a blank case (no model calls)
  agent-evals init <target> [--expect <text>]    Generate cases with a model
  agent-evals validate <target>                 Check the complete suite (no model calls)
  agent-evals run <target> [options]             Run evals, write local HTML and JSON
  agent-evals doctor                            Check executable availability
  agent-evals install pi|codex                   Install local pi package / Codex skill

Options:
  --backend pi|codex       --model <id>         --provider <id>
  --judge-backend pi|codex --judge-model <id>   --judge-provider <id>
  --case <glob>           --tag <tag>          --eval-dir <relative-dir>
  --runs <1..50>          --concurrency <1..8>  --threshold <0..1>
  --ablation none|with-without                 --max-cost-usd <amount> (pi only)
  --allow-tools <comma-separated names>        --sandbox read-only|workspace-write (Codex)
  --output-dir <dir>      --json [file.json]   --keep-temp  --scaffold

Defaults: 3 runs per arm, threshold 1.0, both arms when a target is found.
All reports stay local. Model runs and model judges consume your existing account usage.
`;

export function splitArgs(text) {
  const tokens=[];let token='',quote=null,active=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quote){if(c===quote)quote=null;else token+=c;active=true;}
    else if(c==='"' || c==="'"){quote=c;active=true;}
    else if(/\s/.test(c)){if(active){tokens.push(token);token='';active=false;}}
    else{token+=c;active=true;}
  }
  if(quote)throw new Error('Unclosed quote');
  if(active)tokens.push(token);
  return tokens;
}
export function parseArgs(argv) {
  const options={},pos=[];
  const boolean={'--keep-temp':'keepTemp','--scaffold':'scaffold','--no-publish':'noPublish'};
  const values={'--backend':'backend','--model':'model','--provider':'provider','--judge-backend':'judgeBackend','--judge-model':'judgeModel','--judge-provider':'judgeProvider','--case':'case','--eval-dir':'evalDir','--runs':'runs','--concurrency':'concurrency','-j':'concurrency','--threshold':'threshold','--ablation':'ablation','--max-cost-usd':'maxCostUsd','--allow-tools':'allowTools','--sandbox':'sandbox','--output-dir':'outputDir','--bare':'bare','--expect':'expect','--tag':'tags'};
  for(let i=0;i<argv.length;i++){
    const arg=argv[i];
    if(arg==='--help' || arg==='-h'){options.help=true;continue;}
    if(arg==='--json'){options.json=argv[i+1]?.endsWith('.json')?argv[++i]:true;continue;}
    if(boolean[arg]){options[boolean[arg]]=true;continue;}
    if(values[arg]){
      const value=argv[++i];if(value===undefined || value.startsWith('--'))throw new Error(`Missing value for ${arg}`);
      const key=values[arg];
      if(['runs','concurrency','threshold','maxCostUsd'].includes(key))options[key]=Number(value);
      else if(key==='allowTools')options.allowTools=[...(options.allowTools ?? []),...value.split(',').filter(Boolean)];
      else if(key==='tags')options.tags=[...(options.tags ?? []),value];
      else options[key]=value;
      continue;
    }
    if(arg.startsWith('-'))throw new Error(`Unknown option: ${arg}`);
    pos.push(arg);
  }
  if(pos.length>2)throw new Error('Too many positional arguments; quote paths containing spaces');
  return {command:pos[0] ?? 'help',target:pos[1] ?? '.',options};
}

export async function install(host,{signal}={}) {
  if(host==='pi'){
    const {command,prefix}=executable('pi');
    const r=await runProcess(command,[...prefix,'install',packageRoot],{timeoutMs:120000,signal});
    if(r.error || r.code!==0)throw new Error(r.error ?? r.stderr);
    return r.stdout.trim();
  }
  if(host!=='codex')throw new Error('install expects pi or codex');
  const dir=path.join(process.env.CODEX_HOME ?? path.join(os.homedir(),'.codex'),'skills','agent-evals');
  const marker=path.join(dir,'.agent-evals-install.json');
  if(await exists(dir)){
    if(!(await exists(marker)))throw new Error(`Existing skill is not managed by this installer: ${dir}`);
    const previous=JSON.parse(await readText(marker));
    if(previous.packageRoot!==packageRoot)throw new Error(`Skill belongs to another install: ${previous.packageRoot}`);
  }
  await fs.mkdir(path.join(dir,'scripts'),{recursive:true});
  await fs.mkdir(path.join(dir,'references'),{recursive:true});
  await fs.copyFile(path.join(packageRoot,'skills/agent-evals/SKILL.md'),path.join(dir,'SKILL.md'));
  await fs.copyFile(path.join(packageRoot,'skills/agent-evals/references/schema.md'),path.join(dir,'references/schema.md'));
  // fileURLToPath/pathToFileURL handles drive letters and spaces without shell quoting.
  const {pathToFileURL}=await import('node:url');
  await fs.writeFile(path.join(dir,'scripts/agent-evals.mjs'),`#!/usr/bin/env node\nimport { main } from ${JSON.stringify(pathToFileURL(path.join(packageRoot,'src/cli.mjs')).href)};\nprocess.exitCode = await main(process.argv.slice(2));\n`);
  const {version}=JSON.parse(await readText(path.join(packageRoot,'package.json')));
  await fs.writeFile(marker,JSON.stringify({packageRoot,version},null,2));
  return `Installed Codex skill: ${dir}`;
}

export async function main(argv,{stdout=console.log,stderr=console.error,signal}={}) {
  let controller;
  const interrupt=()=>controller?.abort();
  if(!signal){controller=new AbortController();signal=controller.signal;process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);}
  try {
    const {command,target,options}=parseArgs(argv);options.signal=signal;
    if(options.help || command==='help'){stdout(help);return 0;}
    if(command==='doctor'){
      for(const name of ['pi','codex']){
        try {const exe=executable(name);const r=await runProcess(exe.command,[...exe.prefix,'--version'],{timeoutMs:30000,signal});stdout(`${name}: ${r.error ?? r.stdout.trim()}`);}
        catch(e){stdout(`${name}: ${e.message}`);}
      }
      return 0;
    }
    if(command==='install'){stdout(await install(target,{signal}));return 0;}
    if(command==='init'){
      const root=path.resolve(target);
      if(options.bare){stdout(await createCase(root,options.bare,options.evalDir));return 0;}
      const generated=await generateCases(root,options);stdout(`Created ${generated.paths.length} cases:\n${generated.paths.join('\n')}\nReview and validate before running. Generation cost: ${generated.costUsd ?? 'unknown'}`);return 0;
    }
    if(command==='validate'){
      const {suite,opts}=await validateSuite(target,options);
      stdout(JSON.stringify({valid:true,backend:opts.backend,cases:suite.cases.map(c=>c.name),skills:suite.skills,extensions:suite.extensions},null,2));return 0;
    }
    if(command!=='run')throw new Error(`Unknown command: ${command}`);
    if(!options.json)options.onProgress=p=>stderr(`${p.case} ${p.arm} #${p.run}: ${p.score.toFixed(2)}${p.error?` (${p.error})`:''}`);
    const result=await runSuite(target,options);
    if(options.json===true)stdout(JSON.stringify(result));else if(!options.json)stdout(summary(result));
    return result.exitCode;
  } catch(e){stderr(`agent-evals: ${e.message}`);return signal?.aborted?130:1;}
  finally{if(controller){process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);}}
}
