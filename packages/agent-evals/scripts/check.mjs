import { spawnSync } from 'node:child_process';
import { walk } from '../src/files.mjs';
for (const dir of ['src','bin','test','scripts','skills']) for(const file of await walk(dir)) {
  if(!file.endsWith('.mjs'))continue;
  const result=spawnSync(process.execPath,['--check',`${dir}/${file}`],{stdio:'inherit'});
  if(result.status!==0)process.exit(result.status ?? 1);
}
console.log('Syntax checks passed');
