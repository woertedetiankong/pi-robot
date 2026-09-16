import path from 'node:path';
import { main, parseArgs, splitArgs } from '../cli.mjs';
import { authoringInstructions } from '../init.mjs';

export default function(pi: any) {
  let active: AbortController | undefined;
  pi.registerCommand('eval',{
    description:'Evaluate skills/extensions: /eval init|validate|run <path> [options], /eval stop',
    handler:async (text: string,ctx: any)=>{
      if(text.trim()==='stop'){active?.abort();ctx.ui.notify('Evaluation cancellation requested','info');return;}
      if(active){ctx.ui.notify('An evaluation is running. Use /eval stop to cancel.','warning');return;}
      try {
        const args=splitArgs(text),parsed=parseArgs(args);
        if(parsed.command==='init' && !parsed.options.bare){
          pi.sendUserMessage(authoringInstructions(path.resolve(ctx.cwd,parsed.target),parsed.options));
          return;
        }
        active=new AbortController();
        // Resolve paths against the active session, not the process's original cwd.
        const command=parsed.command;
        const root=path.resolve(ctx.cwd,parsed.target);
        const targetIndex=args.indexOf(parsed.target,1);
        if(['run','validate','init'].includes(command)){
          if(targetIndex>=0)args[targetIndex]=root;else args.splice(1,0,root);
        }
        const logs: string[]=[];
        const code=await main(args,{signal:active.signal,stdout:(s: string)=>logs.push(s),stderr:(s: string)=>{logs.push(s);ctx.ui.setStatus('agent-evals',s.slice(0,100));}});
        pi.sendMessage({customType:'agent-evals',content:logs.join('\n'),display:true,details:{exitCode:code}});
        ctx.ui.notify(`Evaluation command finished (exit ${code})`,code===0?'info':'warning');
      } catch(e: any){ctx.ui.notify(e.message,'error');}
      finally{active=undefined;ctx.ui.setStatus('agent-evals',undefined);}
    }
  });
  pi.on('session_shutdown',()=>active?.abort());
}
