import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCase,generateCases } from '../src/init.mjs';
import { runSuite,validateSuite } from '../src/runner.mjs';
import { runProcess } from '../src/process.mjs';

async function suite(t,graders=[{type:'regex',pattern:'correct'}]){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent-evals-run-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'skills/demo'),{recursive:true});await fs.writeFile(path.join(root,'skills/demo/SKILL.md'),'---\nname: demo\ndescription: demo\n---\nDo the task');
  await createCase(root,'sample','evals',{prompt:'do a task',graders});return root;
}
const response=(overrides={})=>({reply:'correct',calls:[],events:[],costUsd:.1,error:null,completed:true,...overrides});
test('full suite runs both arms three times with correct delta and isolated directories',async t=>{
  const root=await suite(t),workspaces=[];
  const result=await runSuite(root,{execute:async args=>{workspaces.push(args.workspace);return response({reply:args.skills.length?'correct':'wrong'});}});
  assert.equal(workspaces.length,6);assert.equal(new Set(workspaces).size,6);
  assert.equal(result.cases[0].aggregates.delta,1);assert.equal(result.exitCode,0);
  for(const dir of workspaces)await assert.rejects(fs.stat(dir));
  const saved=JSON.parse(await fs.readFile(path.join(path.dirname(result.reportPath),'aggregate-result.json'),'utf8'));
  assert.equal(saved.cases[0].arms.with.length,3);
});
test('diagnostic skill read failure does not inflate the without score gap',async t=>{
  const root=await suite(t,[{type:'regex',pattern:'correct'},{type:'tool_used',tool:'Skill'}]);
  const result=await runSuite(root,{runs:1,execute:async args=>response({calls:args.skills.length?[{tool:'read',input:{path:'demo/SKILL.md'}}]:[]})});
  assert.equal(result.cases[0].aggregates.delta,0);assert.equal(result.cases[0].arms.with[0].graders[1].scored,false);
});
test('run errors cannot pass at threshold zero and suppress delta',async t=>{
  const root=await suite(t);const result=await runSuite(root,{runs:1,threshold:0,execute:async()=>response({error:'rate limit'})});
  assert.equal(result.exitCode,1);assert.equal(result.cases[0].aggregates.delta,null);assert.equal(result.cases[0].aggregates.score,0);
});
test('budget stop writes partial results, not a misleading full score',async t=>{
  const root=await suite(t);let calls=0;
  const result=await runSuite(root,{maxCostUsd:.15,execute:async()=>{calls++;return response();}});
  assert.equal(calls,2);assert.equal(result.exitCode,2);assert.equal(result.partial,true);assert.equal(result.cases[0].aggregates.delta,null);
});
test('judge costs count against the ceiling and skipped votes mark partial',async t=>{
  const root=await suite(t,[{type:'llm',criteria:'PASS if correct'}]);
  const result=await runSuite(root,{runs:1,ablation:'none',maxCostUsd:.15,execute:async args=>response({reply:args.judge?'{"passed":true,"reason":"yes"}':'correct'})});
  assert.equal(result.exitCode,2);assert.equal(result.cases[0].arms.with[0].skippedPaidGraders,true);
});
test('fixtures distinguish created from modified files',async t=>{
  const root=await suite(t,[{type:'file_exists',path:'new.txt'},{type:'regex',pattern:'changed',target:{source:'file',path:'old.txt'}}]);
  const cdir=path.join(root,'evals/sample');await fs.mkdir(path.join(cdir,'fixtures'));await fs.writeFile(path.join(cdir,'fixtures/old.txt'),'old');
  await fs.writeFile(path.join(cdir,'case.yaml'),'schema_version: "1.1"\nname: sample\ncontext:\n  fixture_dir: fixtures\n');
  const result=await runSuite(root,{runs:1,ablation:'none',execute:async args=>{await fs.writeFile(path.join(args.workspace,'old.txt'),'changed');await fs.writeFile(path.join(args.workspace,'new.txt'),'new');return response();}});
  assert.deepEqual(result.cases[0].arms.with[0].createdFiles,['new.txt']);assert.deepEqual(result.cases[0].arms.with[0].modifiedFiles,['old.txt']);assert.equal(result.exitCode,0);
});
test('concurrency is bounded and results retain case run order',async t=>{
  const root=await suite(t);let active=0,max=0;
  const result=await runSuite(root,{concurrency:2,execute:async()=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,15));active--;return response();}});
  assert.equal(max,2);assert.deepEqual(result.cases[0].arms.with.map(r=>r.index),[0,1,2]);
});
test('unsupported Codex capabilities and agent MCP mocks fail before model calls',async t=>{
  const root=await suite(t);await validateSuite(root,{backend:'codex'});
  await assert.rejects(validateSuite(root,{backend:'codex',maxCostUsd:1}),/dollar costs/);
  await fs.mkdir(path.join(root,'evals/mocks/api'),{recursive:true});
  await fs.writeFile(path.join(root,'evals/mocks/api/tool.md'),'---\ntype: agent\n---\nrespond');
  await assert.rejects(validateSuite(root),/fixed MCP mocks/);
});
test('process input is literal and timeout/cancellation terminate children',async()=>{
  const payload='$(do-not-run) `secret` "quotes"\nnext line';
  const echo=await runProcess(process.execPath,['-e','process.stdin.pipe(process.stdout)'],{input:payload});assert.equal(echo.stdout,payload);
  const timeout=await runProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:80});assert.match(timeout.error,/Timed out/);
  const controller=new AbortController();controller.abort();
  const cancelled=await runProcess(process.execPath,['-e','process.exit(99)'],{signal:controller.signal});assert.equal(cancelled.code,130);
});
test('unpriced model usage stops a budgeted suite and is not reported as free',async t=>{
  const root=await suite(t);let calls=0;
  const result=await runSuite(root,{maxCostUsd:1,execute:async()=>{calls++;return response({costUsd:null});}});
  assert.equal(calls,1);assert.equal(result.exitCode,2);assert.equal(result.costUsd,null);assert.match(result.reason,/usable price/);
});
test('case authoring repairs invalid model output once, then validates before writing',async t=>{
  const root=await suite(t);let calls=0;
  const generated=await generateCases(root,{execute:async args=>{
    calls++;
    if(calls===1)return response({reply:JSON.stringify({cases:[{name:'generated',prompt:'task',graders:[{type:'regex'}]}]})});
    assert.match(args.prompt,/regex requires pattern/);
    return response({reply:JSON.stringify({cases:[{name:'generated',prompt:'task',graders:[{name:'result',type:'regex',pattern:'correct'}]}]})});
  }});
  assert.equal(calls,2);assert.equal(generated.costUsd,.2);
  const {suite:parsed}=await validateSuite(root);assert.ok(parsed.cases.some(c=>c.name==='generated'));
});
test('invalid authoring output stops after one repair and leaves no partial cases',async t=>{
  const root=await suite(t);let calls=0;
  await assert.rejects(generateCases(root,{execute:async()=>{calls++;return response({reply:'not JSON'});}}),/still invalid after one repair/);
  assert.equal(calls,2);assert.deepEqual((await fs.readdir(path.join(root,'evals'))).sort(),['sample']);
});
