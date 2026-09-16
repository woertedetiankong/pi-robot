/** Offline integration fixture. Not included in the published package. */
import { sampleLesson } from "./lesson.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai/compat";

export default function testProvider(pi: ExtensionAPI): void {
  pi.registerProvider("companion-test", {
    baseUrl: "http://127.0.0.1:1", apiKey: "offline-fixture", api: "companion-test-api",
    models: [{ id: "demo", name: "Offline test model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4096 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const isReview = context.systemPrompt?.includes("题目一致性审校员");
      const isCard = context.systemPrompt?.includes("编程陪伴卡片作者");
      const isChat = context.systemPrompt?.includes("独立的知识陪伴助手");
      const quiz = JSON.stringify(context.messages).includes('quiz');
      const card = { lesson: sampleLesson, scenario: { phase: "事前预防", goal: "减少缓存集中失效后的重复重建", constraints: "热点可预测，允许提前调整缓存策略" }, title: "缓存失效：先判断，再动手", kind: quiz ? "judgment" : "text", body: "当大量请求同时遇到过期缓存，你会怎样安排重建？", answer: "请求合并减少重复计算；随机过期时间减少集中失效。具体取决于负载与一致性要求。", sourceIds: [], options: [..."ABCD"].map((label, i) => ({ label, verdict: "conditional", feedback: "在提前预防时有一定帮助，还要根据热点分布调整。", text: ["延长有效期", "合并重建请求", "随机过期时间", "先观察负载"][i], explanation: ["适用于允许较旧数据的场景。", "适用于同一键的并发重建。", "适用于大量键集中到期。", "适用于瓶颈尚未明确的场景。"][i] })) };
      const clarification = JSON.stringify(context.messages).includes("我没看懂这个词或句子");
      const value = isReview ? JSON.stringify({ pass: true, issues: [] }) : isCard ? JSON.stringify(card) : isChat ? clarification ? "重建就是重新取数据并把它存回缓存。" : "选择 B 能减少同一个缓存键的重复重建，但需要处理重建失败和等待超时。" : "主任务完成：这是离线模型验证，没有修改任何代码。";
      const output: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "" }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "pending", timestamp: Date.now() };
      setTimeout(() => {
        if (options?.signal?.aborted) { output.stopReason = "aborted"; stream.push({ type: "error", reason: "aborted", error: output }); stream.end(); return; }
        stream.push({ type: "start", partial: output });
        stream.push({ type: "text_start", contentIndex: 0, partial: output });
        output.content = [{ type: "text", text: value }];
        stream.push({ type: "text_delta", contentIndex: 0, delta: value, partial: output });
        stream.push({ type: "text_end", contentIndex: 0, content: value, partial: output });
        output.stopReason = "stop"; stream.push({ type: "done", reason: "stop", message: output }); stream.end();
      }, isChat ? 1200 : isCard || isReview ? 150 : 5000);
      return stream;
    },
  });
}
