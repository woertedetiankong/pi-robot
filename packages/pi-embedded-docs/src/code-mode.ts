import { DocumentService, type Scope } from './service.ts';
import { dispatch } from './tools.ts';

// Structural HostTool contract: no hard dependency on pi-code-mode or Monty.
// Caller supplies the same session scope explicitly; no global document discovery.
export function createDocumentTextTools(service:DocumentService,getScope:()=>Scope) {
  return [{
    name:'embedded_document_query',
    description:'Call a scoped document text tool: document_list, document_grep, document_search, document_read, document_check_citations. args_json is a JSON object. Images and OCR use direct pi tools.',
    params:[{name:'tool',type:'str'},{name:'args_json',type:'str'}],returns:'str',
    async execute(args:unknown[],kwargs:Record<string,unknown>,signal?:AbortSignal) {
      const tool=String(args[0]??kwargs.tool),json=String(args[1]??kwargs.args_json??'{}');
      if(!['document_list','document_grep','document_search','document_read','document_check_citations'].includes(tool))throw new Error('Only text query tools are available in code-mode');
      const result=await dispatch(service,getScope(),tool,JSON.parse(json),signal);
      return JSON.stringify(result.data);
    },
  }];
}
