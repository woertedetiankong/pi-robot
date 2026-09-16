import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { readFile } from 'node:fs/promises';
import { DocumentService, type Scope } from './service.ts';
import { definitions, dispatch } from './tools.ts';
import { createDocumentTextTools } from './code-mode.ts';

const STATE='embedded-docs-scope-v1';
export default function embeddedDocs(pi:ExtensionAPI) {
  let scope:Scope={ids:[]}, service:DocumentService, currentCwd='';
  function getService(ctx:ExtensionContext) {
    if(!service||currentCwd!==ctx.cwd) {service=new DocumentService(ctx.cwd);currentCwd=ctx.cwd;scope={ids:[]};}
    return service;
  }
  function restore(ctx:ExtensionContext) {
    getService(ctx); scope={ids:[]};
    for(const entry of ctx.sessionManager.getBranch()) {
      if(entry.type==='custom'&&entry.customType===STATE) {
        const data=entry.data as {cwd?:string;ids?:unknown};
        if(data?.cwd===ctx.cwd&&Array.isArray(data.ids)) scope={ids:data.ids.filter((id):id is string=>typeof id==='string'&&/^d-[a-f0-9]{24}$/.test(id))};
      }
      // Tool results are branch-aware too, including replayed/forked sessions.
      if(entry.type==='message'&&entry.message.role==='toolResult') {
        const toolName=entry.message.toolName;
        const details=entry.message.details as any;
        if(definitions.some(d=>d.name===toolName)&&details?.embeddedDocsScope?.cwd===ctx.cwd&&Array.isArray(details.embeddedDocsScope.ids)) {
          scope={ids:details.embeddedDocsScope.ids.filter((id:unknown):id is string=>typeof id==='string'&&/^d-[a-f0-9]{24}$/.test(id))};
        }
      }
    }
    status(ctx);
  }
  function status(ctx:ExtensionContext) {if(ctx.hasUI)ctx.ui.setStatus('embedded-docs',scope.ids.length?`Docs: ${scope.ids.length}`:undefined);}
  function save(ctx:ExtensionContext) {pi.appendEntry(STATE,{cwd:ctx.cwd,ids:[...scope.ids]});status(ctx);}
  // Shared in-process bridge; only scoped, read-only text operations are exposed.
  pi.events.on('embedded-docs:query', (request:any) => {
    if (!service) {request.accept(Promise.reject(new Error('Document session is not initialized')));return;}
    request.accept(createDocumentTextTools(service,()=>scope)[0].execute(request.args,request.kwargs,request.signal));
  });
  pi.on('session_start',async(_event,ctx)=>restore(ctx));
  pi.on('session_tree',async(_event,ctx)=>restore(ctx));
  for(const definition of definitions) {
    pi.registerTool({
      ...definition,label:definition.name,
      async execute(_id,args,signal,_update,ctx) {
        if(['document_view_page','document_create_crop','document_view_region'].includes(definition.name)&&ctx.model&&!ctx.model.input.includes('image')) {
          throw new Error('Visual evidence requires an image-capable model. Switch models before inspecting pages or circuits; OCR text alone cannot verify connectivity.');
        }
        const s=getService(ctx), active=scope;
        const result=await dispatch(s,active,definition.name,args,signal);
        const content:any[]=[{type:'text',text:JSON.stringify(result.data,null,2)}];
        if(result.image) content.push({type:'image',data:(await readFile(result.image)).toString('base64'),mimeType:'image/png'});
        status(ctx);
        return {content,details:{embeddedDocsScope:{cwd:ctx.cwd,ids:[...active.ids]},evidence:result.data}};
      },
    });
  }
  pi.registerCommand('docs',{
    description:'Docs: add <path> [--pages 1-5], list, only <id,...>, off. User add may import outside cwd.',
    handler:async(args,ctx)=>{
      try {
        const s=getService(ctx);
        if(args.trim()==='off') {scope={ids:[]};save(ctx);ctx.ui.notify('Document scope cleared','info');return;}
        if(args.startsWith('only ')) {
          const ids=args.slice(5).split(',').map(x=>x.trim());
          for(const id of ids)await s.record(id,scope);
          scope={ids};save(ctx);return;
        }
        if(args.startsWith('add ')) {
          const match=/^add\s+(.+?)(?:\s+--pages\s+([\d,\-]+))?$/.exec(args.trim());
          if(!match)throw new Error('Use /docs add <path> --pages 1-5');
          let path=match[1];if((path.startsWith('"')&&path.endsWith('"'))||(path.startsWith("'")&&path.endsWith("'")))path=path.slice(1,-1);
          const doc=await s.importFile(path,match[2],true);
          if(!scope.ids.includes(doc.id))scope.ids.push(doc.id);save(ctx);
          pi.sendMessage({customType:'embedded-docs-info',content:JSON.stringify(s.summary(doc),null,2),display:true});return;
        }
        pi.sendMessage({customType:'embedded-docs-info',content:JSON.stringify(await s.list(scope),null,2)+'\n/docs add <path> [--pages 1-5] | only <id,...> | off',display:true});
      }catch(e){ctx.ui.notify(e instanceof Error?e.message:String(e),'error');}
    },
  });
}
