import fs from 'node:fs';
import path from 'node:path';

// Behavioral guard for built-ins; trusted extension code is not OS-sandboxed.
export default function(pi: any) {
  const policy = JSON.parse(fs.readFileSync(process.env.AGENT_EVALS_POLICY!, 'utf8'));
  const inside = (root: string, p: string) => {
    const rel = path.relative(root,p);
    return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
  };
  const canonical = (p: string): string => {
    if (fs.existsSync(p)) return fs.realpathSync(p);
    return path.join(canonical(path.dirname(p)),path.basename(p));
  };
  pi.on('tool_call',async (event: any) => {
    const name = event.toolName;
    if (!policy.tools.includes(name)) return {block:true,reason:`Tool not granted: ${name}`};
    if (['read','write','edit','find','grep','ls'].includes(name)) {
      const raw = event.input.path ?? '.';
      const p = canonical(path.resolve(policy.workspace,raw));
      const roots = ['write','edit'].includes(name) ? [policy.workspace] : [policy.workspace,...policy.readRoots];
      if (!roots.some((root: string)=>inside(canonical(root),p))) return {block:true,reason:'Path outside evaluation workspace and skill resources'};
      // Recursive tools must not follow workspace symlinks outside the read roots.
      if (['find','grep','ls'].includes(name)) {
        const visit = (dir: string): boolean => {
          if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return true;
          for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
            const file = path.join(dir,entry.name);
            if (entry.isSymbolicLink()) return false;
            if (entry.isDirectory() && !visit(file)) return false;
          }
          return true;
        };
        if (!visit(p)) return {block:true,reason:'Recursive reads of symlink trees are disabled'};
      }
    }
  });
}
