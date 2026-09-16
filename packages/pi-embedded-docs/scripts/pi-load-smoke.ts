import { DefaultResourceLoader, SettingsManager, createAgentSession, SessionManager } from '@earendil-works/pi-coding-agent';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const agentDir=await mkdtemp(join(tmpdir(),'pi-docs-load-'));
await writeFile(join(agentDir,'settings.json'),JSON.stringify({packages:[resolve('.')] }));
const loader=new DefaultResourceLoader({cwd:process.cwd(),agentDir,noContextFiles:true,noPromptTemplates:true,noThemes:true});
await loader.reload();
const errors=loader.getExtensions().errors;
assert.deepEqual(errors,[]);
const skills=loader.getSkills().skills.map(s=>s.name);
assert.ok(skills.includes('datasheet-extraction'));assert.ok(skills.includes('schematic-analysis'));
const {session}=await createAgentSession({cwd:process.cwd(),agentDir,resourceLoader:loader,settingsManager:SettingsManager.inMemory(),sessionManager:SessionManager.inMemory()});
try{
 const names=session.getAllTools().map(t=>t.name);
 assert.ok(names.includes('document_ocr'));assert.ok(names.includes('document_create_crop'));
 console.log(JSON.stringify({passed:true,tools:names,skills,errors},null,2));
}finally{session.dispose();}
