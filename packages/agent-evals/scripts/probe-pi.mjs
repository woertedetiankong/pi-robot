import { executable,runProcess } from '../src/process.mjs';
const {command,prefix}=executable('pi');
const result=await runProcess(command,[...prefix,'--mode','rpc','--offline','--no-skills','--no-context-files'],{
  input:JSON.stringify({id:'eval-command-check',type:'get_commands'})+'\n',timeoutMs:15000,
  onEvent:event=>event.id==='eval-command-check'?'Probe complete':null,
});
const reply=result.events.find(e=>e.id==='eval-command-check');
if(!reply?.success || !reply.data?.commands?.some(c=>c.name==='eval')){
  console.error(JSON.stringify(reply ?? {error:result.error,stderr:result.stderr}));process.exitCode=1;
}else console.log('Installed pi /eval command registered successfully');
