import { randomUUID } from "node:crypto";
import type { Card } from "./types.ts";

const topics = [
  { title: "重试，也会把小故障放大吗？", body: "服务刚恢复，所有客户端立即重试，最可能造成什么？", options: ["让重复请求只产生一次效果", "让数据永远保持一致", "再次制造流量尖峰", "自动修复服务错误"], correct: "C", answer: "服务刚恢复，一千个客户端又同时发请求，可能把它再次压垮。可以让每个客户端多等一会儿再试，并把等待时间随机错开；失败越多就等得越久，且限制最多重试几次。这样请求不会总挤在同一刻。", explanations: ["同一笔付款重试两次，仍可能扣两次钱；需要服务端识别重复操作，重试本身做不到。", "再发一次请求不保证各处的数据都同时更新成功。", "大家同时再试，会让刚恢复的服务又一下子收到大量请求。", "如果程序本身有错误，再发同样的请求通常还是会失败。"] },
  { title: "一次点击，为什么扣了两次？", body: "付款请求超时后重试，怎样减少重复扣款的风险？", options: ["每次重试使用新的订单号", "同一次付款复用幂等键", "把超时设置得更短", "隐藏重试按钮"], correct: "B", answer: "幂等键就是同一次操作反复使用的唯一编号。付款超时，只说明你没等到回复，不代表银行没扣钱。重试时带上原编号，服务端才能认出“这笔已经处理过”，返回原结果。服务端还要保证同时收到两次请求时，也只能有一次真正执行扣款。", explanations: ["每次换新订单号，服务端可能以为你又发起了一笔新付款。", "同一笔付款一直用同一个唯一编号，服务端才能识别重复请求，避免再次扣款。", "等待更短会更容易报超时，用户或程序反而可能重试更多次。", "隐藏按钮只挡住手动点击，程序仍可能自动重发付款请求。"] },
  { title: "缓存过期，谁来重建？", body: "同一个热门缓存键失效，一千个请求同时到达。什么能直接减少重复重建？", options: ["合并同一键的重建请求", "把日志全部关闭", "只给其他键增加随机过期时间", "让每个请求单独重建"], correct: "A", answer: "缓存就是临时存好、方便下次直接取的数据。这份数据过期时，可以只让一个请求重新取数据并存好，其他请求等它的结果；不用一千个请求都做一遍。还要规定最多等多久，以及负责取数据的请求失败后怎么办。", explanations: ["大家要的是同一份数据，让一个请求去取、其他请求共享结果，就能减少重复工作。", "关日志只是停止记录发生了什么，不会阻止一千个请求各自去取同一份数据。", "其他数据什么时候过期，不会改变这一千个请求正在争着重建同一份数据的情况。", "每个人都独自取一遍同样的数据，会让数据库或计算服务重复做大量工作。"] },
  { title: "绿灯测试，也可能漏掉什么？", body: "函数在单个请求下测试通过，真实并发下仍可能出现哪类问题？", options: ["所有变量自动变成常量", "网络延迟完全消失", "测试自动覆盖全部路径", "共享状态的竞争条件"], correct: "D", answer: "竞争条件是指：多个请求同时操作同一份数据，结果会受先后顺序影响。比如库存只剩一件，两个人同时读到“还有一件”，又都下单成功，就超卖了。单人下单测试发现不了这个问题，需要测试多人同时下单时是否仍只卖出一件。", explanations: ["多个请求同时运行，不会让原本能修改的变量突然不能修改。", "请求同时运行，仍然需要等待网络传输。", "测试只检查了实际跑过的情况，没有跑过的分支和同时操作的情况仍可能出错。", "两个请求都读到旧库存，再分别扣减，就可能把同一件商品卖两次；单请求测试不会出现这种交错。"] },
];
const illustrations = [
  "例子：1000 个客户端刚才都失败了。每个客户端限制重试次数，并随机错开等待时间，避免再次一起冲过来。\n\n```text\n[请求失败]\n     |\n     v\n[到重试上限?]--是-->[停止]\n     | 否\n     v\n[等待更久并随机错开]\n     |\n     v\n[再试，失败回到上限检查]\n```\n这样是在分散压力，不是在修复服务本身的错误。",
  "例子：订单 123 的付款超时了，重发时仍带编号 K123。服务端必须保证对这个编号的检查和处理不会被两个请求同时抢先执行。\n\n```text\n[收到付款编号 K123]\n     |\n     v\n[服务端防重复处理]\n     |\n     +--已完成-->[返回旧结果]\n     |\n     +--处理中-->[等待或查状态]\n     |\n     +--未开始-->[执行并记录]\n```\n只给请求加编号还不够，服务端必须真正识别并阻止重复扣款。",
  "例子：1000 人同时查同一件商品的价格，缓存刚好过期。合并重建时，让一个请求查数据库，其余请求在规定时间内等待这次结果。\n\n```text\n[1000 人查同一价格]\n     |\n     v\n[缓存过期，合并重建]\n     |\n     v\n[1 个查库，其余等待]\n     |\n     v\n[成功后存缓存，共享结果]\n```\n图中是成功路径；如果查库失败或等待超时，要另行处理，不能让大家一直等。",
  "例子：库存剩 1 件。小王和小李都在对方扣库存之前查库存，于是都以为自己能买到。\n\n```text\n[库存 = 1]\n     |\n     v\n[小王读到 1，尚未扣减]\n     |\n     v\n[小李也读到 1]\n     |\n     v\n[两人都按旧库存下单]\n     |\n     v\n[1 件商品卖给了 2 人]\n```\n这是出错的交错顺序。只测试一个人下单，发现不了这种超卖。",
];
export function warmup(format: "text" | "quiz", recentTitles: string[], task = ""): Card {
  const available = topics.filter(t => !recentTitles.includes(t.title));
  const pool = available.length ? available : topics;
  const topic = pool.find(t => /缓存|cache/i.test(task) && t.title.includes("缓存")) ?? pool[recentTitles.length % pool.length];
  const scenarios = [
    { phase: "服务恢复期间", goal: "避免重试形成新的流量尖峰", constraints: "大量客户端收到相同故障，可能同时重试" },
    { phase: "付款请求超时后", goal: "避免同一次付款被重复执行", constraints: "超时不代表服务端未处理，接口支持幂等设计" },
    { phase: "热门缓存键刚失效", goal: "直接减少同一个键的重复重建", constraints: "大量请求同时到达同一个键" },
    { phase: "上线前验证", goal: "发现单请求测试未覆盖的风险", constraints: "函数会被并发调用，存在共享状态" },
  ];
  const index = topics.indexOf(topic);
  const [example, diagram, caveat] = illustrations[index].split(/\n\n```text\n|\n```\n/);
  const scopes = [
    "适用于故障后的自动重试；仍需限制次数，随机等待不保证服务一定恢复。",
    "前提是服务端实现了防重复执行的机制；仅传同一个编号并不能保证不重复扣款。",
    "针对同一个缓存键同时失效后的成功重建；不同键、失败和超时需另外处理。",
    "这描述的是先读库存、再分别扣减的出错实现；并非所有并发下单都会超卖。",
  ];
  const lesson = { summary: topic.explanations["ABCD".indexOf(topic.correct)], scope: scopes[index], example: example.replace(/^例子：/, ""), diagram };
  return { lesson, scenario: scenarios[index], id: randomUUID(), kind: format === "quiz" ? "knowledge" : "text", title: topic.title, body: topic.body, answer: `${topic.answer}\n\n${caveat}`, origin: "builtin", createdAt: new Date().toISOString(), sources: [], ...(format === "quiz" ? { correct: topic.correct, options: topic.options.map((text, i) => ({ label: "ABCD"[i] as "A" | "B" | "C" | "D", text, explanation: topic.explanations[i] })) } : {}) };
}
export function isMetaCard(card: Card): boolean {
  return /缺少.{0,8}(?:项目材料|上下文|项目信息)|我(?:还)?(?:没|未)(?:有)?(?:看到|获得)|先别急着概括|无法(?:可靠)?(?:判断|概括)(?:项目|代码)|请(?:先)?(?:提供|补充).{0,10}(?:材料|上下文|代码)|insufficient (?:context|information)|(?:need|provide|missing) (?:more )?(?:project context|project details)|read\/bash.{0,20}(?:记录|内容|判断)/i.test(`${card.title}\n${card.body}`);
}
