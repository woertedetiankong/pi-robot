import { readFile, writeFile, mkdir, rename, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const agentDir=process.env.PI_CODING_AGENT_DIR??join(homedir(),'.pi','agent');
const settingsPath=join(agentDir,'settings.json'),installDir=join(agentDir,'embedded-docs-install');
const markerPath=join(installDir,'install.json'),wrapperPath=join(installDir,'code-mode.ts');
const argv=process.argv.slice(2),dry=argv.includes('--dry-run');
const codeIndex=argv.indexOf('--with-code-mode');
if(codeIndex>=0&&(!argv[codeIndex+1]||argv[codeIndex+1].startsWith('--')))throw new Error('--with-code-mode requires a local package path');
const codeRoot=codeIndex<0?undefined:resolve(argv[codeIndex+1]??'');
const before=await readFile(settingsPath,'utf8').catch(()=>'{"packages":[]}');
const settings=JSON.parse(before);settings.packages??=[];
let marker;try{marker=JSON.parse(await readFile(markerPath,'utf8'));}catch{}
if(marker&&marker.root!==root)throw new Error('Another embedded-docs checkout owns this install');
if(!settings.packages.some(p=>resolve(typeof p==='string'?p:p.source)===root))settings.packages.push(root);
let codeEntry;
if(codeRoot){
 await access(join(codeRoot,'src/pi/extension.ts'));
 const index=settings.packages.findIndex(p=>resolve(typeof p==='string'?p:p.source)===codeRoot);
 if(index<0)throw new Error('Specified pi-code-mode must already be installed in pi packages');
 codeEntry=marker?.codeEntry??settings.packages[index];
 settings.packages[index]={...(typeof settings.packages[index]==='object'?settings.packages[index]:{source:settings.packages[index]}),extensions:[]};
 settings.extensions??=[];if(!settings.extensions.includes(wrapperPath))settings.extensions.push(wrapperPath);
}
console.log(JSON.stringify({dryRun:dry,package:root,settings:settingsPath,codeMode:codeRoot??null,changes:['add document package',...(codeRoot?['replace code-mode loader with same implementation plus scoped text adapter']:[])]},null,2));
if(!dry){
 await mkdir(installDir,{recursive:true});
 const backup=join(installDir,'settings-'+Date.now()+'.json');await writeFile(backup,before);
 if(codeRoot)await writeFile(wrapperPath,
  `import {createCodeModeExtension} from ${JSON.stringify(pathToFileURL(join(codeRoot,'src/pi/extension.ts')).href)};\n`+
  `import {codeModeDocumentTool} from ${JSON.stringify(pathToFileURL(join(root,'integrations/code-mode.ts')).href)};\n`+
  `export default async function(pi) { return createCodeModeExtension({tools:[codeModeDocumentTool(pi)]})(pi); }\n`);
 const current=await readFile(settingsPath,'utf8').catch(()=>'{"packages":[]}');
 if(current!==before)throw new Error('Settings changed concurrently; not overwriting');
 const temp=settingsPath+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(settings,null,2)+'\n');await rename(temp,settingsPath);
 await writeFile(markerPath,JSON.stringify({...marker,root,...(codeRoot?{codeRoot,codeEntry,wrapperPath}:{}),backup},null,2));
 console.log('Installed. Start a new pi session or /reload. Backup: '+backup);
}
