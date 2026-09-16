import fs from 'node:fs/promises';
import path from 'node:path';
import { markdown,keys } from './suite.mjs';
import { contained,exists,readText,safePath,walk } from './files.mjs';

export async function loadMocks(suiteDir,caseDir){
  const servers=new Map();
  for(const root of [path.join(suiteDir,'mocks'),path.join(caseDir,'mocks')]){
    if(!(await exists(root)))continue;
    for(const server of await fs.readdir(root,{withFileTypes:true})){
      if(!server.isDirectory() || server.name.startsWith('.'))continue;
      if(!/^[a-zA-Z0-9_-]+$/.test(server.name))throw new Error(`Invalid mock server name: ${server.name}`);
      const dir=await safePath(root,server.name);
      const files=servers.get(server.name) ?? new Map();
      for(const file of await walk(dir))files.set(file,await safePath(dir,file));
      servers.set(server.name,files);
    }
  }
  const mocks=[];
  for(const [server,files] of servers){
      let schemas=[];
      if(files.has('_tools.json')){const data=JSON.parse(await readText(files.get('_tools.json')));schemas=data.tools ?? data.result?.tools ?? [];}
      for(const [file,source] of files){
        if(file.includes('/'))continue;
        if(!file.endsWith('.md'))continue;
        if(file==='_server.md')throw new Error('Agent server mocks are not implemented; provide one fixed <tool>.md per tool');
        const tool=path.basename(file,'.md');
        if(!/^[a-zA-Z0-9_-]+$/.test(tool))throw new Error(`Invalid mock tool: ${tool}`);
        const {meta,body}=markdown(await readText(source));
        keys(meta,['type','expect','error','description'],'mock');
        if(meta.type && meta.type!=='fixed')throw new Error('Only type: fixed MCP mocks are supported');
        if(meta.error!==undefined && typeof meta.error!=='boolean')throw new Error('Mock error must be boolean');
        keys(meta.expect ?? {},Object.keys(meta.expect ?? {}),'mock expect');
        const fixtures=new Map();
        for(const match of body.matchAll(/\{\{file:([^}]+)\}\}/g)){
          const dir=path.dirname(source),relative=path.relative(dir,contained(dir,match[1])).split(path.sep).join('/');
          const fixture=files.get(relative);
          if(!fixture)throw new Error(`Missing mock fixture: ${server}/${relative}`);
          fixtures.set(match[1],await readText(fixture));
        }
        const result=body.replace(/\{\{file:([^}]+)\}\}/g,(_,relative)=>fixtures.get(relative));
        const schema=schemas.find(s=>s.name===tool);
        mocks.push({server,tool,description:meta.description ?? schema?.description ?? `Mocked ${server}.${tool}`,inputSchema:schema?.inputSchema ?? {type:'object',additionalProperties:true},expect:meta.expect ?? {},isError:meta.error ?? false,body:result});
      }
  }
  return mocks;
}
const valueAt=(input,key)=>key.split('.').reduce((value,part)=>value?.[part],input);
export function mockResponse(mock,input){
  for(const [key,expected] of Object.entries(mock.expect)){
    const value=valueAt(input,key);let pass;
    if(Array.isArray(expected))pass=expected.some(v=>JSON.stringify(v)===JSON.stringify(value));
    else if(['string','number','boolean','array','object'].includes(expected))pass=expected==='array'?Array.isArray(value):expected==='object'?value!==null && typeof value==='object' && !Array.isArray(value):typeof value===expected;
    else if(typeof expected==='string' && /^\/.*\/[a-z]*$/.test(expected)){const last=expected.lastIndexOf('/');pass=new RegExp(expected.slice(1,last),expected.slice(last+1)).test(String(value));}
    else pass=JSON.stringify(value)===JSON.stringify(expected);
    if(!pass)return {aborted:{server:mock.server,tool:mock.tool,reason:`Mock expectation failed for input.${key}`},isError:true,content:[{type:'text',text:`Mock expectation failed for input.${key}`}]};
  }
  const text=mock.body.replace(/\{\{input\.([^}]+)\}\}/g,(_,key)=>{const value=valueAt(input,key);return typeof value==='string'?value:JSON.stringify(value) ?? '';});
  return {isError:mock.isError,content:[{type:'text',text}]};
}
