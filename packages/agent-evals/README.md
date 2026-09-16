# Agent Evals

给 pi 和 Codex 的 Skills／扩展做可重复的行为评测。根据 [Claude Plugin Evals 官方文档](https://code.claude.com/docs/en/plugin-evals)独立实现，MIT 许可，不包含 Claude Code 源码，也不依赖 Codetrap。

同一批案例可选择 pi 或 Codex 执行。默认带目标、无目标各运行三次，检查最终回复、工具调用或生成文件，输出本地 HTML／JSON 报告。支持 pi 扩展安装和 Codex Skill 安装。它是可用的独立实现，**不是 Claude 功能的完全兼容替代品**；差异见[兼容性说明](docs/compatibility.md)。

## 功能边界

本项目面向 pi 和 Codex，以完整的核心评测闭环为目标：编写用例 → 静态验证 → 单次试跑 → 重复对照 → 检查评分证据 → 回归验证。优先保证目标加载正确、评分可信、Mock 可重复、隔离和失败处理明确，以及两端安装可用。

不追求 Claude CLI、插件清单或 Artifact 发布服务的完全兼容。图片裁判、多轮历史恢复、模型 Mock／回放可按真实用例需要扩展；它们不是在 pi 和 Codex 安装使用的前提。

## 安装

需要 Node.js 22+，以及已配置模型和登录凭据的 pi 或 Codex CLI。v0.1.1 的原生协议回归验证使用 pi 0.85.1；Codex 0.151.0 的真实模型验证来自 v0.1.0。目标模型也必须受当前 CLI 版本支持。

在本项目目录执行：

```powershell
npm ci
node bin/agent-evals.mjs install pi
node bin/agent-evals.mjs install codex
```

pi 安装会把此包的绝对路径加入 pi 配置，重启 pi 后使用 `/eval`。Codex 安装会把 `agent-evals` Skill 放入 `$CODEX_HOME/skills`，在新会话里使用 `$agent-evals`，或自然语言请求它评测一个 Skill。两种安装均引用本项目文件，移动项目后需重新安装。安装器不会覆盖不属于自己的已有 Codex Skill。

也可以直接 `pi install <本项目绝对路径>`。`npm pack` 生成可分发的 npm 包；本项目不会自动发布到 npm。独立 CLI 可用 `npm install -g <本项目绝对路径>` 安装，或者始终使用 `node <本项目路径>/bin/agent-evals.mjs`。

卸载 pi：`pi remove <本项目绝对路径>`。卸载 Codex 入口：移除安装器创建的 `skills/agent-evals` 目录；测试目标和报告不受影响。

## 在 pi 中使用

```text
/eval init D:/projects/my-skill-package
/eval validate D:/projects/my-skill-package
/eval run D:/projects/my-skill-package --runs 1 --ablation none
/eval run D:/projects/my-skill-package
/eval run D:/projects/my-skill-package --backend codex --model <model-id>
/eval stop
```

`/eval init` 让当前 pi 会话阅读目标、讨论成功标准并编写案例。评测命令本身不自动改变被测 Skill。`/eval stop` 取消正在运行的评测，终止子进程并保存已完成的结果。

## 在 Codex 中使用

新会话中可以说：

> 用 $agent-evals 评测 D:/projects/my-skill-package，先生成正反案例，再各运行一次；执行器使用 Codex。

也可以直接执行相同 CLI：

```powershell
node bin/agent-evals.mjs run examples/commit-helper --backend codex --model <model-id> --runs 1
```

**宿主和执行器是独立的选择**：在 pi 里可以测 Codex，在 Codex 里也可以调用 CLI 测 pi。pi 扩展代码只能由 pi 执行；Codex 侧测试的是可移植的 Skills。

## 创建案例

```powershell
# 只生成模板，不调用模型
node bin/agent-evals.mjs init D:/projects/my-package --bare first-case

# 让模型读取目标 Skills 并生成草案
node bin/agent-evals.mjs init D:/projects/my-package --expect "提交信息应准确、简短；无关问题不触发"

# 静态检查后先跑小规模试验
node bin/agent-evals.mjs validate D:/projects/my-package
node bin/agent-evals.mjs run D:/projects/my-package --runs 1 --ablation none
```

CLI 自动生成会创建 1–8 个案例，已有同名案例不会被覆盖。模型输出不符合格式时最多修复一次，仍不合格则报错且不写入案例。草案需要审阅；CLI 不假装已经试跑。pi 的交互式 authoring Skill 会指导会话进行检查、试跑和调整。

```text
my-package/
  skills/my-skill/SKILL.md
  eval.config.json               可选
  evals/
    first-case/
      prompt.md
      graders/result.md
      case.yaml                 可选的环境准备
    mocks/weather/lookup.md     可选的固定 MCP 响应
    results/<timestamp>/
      aggregate-result.json
      report.html
      traces/
      artifacts/
```

`prompt.md` 示例：

```markdown
---
tags: [smoke]
timeout_seconds: 120
---

帮我为这次修改写提交信息：getUser 重命名为 fetchUser，三个调用点已更新。
```

`graders/result.md` 示例：

```markdown
---
type: llm
---

PASS if the message accurately describes the rename without inventing a functionality change.
FAIL if it omits the rename or invents behavior changes.
```

六类评分器：`regex`、`tool_used`、`tool_order`、`file_exists`、`llm`、`baseline`。前四类本地计算，后两类每次调用三个独立模型裁判，至少两票通过且没有裁判错误才通过。完整字段见 [Schema](skills/agent-evals/references/schema.md)。

默认发现 `skills/`、根目录 `SKILL.md`、或 pi package.json 的资源字段。需要精确选择时，在目标根目录添加：

```json
{
  "skills": ["skills/my-skill"],
  "extensions": [],
  "backend": "pi",
  "eval_dir": "evals"
}
```

`init`、`validate`、`run` 共用此配置；显式命令行参数优先。`skills: []` 和 `extensions: []` 分别关闭对应资源，不会关闭另一类型的发现。自定义 `eval_dir` 同时用于初始化、运行和结果保存。

## 看懂分数

- WITH：加载目标时的平均分。WITHOUT：无目标时的平均分。
- Δ：WITH − WITHOUT。高分不自动证明目标有用。
- 工具触发等目标专属检查应设 `arm: with-only`，在两组中都排除出分数，只显示诊断结果。
- 一个案例全是目标专属检查时，遵循原文档的回退规则全部计分；这种案例无法提供有意义的质量增益判断，应加入结果检查。
- 运行错误强制记 0 分。任何运行／裁判错误或未完成的对照都会令 Δ 为 null，并阻止该案例通过。null 不代表零提升。
- `file_exists` 只算新建文件；修改已有文件用文件内容检查。报告保存调用轨迹，以及不超过 8 MiB 的新增／修改文件副本。

## 工具、模拟和隔离

pi 默认开放 read/grep/find/ls；Write/Edit/Bash 等额外工具必须通过 `--allow-tools write,edit,bash` 指定。目标扩展的工具同样需要授予。内置文件工具的守卫限制访问测试工作区和目标 Skill 资源；Bash 和扩展代码本身没有额外 OS 沙箱，只运行你信任的扩展和脚本。

Codex 使用原生 `--sandbox read-only` 或 `--sandbox workspace-write`，测试中禁用内置网络搜索以减少外部变化。共享案例不要显式设置 `allowed_tools`／`max_turns`；Codex CLI 不提供与 pi 等价的工具白名单或内部轮次事件，因此会拒绝这些字段。Codex 使用墙钟超时限制。

固定 MCP 模拟放在 `evals/mocks/<server>/<tool>.md`，案例内同路径逐文件覆盖套件默认值。只覆盖答案会保留 suite 的 `_tools.json`；fixture 文件也按同路径覆盖。支持 `expect` 输入检查、`error`、`{{input.field}}`、`{{file:fixtures/file}}`，及 `_tools.json` 工具描述和参数 schema。两组均提供相同模拟工具，从而只改变目标 Skill／扩展。pi 注册模拟工具，并通过原生工具事件记录调用；Codex 启动仅服务这些固定数据的本地 stdio MCP 进程。`error: true` 返回工具错误，允许 agent 恢复；`expect` 失败强制该次运行记 0 分，并在 pi 中阻止下一次模型调用。Agent 模拟／录制回放尚未实现。

复制目标 Skill 时会排除实际评测目录和报告目录，包括自定义 `qa/` 等路径，避免将 grader 和其他案例作为 Skill 资源提供给 agent。

每次评测有独立工作区、配置目录和会话。仅复制认证、模型提供商配置；不加载个人扩展、MCP 配置或记忆。Codex Windows 运行目录位于 `~/.cache/agent-evals`，保留已有 Windows 沙箱类型并复制所需初始化状态，不降级或关闭沙箱。`--keep-temp` 保留调试工作区，但仍删除复制的凭据。进程崩溃或强制结束宿主时，可能需要清理遗留目录。

## CI 与费用

```powershell
node bin/agent-evals.mjs run D:/projects/my-package --backend pi --model <provider/model> --judge-model <provider/model> --threshold 0.8 --json results.json
```

退出码：0 全部通过；1 不通过、输入无效或运行错误；2 费用限制导致不完整；130 取消。所有报告只保存在本地。

调用使用本机已有登录／API 配置，会消耗相应套餐或 API 额度。pi 仅在模型返回有效价格时报告美元估算；全零价格且有 token 消耗会显示未知。Codex JSON 不提供美元价格，固定显示未知。`--max-cost-usd` 只适用于有价格信息的 pi 调用；一旦价格不可用会停止后续调用，标记不完整。上限在新调用开始前检查，已经运行的并发调用可能使费用超过它。次数与超时可用于所有模型。

`--judge-backend`、`--judge-model`、`--judge-provider` 可单独指定裁判。默认裁判沿用后端的默认模型，但在 pi 上关闭 thinking；为了可比性和可预测费用，建议显式固定模型。

## 开发验证

```powershell
npm test
npm run test:pi
npm run check
node bin/agent-evals.mjs doctor
node bin/agent-evals.mjs validate examples/commit-helper
```

`npm test` 运行离线回归测试，并跳过需要 pi CLI 的 3 项测试；`npm run test:pi` 单独运行这 3 项真实进程协议测试，需要安装 pi，但使用本地固定 provider，不调用外部模型、不消耗模型额度。两类测试均不冒充真实模型质量评测。`examples/commit-helper` 演示带／不带 Skill；`examples/judge-smoke` 演示三票裁判；`examples/mock-weather` 演示固定 MCP。运行示例会真实调用模型。

执行器可用 `AGENT_EVALS_PI_BIN`、`AGENT_EVALS_CODEX_BIN` 指向可执行文件或 JS 入口；`AGENT_EVALS_TEMP_ROOT` 可指定运行目录。Windows 不经过 shell 拼接模型提示词。
