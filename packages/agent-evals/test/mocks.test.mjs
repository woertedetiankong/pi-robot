import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {mockResponse,loadMocks} from '../src/mocks.mjs';
import {runProcess} from '../src/process.mjs';

test('fixed mocks interpolate values and reject unexpected inputs',()=>{
  const mock={server:'api',tool:'get',body:'Hello {{input.user.name}}',expect:{'user.name':'string','count':[1,2],code:'/^[A-Z]+$/'},isError:false};
  assert.equal(mockResponse(mock,{user:{name:'Ada'},count:2,code:'ABC'}).content[0].text,'Hello Ada');
  assert.equal(mockResponse(mock,{user:{name:42},count:2,code:'ABC'}).aborted.tool,'get');
});
test('case mocks override suite mocks and resolve fixtures under the server directory',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent-evals-mock-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const dir=path.join(root,'evals/mocks/api');await fs.mkdir(path.join(dir,'fixtures'),{recursive:true});
  await fs.writeFile(path.join(dir,'fixtures/data.txt'),'fixed');
  await fs.writeFile(path.join(dir,'get.md'),'---\ntype: fixed\n---\n{{file:fixtures/data.txt}}');
  const caseDir=path.join(root,'evals/test');await fs.mkdir(caseDir,{recursive:true});
  assert.equal((await loadMocks(path.join(root,'evals'),caseDir))[0].body,'fixed');
  await fs.mkdir(path.join(caseDir,'mocks/api'),{recursive:true});await fs.writeFile(path.join(caseDir,'mocks/api/get.md'),'overridden');
  assert.equal((await loadMocks(path.join(root,'evals'),caseDir))[0].body,'overridden');
});
test('stdio MCP server initializes, exposes tool schemas, returns fixtures, and records guards',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent-evals-mcp-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const config=path.join(root,'mocks.json'),log=path.join(root,'calls.jsonl');
  await fs.writeFile(config,JSON.stringify([{server:'api',tool:'get',description:'test',inputSchema:{type:'object'},expect:{id:'number'},body:'ID {{input.id}}'}]));
  const input=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05'}},{jsonrpc:'2.0',id:2,method:'tools/list'},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'get',arguments:{id:5}}},{jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'get',arguments:{id:'wrong'}}}].map(r=>JSON.stringify(r)).join('\n')+'\n';
  const result=await runProcess(process.execPath,[fileURLToPath(new URL('../src/mcp-server.mjs',import.meta.url)),config,'api',log],{input});
  assert.equal(result.code,0);assert.equal(result.events[1].result.tools[0].name,'get');assert.equal(result.events[2].result.content[0].text,'ID 5');assert.equal(result.events[3].result.aborted.tool,'get');
  assert.equal((await fs.readFile(log,'utf8')).trim().split('\n').length,2);
});
