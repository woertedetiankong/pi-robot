import { minimatch } from 'minimatch';
import { safePath, readText } from './files.mjs';
import { toolName } from './adapters.mjs';

export function toolMatches(call,spec) {
  const matcher = typeof spec === 'string' ? {tool:spec} : spec;
  if (matcher.tool === 'Skill') {
    if (call.tool !== 'read' || !/[\\/]SKILL\.md$/i.test(call.input.path ?? '')) return false;
  } else if (call.tool !== toolName(matcher.tool)) return false;
  return !matcher.input_match || new RegExp(matcher.input_match).test(JSON.stringify(call.input));
}
export function scoredGraders(graders,twoArms) {
  if (!twoArms) return graders.map(()=>true);
  const flags = graders.map(g=>g.arm==='both' || (g.arm!=='with-only' && !(g.type==='tool_used' && g.tool==='Skill')));
  return flags.some(Boolean) ? flags : flags.map(()=>true);
}
export function weightedScore(verdicts) {
  const scored = verdicts.filter(v=>v.scored);
  const weights = scored.reduce((sum,v)=>sum+v.weight,0);
  return weights ? scored.reduce((sum,v)=>sum+(v.passed?v.weight:0),0)/weights : 0;
}
export async function targetText(spec,run,workspace) {
  if (!spec || spec==='last_message') return run.reply ?? '';
  if (spec==='trace') return run.events.map(e=>JSON.stringify(e)).join('\n');
  if (spec==='files') return run.createdFiles.join('\n');
  if (spec==='mock_calls') return (run.mockCalls ?? []).map(e=>JSON.stringify(e)).join('\n');
  return readText(await safePath(workspace,spec.path));
}
export async function grade(g,run,{workspace,caseDir,judge}) {
  try {
    if (g.type==='regex') {
      const text = await targetText(g.target,run,workspace);
      const regex = new RegExp(g.pattern,g.flags ?? '');
      let passed;
      if (g.match?.startsWith('count:')) {
        const all = new RegExp(g.pattern,[...new Set((g.flags ?? '')+'g')].join(''));
        passed=[...text.matchAll(all)].length===Number(g.match.slice(6));
      } else passed = g.match==='not_contains' ? !regex.test(text) : regex.test(text);
      return {passed,reason:`Pattern ${passed?'satisfied':'failed'} (${g.match ?? 'contains'})`};
    }
    if (g.type==='tool_used') {
      const count=run.calls.filter(c=>toolMatches(c,g)).length;
      return {passed:count>=g.min && count<=g.max,reason:`${count} matching calls; expected ${g.min}..${g.max===1e6?'unlimited':g.max}`};
    }
    if (g.type==='tool_order') {
      const before=run.calls.findIndex(c=>toolMatches(c,g.before)),after=run.calls.findIndex(c=>toolMatches(c,g.after));
      return {passed:before>=0 && after>=0 && before<after,reason:`First matching calls: before=${before}, after=${after}`};
    }
    if (g.type==='file_exists') {
      const found=run.createdFiles.filter(file=>minimatch(file,g.path,{dot:true}));
      return {passed:g.exists===false ? !found.length : !!found.length,reason:`Created files matching ${g.path}: ${found.join(', ') || 'none'}`};
    }
    const text=await targetText(g.focus,run,workspace);
    if (text.length>32000) throw new Error('Judge target exceeds 32000 characters; narrow the target or use regex. No silent truncation.');
    const reference=g.type==='baseline'?await readText(await safePath(caseDir,g.baseline_file)):null;
    if (reference?.length>32000) throw new Error('Baseline transcript exceeds 32000 characters');
    const votes=[];
    for (let i=0;i<3;i++) votes.push(await judge({criteria:g.criteria,text,reference}));
    const errors=votes.filter(v=>v.error);
    return {passed:!errors.length && votes.filter(v=>v.passed).length>=2,reason:errors.length?`Judge failure: ${errors[0].error}`:`${votes.filter(v=>v.passed).length}/3 judge votes passed`,votes,error:errors[0]?.error};
  } catch(e) { return {passed:false,reason:e.message,error:e.message}; }
}
export function parseJudge(text) {
  const clean=text.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');
  const parsed=JSON.parse(clean);
  if (typeof parsed.passed!=='boolean' || typeof parsed.reason!=='string') throw new Error('Judge must return {"passed": boolean, "reason": string}');
  return {passed:parsed.passed,reason:parsed.reason};
}
