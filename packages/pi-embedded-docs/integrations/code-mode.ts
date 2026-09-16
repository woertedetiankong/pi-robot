// Optional replacement loader for an existing local pi-code-mode package.
// The installer writes a tiny wrapper with its exact import path; nothing is
// copied or changed inside pi-code-mode itself.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
export function codeModeDocumentTool(pi:ExtensionAPI) {
  return {
    name:'embedded_document_query',
    description:'Read current document scope using document_list, document_grep, document_search, document_read or document_check_citations. args_json is JSON. Use direct pi tools for import, OCR and images.',
    params:[{name:'tool',type:'str'},{name:'args_json',type:'str'}],returns:'str',
    async execute(args:unknown[],kwargs:Record<string,unknown>,signal?:AbortSignal) {
      signal?.throwIfAborted();
      let result:Promise<unknown>|undefined;
      pi.events.emit('embedded-docs:query',{args,kwargs,signal,accept:(promise:Promise<unknown>)=>{if(result)throw new Error('Multiple document providers');result=promise;}});
      if(!result)throw new Error('Load pi-embedded-docs before querying documents');
      return result;
    },
  };
}
