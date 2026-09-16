import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { main } from '../src/cli.mjs';
import { createCase,generateCases } from '../src/init.mjs';
import { loadTarget,loadSuite } from '../src/suite.mjs';
import { executeAgent } from '../src/adapters.mjs';
import { runSuite,validateSuite } from '../src/runner.mjs';
import { loadMocks } from '../src/mocks.mjs';

const skill='---\nname: demo\ndescription: Example skill\n---\nDo the task.';
async function temp(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent-evals-regression-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
async function write(root,rel,value){const file=path.join(root,rel);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,value);return file;}
function env(t,values){for(const [key,value] of Object.entries(values)){const previous=process.env[key];process.env[key]=value;t.after(()=>{if(previous===undefined)delete process.env[key];else process.env[key]=previous;});}}

test('bare init and validate agree on configured eval directory, with CLI override',async t=>{
  const root=await temp(t);await write(root,'eval.config.json',JSON.stringify({eval_dir:'qa'}));
  assert.equal(await main(['init',root,'--bare','first'],{stdout:()=>{}}),0);
  assert.deepEqual((await loadSuite(root)).cases.map(c=>c.name),['first']);
  assert.equal(await main(['init',root,'--bare','second','--eval-dir','checks'],{stdout:()=>{}}),0);
  assert.deepEqual((await loadSuite(root,{evalDir:'checks'})).cases.map(c=>c.name),['second']);
  await assert.rejects(fs.stat(path.join(root,'evals')));
});

test('resource selection treats empty skill and extension lists independently',async t=>{
  const root=await temp(t);await write(root,'resources/demo/SKILL.md',skill);
  await write(root,'package.json',JSON.stringify({pi:{skills:['resources/demo'],extensions:['plugin.mjs']}}));
  await write(root,'plugin.mjs','export default function(){}');
  await write(root,'eval.config.json',JSON.stringify({extensions:[]}));
  let target=await loadTarget(root);assert.equal(target.skills.length,1);assert.deepEqual(target.extensions,[]);
  await write(root,'eval.config.json',JSON.stringify({skills:[]}));
  target=await loadTarget(root);assert.deepEqual(target.skills,[]);assert.equal(target.extensions.length,1);
});

test('generated init honors selected skills, provider/model/backend and directory defaults',async t=>{
  const root=await temp(t);await write(root,'resources/selected/SKILL.md',skill+' SELECTED');
  await write(root,'resources/unselected/SKILL.md',skill+' OMITTED');
  await write(root,'eval.config.json',JSON.stringify({skills:['resources/selected'],extensions:[],backend:'codex',provider:'configured-provider',model:'configured-model',eval_dir:'qa'}));
  const seen=[];
  const execute=async args=>{seen.push(args);return {reply:JSON.stringify({cases:[{name:`case-${seen.length}`,prompt:'task',graders:[{type:'regex',pattern:'ok'}]}]}),costUsd:0};};
  await generateCases(root,{execute});
  assert.equal(seen[0].backend,'codex');assert.equal(seen[0].provider,'configured-provider');assert.equal(seen[0].model,'configured-model');
  assert.match(seen[0].prompt,/SELECTED/);assert.doesNotMatch(seen[0].prompt,/OMITTED/);
  assert.equal((await loadSuite(root)).cases[0].name,'case-1');
  await generateCases(root,{execute,backend:'pi',model:'override',evalDir:'checks'});
  assert.equal(seen[1].backend,'pi');assert.equal(seen[1].model,'override');
  assert.equal((await loadSuite(root,{evalDir:'checks'})).cases[0].name,'case-2');
});

test('empty configured skill directories fail validation instead of silently testing no target',async t=>{
  const root=await temp(t);await fs.mkdir(path.join(root,'skills'));await createCase(root,'sample');
  await assert.rejects(validateSuite(root),/no SKILL.md/);
});

