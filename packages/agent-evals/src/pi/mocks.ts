import fs from 'node:fs';
import { mockResponse } from '../mocks.mjs';

export default function(pi: any){
  const mocks=JSON.parse(fs.readFileSync(process.env.AGENT_EVALS_MOCKS!, 'utf8'));
  const names=new Set(mocks.map((mock: any)=>`mcp__${mock.server}__${mock.tool}`));
  pi.on('tool_result',(event: any)=>{
    if(names.has(event.toolName) && event.details?.mockCall) return {isError:event.details.mockCall.result.isError};
  });
  for(const mock of mocks)pi.registerTool({
    name:`mcp__${mock.server}__${mock.tool}`,label:`${mock.server}.${mock.tool}`,description:mock.description,parameters:mock.inputSchema,
    async execute(_id: string,input: any){
      const result=mockResponse(mock,input);
      const mockCall={type:'agent_evals.mock_call',server:mock.server,tool:mock.tool,input,result};
      return {content:result.content,details:{mock:true,mockCall},...(result.aborted?{terminate:true}:{})};
    }
  });
}
