import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { markdown,loadSuite,validateGrader } from '../src/suite.mjs';
import { grade,scoredGraders,weightedScore,parseJudge,toolMatches } from '../src/graders.mjs';
import { contained,safePath } from '../src/files.mjs';
import { normalizePi,normalizeCodex } from '../src/adapters.mjs';
import { parseArgs,splitArgs } from '../src/cli.mjs';
import { html } from '../src/report.mjs';

async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agent-evals-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
test('Markdown preserves prompt and rejects duplicate YAML keys',()=>{
  assert.deepEqual(markdown('---\r\ntags: [smoke]\r\n---\r\n\r\nhi'),{meta:{tags:['smoke']},body:'hi'});
  assert.throws(()=>markdown('---\ntags: []\ntags: []\n---\nhi'));
  assert.throws(()=>markdown('---\nx: 1'));
});
test('scoring excludes intervention-only checks symmetrically',()=>{
  const gs=[{type:'llm',weight:2},{type:'tool_used',tool:'Skill',weight:1},{type:'regex',arm:'with-only',weight:1}];
  assert.deepEqual(scoredGraders(gs,true),[true,false,false]);
  assert.deepEqual(scoredGraders(gs,false),[true,true,true]);
  assert.deepEqual(scoredGraders([{type:'tool_used',tool:'Skill'}],true),[true]);
  assert.deepEqual(scoredGraders([{type:'tool_used',tool:'Skill',arm:'both'}],true),[true]);
  assert.equal(weightedScore([{passed:true,scored:true,weight:3},{passed:false,scored:true,weight:1},{passed:false,scored:false,weight:100}]),0.75);
});
test('deterministic graders inspect actual results, calls, order and created files',async t=>{
  const workspace=await temp(t);await fs.writeFile(path.join(workspace,'out.txt'),'alpha beta alpha');
  const r={reply:'hello',events:[],createdFiles:['out.txt'],calls:[{tool:'read',input:{path:'x/SKILL.md'}},{tool:'write',input:{path:'out.txt'}}]};
  const check=g=>grade(validateGrader(g),r,{workspace});
  assert.equal((await check({type:'regex',pattern:'alpha',match:'count:2',target:{source:'file',path:'out.txt'}})).passed,true);
  assert.equal((await check({type:'regex',pattern:'bad',match:'not_contains'})).passed,true);
  assert.equal((await check({type:'tool_used',tool:'write',input_match:'out\\.txt'})).passed,true);
  assert.equal((await check({type:'tool_used',tool:'bash',min:0,max:0})).passed,true);
  assert.equal((await check({type:'tool_order',before:'Read',after:'Write'})).passed,true);
  assert.equal((await check({type:'tool_order',before:'Write',after:'Read'})).passed,false);
  assert.equal((await check({type:'file_exists',path:'*.txt'})).passed,true);
  assert.equal((await check({type:'file_exists',path:'fixture.txt'})).passed,false);
  assert.equal(toolMatches(r.calls[0],{tool:'Skill'}),true);
  assert.equal(toolMatches({tool:'read',input:{path:'foo.txt'}},{tool:'Skill'}),false);
});
test('judge voting requires a majority and surfaces judge errors',async t=>{
  const workspace=await temp(t),r={reply:'candidate'},g=validateGrader({type:'llm',criteria:'PASS if correct'});
  let votes=0;
  const verdict=await grade(g,r,{workspace,judge:async()=>({passed:++votes<=2,reason:'evidence'})});
  assert.equal(verdict.passed,true);assert.equal(votes,3);
  const invalid=await grade(g,r,{workspace,judge:async()=>({passed:true,error:'rate limit'})});
  assert.equal(invalid.passed,false);assert.match(invalid.error,/rate limit/);
  assert.throws(()=>parseJudge('{"passed":"true","reason":"x"}'));
  assert.deepEqual(parseJudge('```json\n{"passed":true,"reason":"ok"}\n```'),{passed:true,reason:'ok'});
});
test('baseline judge receives the saved reference, and large targets fail explicitly',async t=>{
  const dir=await temp(t);await fs.writeFile(path.join(dir,'ref.jsonl'),'reference');
  const g=validateGrader({type:'baseline',baseline_file:'ref.jsonl',criteria:'at least as good'});
  let seen;
  assert.equal((await grade(g,{reply:'candidate'},{workspace:dir,caseDir:dir,judge:async input=>{seen=input;return {passed:true,reason:'ok'};}})).passed,true);
  assert.equal(seen.reference,'reference');
  const verdict=await grade({...g,type:'llm'},{reply:'x'.repeat(32001)},{workspace:dir,judge:()=>assert.fail()});
  assert.match(verdict.error,/32000/);
});
test('invalid schemas and path traversal are rejected before execution',async t=>{
  const root=await temp(t);
  assert.throws(()=>contained(root,'../secret'));
  assert.throws(()=>validateGrader({type:'regex',pattern:'x',typo:true}));
  assert.throws(()=>validateGrader({type:'regex',pattern:'[bad'}));
  assert.throws(()=>validateGrader({type:'tool_used',tool:'read',min:2,max:1}));
  const outside=await temp(t);
  await fs.symlink(outside,path.join(root,'link'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(safePath(root,'link/secret'),/Symlink/);
});
test('case YAML merges with Markdown and nested cases are discovered',async t=>{
  const root=await temp(t),dir=path.join(root,'evals/group/case');await fs.mkdir(path.join(dir,'graders'),{recursive:true});
  await fs.writeFile(path.join(dir,'case.yaml'),'schema_version: "1.1"\nname: merged\nruns: 2\nexecution:\n  prompt: old\n  timeout_seconds: 25\n');
  await fs.writeFile(path.join(dir,'prompt.md'),'---\nruns: 4\n---\nnew');
  await fs.writeFile(path.join(dir,'graders/check.md'),'---\ntype: regex\n---\nnew');
  const suite=await loadSuite(root,{case:'mer*'});
  assert.equal(suite.cases[0].runs,4);assert.equal(suite.cases[0].prompt,'new');assert.equal(suite.cases[0].timeout_seconds,25);
  await fs.writeFile(path.join(dir,'graders/bad.md'),'---\ntype: regex\ntyppo: x\n---\nx');
  await assert.rejects(loadSuite(root),/Unsupported grader/);
});
test('native adapter event normalization deduplicates Codex calls and detects errors',()=>{
  const item={id:'one',type:'command_execution',command:'cat file'};
  const c=normalizeCodex([{type:'item.started',item},{type:'item.completed',item},{type:'item.completed',item:{id:'two',type:'agent_message',text:'done'}},{type:'turn.completed',usage:{input_tokens:12}}]);
  assert.equal(c.calls.length,1);assert.equal(c.calls[0].tool,'shell');assert.equal(c.costUsd,null);assert.equal(c.completed,true);
  const p=normalizePi([{type:'tool_execution_start',toolName:'read',args:{path:'a'}},{type:'message_end',message:{role:'assistant',content:[{type:'text',text:'ok'}],usage:{cost:{total:.2}},stopReason:'error',errorMessage:'quota'}},{type:'agent_end'}]);
  assert.equal(p.error,'quota');assert.equal(p.reply,'ok');assert.equal(p.costUsd,.2);
  assert.equal(normalizePi([{type:'message_end',message:{role:'assistant',content:[],usage:{input:10,output:5,cost:{total:0}}}}]).costUsd,null);
});
test('CLI argument parsing preserves Windows paths and rejects incomplete options',()=>{
  assert.deepEqual(splitArgs('run "D:\\my project\\plugin" --runs 1'),['run','D:\\my project\\plugin','--runs','1']);
  assert.equal(parseArgs(['run','x','--runs','2','--json']).options.runs,2);
  assert.throws(()=>parseArgs(['run','--model']),/Missing/);
  assert.throws(()=>parseArgs(['run','--oops']),/Unknown/);
  assert.throws(()=>splitArgs('"oops'),/Unclosed/);
});
test('HTML report escapes model output and executes no scripts',()=>{
  const output=html({backend:'pi',startedAt:'now',durationSeconds:1,costUsd:0,threshold:1,exitCode:1,cases:[{name:'<script>alert(1)</script>',passed:false,aggregates:{score:0},arms:{with:[{score:0,graders:[],reply:'<img onerror=alert(1)>',calls:[],createdFiles:[]}]}}]});
  assert.ok(!output.includes('<script>'));assert.ok(output.includes('&lt;img'));assert.ok(output.includes("default-src 'none'"));
});
