import {spawnSync} from 'node:child_process';
const result=spawnSync(process.execPath,['--test','test/pi-protocol.test.mjs'],{stdio:'inherit',env:{...process.env,AGENT_EVALS_TEST_PI:'1'},windowsHide:true});
if(result.error)console.error(result.error.message);
process.exitCode=result.status ?? 1;
