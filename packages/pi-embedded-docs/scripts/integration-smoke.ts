import { DefaultResourceLoader, SettingsManager, createAgentSession, SessionManager } from '@earendil-works/pi-coding-agent';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root=resolve('.'),codeRoot=resolve(process.argv[2]??'../pi-code-mode');
const agentDir=await mkdtemp(join(tmpdir(),'pi-docs-integration-'));
await writeFile(join(agentDir,'settings.json'),JSON.stringify({packages:[codeRoot],defaultThinkingLevel:'off'}));
execFileSync(process.execPath,['scripts/install.mjs','--with-code-mode',codeRoot],{env:{...process.env,PI_CODING_AGENT_DIR:agentDir},stdio:'pipe'});
const settings=JSON.parse(await readFile(join(agentDir,'settings.json'),'utf8'));
assert.deepEqual(settings.packages[0].extensions,[]);
assert.equal(settings.defaultThinkingLevel,'off');
const loader=new DefaultResourceLoader({cwd:root,agentDir,noContextFiles:true,noPromptTemplates:true,noThemes:true});
await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
const {session}=await createAgentSession({cwd:root,agentDir,resourceLoader:loader,settingsManager:SettingsManager.inMemory(),sessionManager:SessionManager.inMemory()});
try {
 await session.bindExtensions({});
 const tools=session.agent.state.tools;
 assert.equal(tools.filter(t=>t.name==='code').length,1);
 const doc=tools.find(t=>t.name==='document_import')!;
 await doc.execute('smoke-import',{path:'evals/datasheet-fact/fixtures/AX17-datasheet.pdf'});
 const code=tools.find(t=>t.name==='code')!;
 const result=await code.execute('smoke-code',{code:'print(embedded_document_query("document_grep", \'{"query":"VDD"}\'))'});
 const text=JSON.stringify(result);
 assert.match(text,/3\.0/);assert.match(text,/3\.6/);
 console.log(JSON.stringify({passed:true,agentDir,oneCodeTool:true,realMontyDocumentQuery:true},null,2));
}finally{session.dispose();}
