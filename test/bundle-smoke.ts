import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { DefaultResourceLoader, SettingsManager, createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

const root = resolve(process.env.PI_ROBOT_PACKAGE || ".");
const scratch = await mkdtemp(join(tmpdir(), "pi-robot-smoke-"));
const agentDir = join(scratch, "agent");
const cwd = join(scratch, "workspace");
await mkdir(agentDir); await mkdir(cwd);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
// The test doesn't need to start a messaging broker or access user sessions.
await mkdir(join(agentDir, "intercom"));
await writeFile(join(agentDir, "intercom", "config.json"), JSON.stringify({enabled:false}));
await writeFile(join(agentDir, "settings.json"), JSON.stringify({packages:[root]}));
await writeFile(join(cwd, "sample.txt"), "AX17 VDD operating range: 3.0 V to 3.6 V.\n");
const loader = new DefaultResourceLoader({cwd, agentDir, noContextFiles:true, noPromptTemplates:true, noThemes:true});
await loader.reload();
const loaded = loader.getExtensions();
assert.deepEqual(loaded.errors, []);
const commands = loaded.extensions.flatMap(e => [...e.commands.keys()]);
for (const name of ["docs", "code-reset", "eval", "intercom", "companion"]) {
  assert.equal(commands.filter(n => n === name).length, 1, name);
}
const skills = loader.getSkills().skills.map(s => s.name);
for (const name of ["herdr", "pi-teamwork", "agent-evals", "pi-intercom", "datasheet-extraction", "schematic-analysis"]) assert.ok(skills.includes(name), name);
const {session} = await createAgentSession({cwd, agentDir, resourceLoader:loader, settingsManager:SettingsManager.inMemory(), sessionManager:SessionManager.inMemory()});
try {
  await session.bindExtensions({});
  const tools = session.agent.state.tools;
  assert.equal(tools.filter(t => t.name === "code").length, 1);
  for (const name of ["document_import", "document_ocr", "document_view_page", "intercom"]) assert.ok(tools.some(t => t.name === name), name);
  const imported = await tools.find(t => t.name === "document_import")!.execute("import", {path:"sample.txt"});
  assert.ok(!imported.isError, JSON.stringify(imported));
  const result = await tools.find(t => t.name === "code")!.execute("query", {code:'print(embedded_document_query("document_grep", \'{"query":"VDD"}\'))'});
  assert.match(JSON.stringify(result), /3\.0 V to 3\.6 V/);
  console.log(JSON.stringify({passed:true, commands, skills, singleCodeTool:true, realMontyDocumentQuery:true, isolatedAgentDir:agentDir}, null, 2));
} finally { session.dispose(); }
