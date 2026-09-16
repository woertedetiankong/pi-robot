import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Never send model prompts through a shell, including Windows npm shims.
export function executable(name, env = process.env) {
  const override = env[`AGENT_EVALS_${name.toUpperCase()}_BIN`];
  const candidates = override ? [override] : (env.PATH ?? env.Path ?? '').split(path.delimiter).flatMap(dir =>
    process.platform === 'win32' ? [path.join(dir,`${name}.exe`),path.join(dir,`${name}.cmd`),path.join(dir,name)] : [path.join(dir,name)]);
  for (const file of candidates) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    if (/\.cmd$/i.test(file)) {
      const known = name === 'codex' ? 'node_modules/@openai/codex/bin/codex.js' : 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js';
      const script = path.join(path.dirname(file),known);
      if (fs.existsSync(script)) return { command: process.execPath, prefix: [script] };
      continue;
    }
    if (/\.(mjs|js)$/i.test(file)) return { command: process.execPath, prefix: [file] };
    return { command: file, prefix: [] };
  }
  throw new Error(`Cannot find a directly executable ${name}. Set AGENT_EVALS_${name.toUpperCase()}_BIN to its executable or .js entrypoint.`);
}

export function runProcess(command, args, {cwd, env = process.env, input = '', timeoutMs = 300000, signal, onEvent, maxOutputBytes = 16 * 1024 * 1024} = {}) {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve({code:130,error:'Cancelled',stdout:'',stderr:'',events:[]}); return; }
    let stdout = '', stderr = '', pending = '', bytes = 0, error = null, done = false;
    const events = [];
    const child = spawn(command,args,{cwd,env,stdio:['pipe','pipe','pipe'],windowsHide:true,detached:process.platform !== 'win32',shell:false});
    const kill = reason => {
      error ??= reason;
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',shell:false});
        killer.on('error',()=>child.kill());
      } else { try { process.kill(-child.pid,'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const parseLine = line => {
      try { const event = JSON.parse(line); events.push(event); const reason = onEvent?.(event); if (reason) kill(reason); } catch (e) { if (!(e instanceof SyntaxError)) kill(e.message); }
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxOutputBytes) { kill('Output limit exceeded'); return; }
      stdout += chunk; pending += chunk;
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) { parseLine(pending.slice(0,newline)); pending = pending.slice(newline+1); }
    });
    child.stderr.on('data',chunk=>{
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxOutputBytes) { kill('Output limit exceeded'); return; }
      stderr += chunk;
    });
    child.stdin.on('error',()=>{});
    child.stdin.end(input);
    const cancel = () => kill('Cancelled');
    signal?.addEventListener('abort',cancel,{once:true});
    const timer = setTimeout(()=>kill(`Timed out after ${timeoutMs/1000}s`),timeoutMs);
    function finish(code) {
      if (done) return; done = true;
      clearTimeout(timer); signal?.removeEventListener('abort',cancel);
      if (pending.trim()) parseLine(pending);
      resolve({code:code ?? 1,error,stdout,stderr,events});
    }
    child.on('error',e=>{error=e.message; finish(1);});
    child.on('close',finish);
  });
}