test('custom eval and report paths are pruned before copying skills on both adapters',async t=>{
  const root=await temp(t);await write(root,'target/SKILL.md',skill);
  await write(root,'target/qa/sample/graders/secret.md','HIDDEN');
  await write(root,'target/reports/report.html','HIDDEN');
  await write(root,'target/resources/allowed.txt','allowed');
  await fs.symlink(path.join(root,'target'),path.join(root,'target/qa/recursive-link'),process.platform==='win32'?'junction':'dir');
  const fake=await write(root,'fake-cli.mjs',`console.log(JSON.stringify({type:'agent_end'}));console.log(JSON.stringify({type:'turn.completed'}));`);
  env(t,{AGENT_EVALS_PI_BIN:fake,AGENT_EVALS_CODEX_BIN:fake,PI_CODING_AGENT_DIR:path.join(root,'empty-auth'),CODEX_HOME:path.join(root,'empty-auth')});
  for(const backend of ['pi','codex']){
    const tempDir=path.join(root,backend),workspace=path.join(tempDir,'workspace');await fs.mkdir(workspace,{recursive:true});
    const result=await executeAgent({backend,workspace,tempDir,skills:[path.join(root,'target')],excludePaths:[path.join(root,'target/qa'),path.join(root,'target/reports')],prompt:'inspect'});
    assert.equal(result.error,null);
    const installed=path.join(backend==='pi'?path.join(tempDir,'target-skills'):path.join(workspace,'.agents/skills'),'1-target');
    assert.equal(await fs.readFile(path.join(installed,'resources/allowed.txt'),'utf8'),'allowed');
    await assert.rejects(fs.stat(path.join(installed,'qa')));await assert.rejects(fs.stat(path.join(installed,'reports')));
  }
});

test('runner passes resolved eval and output exclusions to both arms',async t=>{
  const root=await temp(t);await write(root,'SKILL.md',skill);await write(root,'eval.config.json',JSON.stringify({eval_dir:'qa'}));
  await createCase(root,'sample',undefined,{prompt:'task',graders:[{type:'regex',pattern:'ok'}]});
  const outputDir=path.join(root,'published'),seen=[];
  const result=await runSuite(root,{runs:1,outputDir,execute:async args=>{seen.push(args.excludePaths);return {reply:'ok',events:[],calls:[],costUsd:0,error:null};}});
  assert.equal(result.exitCode,0);assert.equal(seen.length,2);
  for(const exclusions of seen)assert.deepEqual(exclusions,[path.join(root,'qa'),outputDir]);
});

test('case mock files overlay schemas, descriptions and fixtures independently',async t=>{
  const root=await temp(t),caseDir=path.join(root,'sample');
  const schema={type:'object',properties:{city:{type:'string'}},required:['city']};
  await write(root,'mocks/api/_tools.json',JSON.stringify({tools:[{name:'get',description:'Real schema',inputSchema:schema}]}));
  await write(root,'mocks/api/get.md','suite');await write(root,'mocks/api/fixtures/data.txt','suite fixture');
  await write(root,'sample/mocks/api/get.md','case {{file:fixtures/data.txt}}');
  let mock=(await loadMocks(root,caseDir))[0];assert.deepEqual(mock.inputSchema,schema);assert.equal(mock.description,'Real schema');assert.equal(mock.body,'case suite fixture');
  await write(root,'sample/mocks/api/fixtures/data.txt','case fixture');
  mock=(await loadMocks(root,caseDir))[0];assert.equal(mock.body,'case case fixture');
  await fs.unlink(path.join(caseDir,'mocks/api/get.md'));await write(root,'mocks/api/get.md','{{file:fixtures/data.txt}}');
  await write(root,'sample/mocks/api/_tools.json',JSON.stringify({tools:[{name:'get',description:'Case schema',inputSchema:{type:'object'}}]}));
  mock=(await loadMocks(root,caseDir))[0];assert.equal(mock.body,'case fixture');assert.equal(mock.description,'Case schema');assert.deepEqual(mock.inputSchema,{type:'object'});
});

test('mock file interpolation preserves replacement tokens and rejects traversal',async t=>{
  const root=await temp(t),caseDir=path.join(root,'sample');
  const literal='literal $& $$ $` $\' dollars';
  await write(root,'mocks/api/fixtures/data.txt',literal);await write(root,'mocks/api/get.md','START {{file:fixtures/data.txt}} / {{file:fixtures/data.txt}} END');
  assert.equal((await loadMocks(root,caseDir))[0].body,`START ${literal} / ${literal} END`);
  await write(root,'mocks/api/get.md','{{file:../secret}}');await assert.rejects(loadMocks(root,caseDir),/escapes root/);
});
