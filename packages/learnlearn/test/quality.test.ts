import { sampleLesson } from "./fixtures/lesson.ts";
import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { generate, parseCard, parseReview } from "../src/cards.ts";
import { defaults } from "../src/config.ts";

const candidate = {
  lesson: sampleLesson,
  kind: "judgment", title: "缓存应急处置", body: "数据库已被打满，当前优先怎样降低回源压力？",
  scenario: { phase: "现场处置", goal: "降低当前回源压力", constraints: "热点不可预测，可快速上线限流与请求合并" },
  options: [
    { label: "A", text: "合并重建请求", explanation: "减少同一键的并发重建。", verdict: "suitable", feedback: "当前可减少同一键的重复回源，但还需要限制总回源并发。" },
    { label: "B", text: "全部绕过缓存", explanation: "会增加数据库负载。", verdict: "unsuitable", feedback: "当前会进一步加重数据库压力，应优先减少回源。" },
    { label: "C", text: "限制回源并发", explanation: "以部分请求等待或失败换取数据库恢复。", verdict: "suitable", feedback: "当前能限制总负载，但要明确超时和降级策略。" },
    { label: "D", text: "定时预热热点", explanation: "适用于事前可预测的热点。", verdict: "unsuitable", feedback: "预热适合提前预防；当前热点不可预测且故障已经发生，单靠它无法止住回源压力。" },
  ], answer: "当前先控制回源压力，可组合请求合并和限流。预热属于后续预防措施。", sourceIds: [],
};
function fake(reply: (review: boolean, input: any) => unknown): ExtensionContext {
  return { model: { id: "fake" }, modelRegistry: { complete: async (_model: any, input: any) => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify(reply(input.systemPrompt.includes("题目一致性审校员"), input)) }] }) } } as unknown as ExtensionContext;
}
test("judgment requires scenario, per-choice feedback, distinct choices and a reasonable option", () => {
  assert.throws(() => parseCard(JSON.stringify({ ...candidate, scenario: undefined }), []), /场景/);
  assert.throws(() => parseCard(JSON.stringify({ ...candidate, correct: "A" }), []), /唯一/);
  assert.throws(() => parseCard(JSON.stringify({ ...candidate, options: candidate.options.map(o => ({ ...o, verdict: "unsuitable" })) }), []), /所有选项/);
  assert.throws(() => parseCard(JSON.stringify({ ...candidate, options: candidate.options.map(o => ({ ...o, feedback: "" })) }), []), /feedback/);
  const card = parseCard(JSON.stringify(candidate), []);
  assert.equal(card.options?.[3].verdict, "unsuitable"); assert(card.options?.[3].feedback?.includes("提前预防"));
});
test("semantic review rejection is sent to one rewrite; only approved candidate is returned", async () => {
  let reviews = 0, drafts = 0;
  const ctx = fake((review, input) => {
    if (review) return ++reviews === 1 ? { pass: false, issues: ["救急与预防混淆，预热不能当作当前处置"] } : { pass: true, issues: [] };
    drafts++;
    if (drafts === 2) assert(JSON.stringify(input.messages).includes("救急与预防混淆"));
    return { ...candidate, title: drafts === 1 ? "有问题的初稿" : "改正后的场景题" };
  });
  const card = await generate(ctx, defaults, "task", "quiz", "缓存", [], [], new AbortController().signal);
  assert.equal(drafts, 2); assert.equal(reviews, 2); assert.equal(card.title, "改正后的场景题");
});
test("repeated rejection is bounded and falls back only in task mode", async () => {
  for (const mode of ["task", "wander"] as const) {
    let calls = 0;
    const ctx = fake(review => { calls++; return review ? { pass: false, issues: ["答案与条件矛盾"] } : candidate; });
    const run = generate(ctx, defaults, mode, "quiz", "缓存", [], [], new AbortController().signal);
    if (mode === "task") assert.equal((await run).origin, "builtin"); else await assert.rejects(run, /检查未通过/);
    assert.equal(calls, 4);
  }
});
test("review cannot fail open on malformed or contradictory reports; cancellation stops rewrites", async () => {
  assert.throws(() => parseReview('{"pass":"true","issues":[]}'));
  assert.deepEqual(parseReview('{"pass":true,"issues":["仍有多个正确答案"]}'), ["仍有多个正确答案"]);
  let calls = 0; const abort = new AbortController();
  const ctx = fake(review => { calls++; if (review) abort.abort(); return review ? { pass: false, issues: ["不一致"] } : candidate; });
  await assert.rejects(generate(ctx, defaults, "task", "quiz", "", [], [], abort.signal));
  assert.equal(calls, 2);
});

test("lesson validates complete scope and short examples without silently truncating conditions", () => {
  const card = parseCard(JSON.stringify(candidate), []);
  assert.deepEqual(card.lesson, sampleLesson);
  const indented = "    [开始]\n       |\n       v\n    [结束]";
  assert.equal(parseCard(JSON.stringify({ ...candidate, lesson: { ...sampleLesson, diagram: indented } }), []).lesson?.diagram, indented);
  assert.equal(parseCard(JSON.stringify({ ...candidate, lesson: undefined }), []).lesson, undefined);
  for (const lesson of [null, {}, { ...sampleLesson, scope: "" }, { ...sampleLesson, scope: "条件".repeat(81) }, { ...sampleLesson, diagram: "节点\n".repeat(18) }]) {
    assert.throws(() => parseCard(JSON.stringify({ ...candidate, lesson }), []), /lesson/);
  }
});

test("new generation requests one repair for a missing lesson, preserving compatibility when parsing old cards", async () => {
  let drafts = 0;
  const ctx = fake((review, input) => {
    if (review) return { pass: true, issues: [] };
    drafts++;
    if (drafts === 2) assert(JSON.stringify(input.messages).includes("新卡片必须提供 lesson"));
    return { ...candidate, lesson: drafts === 1 ? undefined : sampleLesson };
  });
  const card = await generate(ctx, defaults, "wander", "quiz", "", [], [], new AbortController().signal);
  assert.equal(drafts, 2); assert.deepEqual(card.lesson, sampleLesson);
});
