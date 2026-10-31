---
feature: prism-local-models
status: in-progress
updated: 2026-10-31
branch: feat/prism-local-models
commits: f879732059..(filled at delivery)
---

# Prism 本地模型

[English](prism-local-models.md) | 中文

## Report

## [S1] 问题

设置里的模型页只管理远端 LLM provider。Prism 自身需要的能力模型——图片 OCR、机器翻译、RAG 向量化——没有安身之处：没有安装位置、没有生命周期管理、也没有供后续功能调用的能力入口。这些模型应当装在 Prism 的数据目录里，在本来就管理模型的地方（模型页）完成安装与管理，并以类型化能力（`embed`、`ocr`、`translate`）供 Prism 功能调用。

## [S2] 设计

### S2.1 形态：树外双面插件；模型页零改动

`plugins/prism-local-models`（`@prism/prism-local-models`）沿用 `plugins/prism-pocket` 的形态：node 半（`lib/index.js`，ESM）经 Loader bundle 行加载，浏览器半（`lib/client.js`，CJS 闭包，经 `window.__ModuleLoader__` 注册）由 `dsh.client: { platform: 'web' }` 与 `exports['./client']` 声明。模型页集成仅使用该页声明的扩展座 `settings.models.footer`（`packages/client/ui-settings-models/src/client/slot-contract.ts`）；`ModelsSection`、设置外壳以及其余所有包保持逐字节不变，上游对模型页的更新可继续干净地套用。

### S2.2 目录清单与变体

内置目录模块定义四个模型家族，各带可安装变体：

- `rapidocr` —— 默认 OCR 引擎：PP-OCRv4 ONNX det/cls/rec 模型加 PPOCR 字典；CPU；数十 MB。
- `paddleocr` —— 备选 OCR 引擎，供给到 Python 环境中运行；变体 `cpu`（paddlepaddle）与 `cuda`（paddlepaddle-gpu）。
- `hy-mt-1.5` —— 腾讯混元 Hunyuan-MT1.5-1.8B 翻译模型，GGUF 量化经 llama.cpp 运行；变体 `Q4_K_M`（默认）与 `Q8_0`，设备 `cpu` 或 `cuda`。
- `bge` —— BAAI 面向 RAG 的向量模型；变体 `bge-small-zh-v1.5`（默认）与 `bge-m3`；ONNX，CPU；目录中存在 `cuda` 变体，其 probe 负责验证执行提供器的可用性（见 S2.5）。

每个变体携带：`id`、`displayName`、`device`（`cpu` | `cuda`）、总大小、`files`（`{ path, sha256, url }`）以及运行时要求。URL 以 ModelScope 优先，镜像基址可经 Config 配置。确切的上游文件（仓库、revision、sha256）在 T2 经实际可用性检查后钉死；腾讯未发布官方 GGUF 时，Hunyuan-MT1.5 的 GGUF 取自官方 ModelScope 权重的社区量化。Config 的 `catalogOverride` 路径将用户 JSON 合并进内置目录；未知字段在加载时失败。

### S2.3 存储布局与注册表

模型存放在 Config `modelsRoot`（默认 `dshHomePath('models')`）之下的 `<modelsRoot>/<modelId>/<variantId>/<文件…>`。`modelsRoot` 处的 `registry.json` 记录每个模型的状态：`status`（`idle | downloading | provisioning | ready | error`）、所选变体、逐文件完整性（sha256 结果连同文件大小与 mtime 一起缓存）、进度与错误。注册表在加载时和每次目录读取时扫描 `modelsRoot`：手动放置通过"存在 + 文件大小"检出，随后做一次 sha256 校验并缓存。下载写入 `.part` 文件，校验通过后原子重命名；校验失败删除临时文件并报告类型化错误。

### S2.4 node 半服务与能力契约

`PrismLocalModelsService` 经声明合并认领 `ctx.prismLocalModels`，负责：`listStatus()`、`install(modelId, variantId)`（下载加供给，带进度与取消）、`cancel(modelId)`、`remove(modelId)`、`probe(modelId)`（运行一次冒烟推理并返回实测结果），以及能力方法 `embed(texts: string[]): Promise<number[][]>`、`ocr(image: { bytes, mime }): Promise<OcrResult>`、`translate(text: string, opts: { to: string; from?: string }): Promise<string>`。模型或运行时未就绪时，能力方法抛出带可操作信息的类型化错误。每个模型同时只有一个活动操作；不同模型可并发。OCR：RapidOCR 为默认引擎；PaddleOCR 为可选项。

### S2.5 运行时供给

原生运行时不是插件的包依赖（树外插件发布时不含 `node_modules`），而是在安装时供给到 `<modelsRoot>/runtimes/<name>`，并经 `createRequire` 从供给路径导入。基于 npm 的运行时（BGE 用 `@huggingface/transformers`，RapidOCR 用 `@gutenye/ocr-node`——维护中的 PaddleOCR-ONNX 实现，基于 onnxruntime-node；若依赖审计不通过，具名后备是手写 det/cls/rec 管线）经检测到的包管理器安装；PaddleOCR 的 Python 环境是用 Config `pythonCommand` 经 pip 供给的 venv。HY-MT 用的 `node-llama-cpp` 下载其预编译二进制（CPU 已验证；CUDA 构建在有 GPU 的机器上尽力验证）。在没有可用执行提供器的机器上请求 `cuda` 变体会在 probe 时失败并给出可操作信息——绝不静默回退 CPU。本期经过验证的是 CPU 路径。

### S2.6 推理接线

