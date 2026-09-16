import fs from 'node:fs';
import readline from 'node:readline';
import { mockResponse } from './mocks.mjs';

// Minimal stdio MCP server, launched only by the Codex adapter for fixed fixtures.
const [configPath,server,logPath]=process.argv.slice(2);
const mocks=JSON.parse(fs.readFileSync(configPath,'utf8')).filter(m=>m.server===server);
const lines=readline.createInterface({input:process.stdin});
for await(const line of lines){
  let request;
  try{request=JSON.parse(line);}catch{continue;}
  if(request.id===undefined)continue;
  let result,error;
  if(request.method==='initialize')result={protocolVersion:request.params?.protocolVersion ?? '2024-11-05',capabilities:{tools:{}},serverInfo:{name:'agent-evals-fixed-mocks',version:'0.1.1'}};
  else if(request.method==='ping')result={};
  else if(request.method==='tools/list')result={tools:mocks.map(m=>({name:m.tool,description:m.description,inputSchema:m.inputSchema,annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}}))};
  else if(request.method==='tools/call'){
    const mock=mocks.find(m=>m.tool===request.params?.name);
    if(!mock)error={code:-32602,message:'Unknown mock tool'};
    else{result=mockResponse(mock,request.params.arguments ?? {});fs.appendFileSync(logPath,JSON.stringify({type:'agent_evals.mock_call',server,tool:mock.tool,input:request.params.arguments ?? {},result})+'\n');}
  }else error={code:-32601,message:'Method not found'};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,...(error?{error}:{result})})+'\n');
}
