# pi-embedded-docs

面向嵌入式开发的 pi 文档插件：读取 Datasheet、检索寄存器和电气参数、查看原理图、裁剪功能块，并保留页码证据。两个 skill 提供分析步骤，实际解析、OCR 和图片返回由插件工具完成。

## 安装与使用

需要 Node.js 22.19 或以上。本地验证环境为 Windows、Node.js 22.23.2、pi 0.85.1。

```powershell
cd packages/pi-embedded-docs
npm ci
node scripts/install.mjs
```

已有本地 pi-code-mode 的用户可以启用共享文档查询：

```powershell
node scripts/install.mjs --with-code-mode ../pi-code-mode
```

安装器备份 pi settings.json，增加本地 package。启用 code-mode 集成时，用一个组合入口加载原有 code-mode 并注入文档查询函数；原有源码无需修改。安装后启动新 pi 会话或执行 `/reload`。

```text
/docs add "D:/manuals/chip.pdf" --pages 1-10,35-40
请确认该型号的供电范围，区分推荐工作条件与绝对最大额定值，并引用原文。

/docs list
/docs only d-这里替换为返回的文档ID
/docs off
```

用户命令 `/docs add` 可以明确导入工作目录外的文件。模型的 `document_import` 只允许工作目录内文件。清空 scope 不会删除本地缓存；会话分支恢复对应的文档范围。

## 文档与图片能力

| 工具 | 用途 |
| --- | --- |
| `document_import` / `document_list` | 导入、查看会话文档范围和解析覆盖率 |
| `document_grep` / `document_search` | 精确字符串匹配、按词项排序检索 |
| `document_read` | 分页读取原生文本及已完成的 OCR 文本 |
| `document_view_page` | 返回实际页面图片，供模型看图 |
| `document_create_crop` / `document_view_region` | 按页面像素坐标裁剪、重新查看功能块 |
| `document_ocr` | 对整页或已有裁剪强制 OCR，结果加入检索 |
| `document_check_citations` | 检查引用是否属于当前文档范围及已保存证据 |

支持 PDF、PNG、JPEG、WebP、TXT、Markdown；单文件上限 100 MiB。PDF 默认仅导入前 30 页，显式范围每次最多 100 页。页码是从 1 开始的 PDF 物理页码。范围外搜索不到内容，不代表整份手册没有该信息。

LiteParse **2.14.4** 已作为精确版本依赖安装；无需另装全局 `lit`。package-lock.json 用于重现依赖。升级时同步修改依赖和 `src/service.ts` 的 `PARSER_ID`，运行回归检查，防止不同解析版本共用缓存。未启用新版的全部功能；本插件仍采用显式范围与按需 OCR。

原生文本使用 LiteParse；图片渲染使用 PDF.js；OCR 使用本地 Tesseract.js 7。默认语言 `eng`，中文可传 `eng+chi_sim`。首次 OCR 会下载语言模型，后续使用本地缓存；可通过 `PI_EMBEDDED_DOCS_TESSDATA` 指定已准备好的语言模型目录或服务。OCR 阶段不上传文档。Agent 的文本和图片证据会发送给所选模型提供商。

**看原理图必须使用支持图片输入的模型。** 模型只支持文本时，图片工具明确报错；OCR 可识别字词，不能确认线条连接、交叉线是否相接、器件方向。即使模型支持图片，也应确保 pi 没有启用屏蔽图片的设置。

原生文本、OCR、页面图像和裁剪使用不同的引用锚点，例如 `[d-...:p1:native]`。引用检查只确认存在性和范围，不证明模型已认真看图或推理正确。页面图像最长边限制为 2400 像素，裁剪基于该图；过密的大幅图纸可能需要用户提供更高分辨率的局部页。

## 两个 skill

- `datasheet-extraction`：确认型号/封装/版本，检索后核对条件、单位、典型值和最大值；仅在需要图形信息时看图。
- `schematic-analysis`：先看全图，再看完整功能块，依据实际连线分析；区分观察事实、推断和待确认信息，不凭 OCR 补造网络连接。

普通代码问题不需要启动文档工作流。不包含 ESP-IDF、烧录或硬件操作。

## pi-code-mode

组合入口提供一个返回 JSON 字符串的只读函数，与直接文档工具共享当前会话范围：

```python
print(embedded_document_query("document_grep", '{"query":"VDD"}'))
```

只开放 list、grep、search、read、check_citations。导入、OCR、图片查看仍使用直接 pi 工具，图片不会通过文本沙箱传递。未启用该组合入口时，直接文档工具与两个 skill 仍可使用。

## 缓存与恢复

缓存位于 `~/.pi/agent/embedded-docs/<工作目录哈希>/`，包含原文件快照、文本、OCR、页面和裁剪。内容、路径、导入页范围和解析器版本决定文档 ID。原路径内容发生变化时，旧 ID 拒绝继续返回证据，需要重新导入；原文件删除后仍可读取明确保存的快照。

缓存没有自动清理或加密。scope 是插件工具的访问范围，不是对拥有文件系统权限的同机进程的安全沙箱。

安装备份与组合入口位于 `~/.pi/agent/embedded-docs-install/`。如需撤销，在 pi settings.json 删除本 package 和该目录下的组合入口，并将原 code-mode package 项恢复为 install.json 中的 `codeEntry`。备份可以帮助核对；如果安装后还有其他设置变更，请勿整份覆盖。自定义 pi 配置目录可通过 `PI_CODING_AGENT_DIR` 指定。

## 验证

```powershell
npm run typecheck
npm test
npm run smoke
npx tsx scripts/pi-load-smoke.ts
npx tsx scripts/integration-smoke.ts ../pi-code-mode
```

`smoke` 使用真实混合 PDF 和本地 OCR，首次运行可能下载语言文件。`integration-smoke` 在临时配置中验证真实 Monty 沙箱的文档查询，不修改用户 pi 配置。

行为评测位于 `evals/`，使用 agent-evals 的 `validate` 和 `run`；后者消耗已配置模型的额度。命令与结果见 [验证记录](docs/validation.md)。合成小样本用于检查功能，不作为优于通用 coding agent 的证明。

## 来源与许可

设计参考用户已有平台 `embedded-ai` 的文档范围、缓存和证据分析方法；该平台未修改。本组件于 2026-09-16 经所有者授权在 pi-robot 中按 MIT 发布；该授权仅适用于本组件，不改变参考平台的许可。第三方依赖保留其各自许可；无第三方手册分发。