- BGE：transformers.js 向量管线（含分词器），均值池化，L2 归一化；CPU；`probe` 对固定字符串做向量并返回维度。
- RapidOCR：对已装 ONNX 模型执行 det → 可选 cls → rec；`probe` 识别随插件附带的样例图并返回文本。
- PaddleOCR：插件把仅依赖标准库的 HTTP sidecar 脚本写入运行时目录，用供给的 venv python 启动，POST 图片做 OCR；带健康检查，随卸载终止；Python 不可用时该行报告缺 Python 状态。
- HY-MT1.5：进程内 llama.cpp 上下文，采用混元 MT 提示词模板；`probe` 翻译一句固定的中→英文本。它仅是内部能力——不注册 `ctx.llm` 适配器，永远不会成为可选聊天模型。

### S2.7 HTTP API

经 `connection.fetch.register` 在 `/api/prism-local-models` 下注册 exact Fetch 路由（prism-pocket / prism-meeting 模式，由共享 `/api` 载体验证身份）：`GET /catalog`（模型、变体、状态、完整性、路径）、`GET /status`（进度快照）、`POST /install` `{modelId, variantId}`、`POST /cancel` `{modelId}`、`POST /remove` `{modelId}`、`POST /probe` `{modelId}`。浏览器半在自己的操作活动期间以 1 秒轮询 `GET /status`；不提议新的可转发事件。

### S2.8 浏览器半：模型页卡片

客户端半注入 `['slots', 'locale']`，注册一个 `settings.models.footer` list 项，渲染一张"本地模型 / Local models"卡片：头部显示模型根路径，每个家族一行，展示名称、类别徽标（OCR / 翻译 / 向量）、由目录供给的变体选择器、大小、状态或下载进度，以及安装 / 取消 / 删除 / 检测按钮及其结果；一条 OCR 说明写明 RapidOCR 为默认引擎、PaddleOCR 需要 Python 环境。全部文案经 `ctx.locale` 走合并的 zh/en 字典并合并 `LocaleNamespaceMap` 条目；样式复用应用主题令牌。

## [S3] 范围

- 纳入：双面插件（骨架、patch 行、tsdown 双面构建）、目录与变体模型、注册表与手动放置扫描、带完整性校验的下载引擎、运行时供给、四个模型的集成与 probe、HTTP API、模型页 footer 卡片、zh/en 文案、插件 README（en/zh）、单元测试、双语 spec 对。
- 不纳入：对 `packages/` 或 `apps/` 的任何改动；把 HY-MT 注册为聊天 provider；OCR 或向量能力自动接入附件/fs/记忆管线（消费方后续采用 `ctx.prismLocalModels` 契约）；断点续传；量化工具；除本 Windows 机器外的平台只尽力支持不作门禁；GPU 执行的验证以本机能力为限，其余环境 probe fail-loud。

## 任务

- [ ] T1: 插件骨架——package.json（`@prism/prism-local-models`、`dsh.bundle.patch`、`dsh.client`、`./client` 导出）、cordis.patch.yml 行、tsdown 双面构建、tsconfig、vitest（covers: S2.1）
- [ ] T2: 目录模块（四个家族、变体、经实际检查钉死 URL 与 sha256 的上游文件）、Config schema（`modelsRoot`、`mirrorBaseUrl`、`pythonCommand`、`catalogOverride`）、带扫描/校验/手动放置的注册表存储（covers: S2.2, S2.3）
- [ ] T3: 下载引擎（进度、取消、sha256、原子重命名）与经 `connection.fetch.register` 的六个 API 路由（covers: S2.4, S2.7）
- [ ] T4: 运行时供给 + BGE 向量（CPU）；cuda 变体 probe 以可操作信息 fail-loud（covers: S2.5, S2.6）
- [ ] T5: RapidOCR det/cls/rec 推理与 probe（covers: S2.6）
- [ ] T6: PaddleOCR sidecar 脚本、venv 供给、Python 检测、卸载终止（covers: S2.6）
- [ ] T7: HY-MT1.5 GGUF 翻译，经 node-llama-cpp 采用混元 MT 提示词（covers: S2.6）
- [ ] T8: 浏览器半 footer 卡片、变体选择器、状态轮询、zh/en 字典（covers: S2.8）
- [ ] T9: 单元测试——目录校验、注册表状态机与手动放置、下载校验、路由处理器、供给命令规划、纯 UI 逻辑、locale 键位配对（covers: S2.2, S2.3, S2.5, S2.7, S2.8）
- [ ] T10: README en/zh、spec 对 + pairing 记录、验证——双面构建、typecheck、聚焦测试、带插件启动 web profile、模型页卡片截图（covers: S4）

## [S4] 验收

- `git diff master..HEAD -- packages/ apps/` 为空；模型页经 `settings.models.footer` 出现本地模型卡片，zh/en 文案正确。
- 安装 BGE `bge-small-zh-v1.5` 下载到 `<modelsRoot>`、通过 sha256、显示进度，`probe` 返回 512 维向量；本机上 `cuda` 变体 probe 以可操作信息失败。
- RapidOCR `probe` 从样例图提取出预期文本；它以默认 OCR 引擎呈现。
- 未配置解释器时 PaddleOCR 报缺 Python 状态；配置后 sidecar 提供 OCR 并随卸载终止。
- HY-MT1.5 `probe` 经安装的 GGUF 翻译固定的中→英句子。
- `cancel` 停止下载并清除临时文件；`remove` 删除变体目录；手动放置的完整文件在下次扫描时被检出并校验。
- 单元测试通过；typecheck 与双面构建通过；spec 对通过 `verify-translation-pairing`；README 具备 en 与 zh。
