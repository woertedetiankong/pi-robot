import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { generateCases } from '../src/init.mjs';
import { validateSuite } from '../src/runner.mjs';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent-evals-author-probe-'));
try{
  await fs.mkdir(path.join(root,'skills/demo'),{recursive:true});
  await fs.copyFile(new URL('../examples/commit-helper/skills/commit-helper/SKILL.md',import.meta.url),path.join(root,'skills/demo/SKILL.md'));
  const generated=await generateCases(root,{expect:'Test commit-message requests and unrelated questions. Use final-answer graders.'});
  const {suite}=await validateSuite(root);
  console.log(JSON.stringify({generatedCases:suite.cases.map(c=>c.name),valid:true,costUsd:generated.costUsd}));
}finally{await fs.rm(root,{recursive:true,force:true});}
