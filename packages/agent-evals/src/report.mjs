import fs from 'node:fs/promises';
import path from 'node:path';
import { writeJson } from './files.mjs';

export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const n = value => typeof value==='number'?value.toFixed(2):'—';
export function summary(result) {
  return ['CASE\tWITH\tWITHOUT\tDELTA\tSTATUS',...result.cases.map(c=>`${c.name}\t${n(c.aggregates.score)}\t${n(c.aggregates.without)}\t${n(c.aggregates.delta)}\t${c.passed?'PASS':'FAIL'}`),`Exit ${result.exitCode} | ${result.partial?'PARTIAL | ':''}${result.durationSeconds.toFixed(1)}s | cost ${result.costUsd===null?'unknown':`$${result.costUsd.toFixed(4)}`}`,`Report: ${result.reportPath}`].join('\n');
}
export function html(result) {
  const e=escapeHtml;
  const cases=result.cases.map(c=>`<section><h2>${e(c.name)} <span class="${c.passed?'pass':'fail'}">${c.passed?'PASS':'FAIL'}</span></h2><p>WITH ${n(c.aggregates.score)} · WITHOUT ${n(c.aggregates.without)} · Δ ${n(c.aggregates.delta)}</p>${Object.entries(c.arms).map(([arm,runs])=>runs.map((r,i)=>`<details><summary>${arm} / run ${i+1} — ${n(r.score)} ${r.error?'· ERROR':''}</summary>${r.error?`<p class="fail">${e(r.error)}</p>`:''}<table><tr><th>Grader</th><th>Verdict</th><th>Scored</th><th>Reason</th></tr>${r.graders.map(g=>`<tr><td>${e(g.name)}</td><td class="${g.passed?'pass':'fail'}">${g.passed?'PASS':'FAIL'}</td><td>${g.scored?'yes':'diagnostic'}</td><td>${e(g.reason)}${g.votes?`<details><summary>Judge votes</summary><pre>${e(JSON.stringify(g.votes,null,2))}</pre></details>`:''}</td></tr>`).join('')}</table><h3>Final reply</h3><pre>${e(r.reply)}</pre><h3>Tool calls</h3><pre>${e(JSON.stringify(r.calls,null,2))}</pre><p>Trace: ${e(r.tracePath)}</p><p>Created files: ${e(r.createdFiles.join(', '))}</p></details>`).join('')).join('')}</section>`).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Agent Evals</title><style>body{font:16px/1.6 system-ui;background:#f6f5ef;color:#202b29;max-width:1080px;margin:40px auto;padding:0 24px}h1{font-size:40px;margin-bottom:0}h2{font-size:21px}section{background:white;border:1px solid #d6ddd8;border-radius:10px;margin:24px 0;padding:22px}summary{cursor:pointer;padding:12px 0}table{width:100%;border-collapse:collapse;text-align:left}th,td{padding:10px;border-bottom:1px solid #ddd;vertical-align:top}.pass{color:#23754e}.fail{color:#b33535}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f5f3;padding:14px;font-size:13px}small{color:#5b6963}</style><h1>Agent Evals</h1><small>${e(result.backend)} · ${e(result.startedAt)} · ${result.durationSeconds.toFixed(1)}s</small><p>${result.partial?'PARTIAL RUN — ':''}${e(result.reason ?? '')} Exit ${result.exitCode}. Threshold ${result.threshold}. Cost ${result.costUsd===null?'unavailable':`$${result.costUsd.toFixed(4)}`}.</p><p>Δ measures observed score change on these cases. Diagnostic checks are excluded from both arms where applicable. Run errors force score 0.</p>${cases}</html>`;
}
export async function saveReport(result,dir) {
  await fs.mkdir(dir,{recursive:true});
  result.reportPath=path.join(dir,'report.html');
  await writeJson(path.join(dir,'aggregate-result.json'),result);
  await fs.writeFile(result.reportPath,html(result));
}
