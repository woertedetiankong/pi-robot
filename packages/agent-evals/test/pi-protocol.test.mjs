import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {executeAgent} from '../src/adapters.mjs';
import {createCase} from '../src/init.mjs';
import {runSuite} from '../src/runner.mjs';

const skip=process.env.AGENT_EVALS_TEST_PI!=='1'?'Run npm run test:pi to exercise the installed CLI':false;
async function setup(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent-evals-pi-protocol-'));
  const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=path.join(root,'empty-auth');
  t.after(async()=>{if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;await fs.rm(root,{recursive:true,force:true});});
  await fs.mkdir(path.join(root,'workspace'));
  return {root,args:{backend:'pi',tempDir:root,workspace:path.join(root,'workspace'),extensions:[fileURLToPath(new URL('fixtures/pi-provider.mjs',import.meta.url))],provider:'eval-protocol-test',model:'deterministic',prompt:'Exercise the mock protocol',timeoutSeconds:20}};
}
const mock={server:'api',tool:'get',description:'Protocol fixture',inputSchema:{type:'object',properties:{}},expect:{},isError:false,body:'fixture result'};

test('real pi preserves successful mock calls and returns normal tool results',{skip},async t=>{
  const {args}=await setup(t),result=await executeAgent({...args,mocks:[mock]});
  assert.equal(result.error,null);assert.equal(result.mockCalls.length,1);assert.deepEqual(result.mockCalls[0].input,{});
  assert.equal(JSON.parse(result.reply).observedIsError,false);assert.equal(result.mockCalls[0].result.content[0].text,'fixture result');
});
test('real pi propagates error:true mocks as tool errors, allowing recovery',{skip},async t=>{
  const {args}=await setup(t),result=await executeAgent({...args,mocks:[{...mock,isError:true}]});
  assert.equal(result.error,null);assert.equal(JSON.parse(result.reply).observedIsError,true);assert.equal(result.mockCalls.length,1);
  assert.equal(result.events.find(e=>e.type==='tool_execution_end').isError,true);
});
test('real pi guard abort forces score zero even when all ordinary graders pass',{skip},async t=>{
  const {root}=await setup(t);
  await fs.copyFile(fileURLToPath(new URL('fixtures/pi-provider.mjs',import.meta.url)),path.join(root,'provider.mjs'));
  await fs.writeFile(path.join(root,'eval.config.json'),JSON.stringify({extensions:['provider.mjs'],provider:'eval-protocol-test',model:'deterministic'}));
  await createCase(root,'sample',undefined,{prompt:'Exercise guard',graders:[{type:'regex',pattern:'.*'}]});
  await fs.mkdir(path.join(root,'evals/mocks/api'),{recursive:true});
  await fs.writeFile(path.join(root,'evals/mocks/api/get.md'),'---\nexpect:\n  city: string\n---\nfixture');
  const result=await runSuite(root,{runs:1,ablation:'none',threshold:0});
  const run=result.cases[0].arms.with[0];
  assert.equal(result.exitCode,1);assert.equal(result.cases[0].passed,false);assert.equal(run.score,0);
  assert.match(run.error,/input.city/);assert.equal(run.graders[0].passed,true);assert.equal(run.mockCalls.length,1);
  assert.equal(run.mockCalls[0].result.aborted.tool,'get');
  const events=(await fs.readFile(path.join(path.dirname(result.reportPath),run.tracePath),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(e=>e.type==='message_end' && e.message?.role==='assistant').length,1,'abort must prevent another provider call');
});
