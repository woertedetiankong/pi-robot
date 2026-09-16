# pi-robot

一次安装五个 pi 插件，并在缺少 Herdr 时自动安装 Herdr 应用：Python 工具编排、行为评测、会话通信、嵌入式文档分析和学习卡片。

## 安装

需要 Node.js **22.19+**、Git，以及 pi **0.85.1+**。已验证 pi 0.85.1。

```sh
pi install https://github.com/woertedetiankong/pi-robot
```

安装会自动安装运行依赖，并通过 npm postinstall 检查 Herdr：已有可用版本则保留；没有则调用 [Herdr 官方安装器](https://herdr.dev/docs/install/)。支持 Windows、macOS、Linux 的 x64 / arm64；Linux 安装器还需要 curl、awk 和 SHA-256 校验工具。模型凭据由自己的 pi 配置管理。

安装结束后打开新终端，执行 `herdr`，再在 Herdr 窗格内执行 `pi`，即可使用分屏和多 agent 管理。只用插件时，也可以直接重启 pi。安装流程不会自动启动 Herdr 或关闭现有会话。

Windows 官方安装器会更新用户 PATH；macOS / Linux 默认安装到 `~/.local/bin`，如果安装器提示该目录不在 PATH，请按提示加入 shell 配置。程序也会检查默认安装位置，避免因当前终端尚未刷新 PATH 而重复安装。

### 安装失败与可选跳过

Herdr 下载或安装失败会明确报错；修复网络或系统依赖后，重新运行安装命令，或在本包目录执行 `npm run setup:herdr`。Herdr 安装器负责校验下载的程序；第三方二进制不存放在本仓库中。

若只需要五个插件，可在安装前设置 `PI_ROBOT_SKIP_HERDR=1`。例如 PowerShell：

```powershell
$env:PI_ROBOT_SKIP_HERDR = '1'
pi install https://github.com/woertedetiankong/pi-robot
```

如果 npm 设置了 `ignore-scripts=true`，自动安装不会执行，需要手动运行 `npm run setup:herdr`。已有 Herdr 不会随 pi-robot 更新而自动升级；升级 Herdr 使用 `herdr update`。

| 插件 | 功能 | 入口 |
| --- | --- | --- |
| pi-code-mode | Monty 沙箱 Python 编排工具 | `code` 工具、`/code-reset` |
| agent-evals | skill / 扩展行为评测 | `/eval` |
| pi-intercom | 本机 pi 会话通信 | `/intercom`、`/intercom-id` |
| pi-embedded-docs | Datasheet、PDF、原理图与页码证据 | `/docs`、`document_*` 工具 |
| learnlearn | 学习卡片、答题和追问 | `/companion` |

附带六个技能：`herdr`、`pi-teamwork`、`agent-evals`、`pi-intercom`、`datasheet-extraction`、`schematic-analysis`。

code-mode 已接入文档查询：

```python
print(embedded_document_query("document_grep", '{"query":"VDD"}'))
```

先用 `/docs add <文件路径>` 导入文档。该 Python 接口只提供当前文档范围的文本查询；图片、OCR 和导入使用直接文档工具。

## 从单独安装迁移

先通过 `pi list` 查看旧安装，用 `pi remove <原来的source>` 移除五个旧包的配置入口，再安装本包，避免同名工具和命令重复加载。移除本地包入口不会删除原始源码。

如果以前使用文档插件的组合安装器，还要从 pi settings.json 的 `extensions` 中移除旧 `embedded-docs-install/code-mode.ts` 入口。本包已有自己的组合入口。

如果 `~/.pi/agent/skills` 中已有同名 `herdr` / `pi-teamwork`，保留一份即可；Herdr 自动安装的 `herdr-agent-state.ts` 和本包扩展也应只启用一份。可用 `pi config` 选择本包加载的扩展和技能。先备份旧配置，保留自行修改过的技能。

本包安装不会自动改写或清理其他安装。

## 运行条件

附带 Herdr 的 pi 状态桥接文件和技能，Herdr 应用在安装时按需通过官方安装器获取。需在真实 Herdr 窗格内运行 pi，状态桥接才会工作；普通终端中其他插件仍可使用。未加入 Orca 扩展。

学习卡片默认开启，生成和追问会产生额外模型用量；`/companion economy` 可节省用量，`/companion off` 可关闭。它仅在交互 TUI 中运行。

PDF/OCR 在本地处理，首次 OCR 可能下载语言数据。交给 agent 的文档文本和图片会进入所选模型上下文。原理图分析需要支持图片输入的模型。行为评测实际运行 agent 时也会消耗模型用量。

## 更新与卸载

```sh
pi update https://github.com/woertedetiankong/pi-robot
pi remove https://github.com/woertedetiankong/pi-robot
```

更新后重启 pi。卸载不会自动删除 Herdr 应用、文档缓存、收藏或评测结果。

## 开发与验证

```sh
npm ci
npm run test:installer
npm test
npm run test:documents
npm pack --dry-run
```

`npm ci` 也会触发 Herdr 检测与按需安装；开发和 CI 中可设置 `PI_ROBOT_SKIP_HERDR=1` 跳过。安装器测试模拟各平台的下载和进程，不实际安装 Herdr。集成测试使用临时配置与工作目录，检查五个插件的命令、六个技能和真实 Monty 文档查询；不调用模型、不发送会话消息。

`packages/` 保存五个组件的源码快照，不使用 Git 子模块；来源与版本见 [sources.json](sources.json)。依赖由根 package.json / package-lock.json 管理。上游更新需审阅后同步对应组件，再运行集成测试。组件内的 README 保留各自用法，整合包的安装以本页为准。

## 许可

本仓库整合代码和 pi-embedded-docs 按 [MIT](LICENSE) 发布。第三方组件保留各自版权和许可，详见 [第三方说明](THIRD_PARTY_NOTICES.md)。
