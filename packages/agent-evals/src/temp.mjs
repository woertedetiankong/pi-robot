import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function runtimeTemp(backend,label='run') {
  // Codex refuses to create Windows helper executables below the OS temp directory.
  const root=process.env.AGENT_EVALS_TEMP_ROOT ?? (backend==='codex' && process.platform==='win32' ? path.join(os.homedir(),'.cache','agent-evals') : os.tmpdir());
  await fs.mkdir(root,{recursive:true});
  return fs.mkdtemp(path.join(root,`agent-evals-${label}-`));
}
