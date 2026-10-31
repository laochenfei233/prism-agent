# @prism/prism-local-models

[English](README.md) | 中文

Prism 的本地能力模型——OCR、翻译、RAG 向量——安装在 Prism 数据目录之下，并经设置模型页自带的 `settings.models.footer` 扩展座在模型页内管理，模型页本身零改动。。

## 模型家族

| 家族 | 类别 | 变体 | 运行时 |
|---|---|---|---|
| RapidOCR（默认 OCR 引擎） | OCR | `standard`（PP-OCRv4 ONNX，模型随 npm 包附带） | `@gutenye/ocr-node` 供给到 `<modelsRoot>/runtimes/rapidocr` |
| PaddleOCR | OCR | `cpu`、`cuda` | 由 `pythonCommand` 供给的 Python venv；仅标准库的 HTTP sidecar 经回环地址与之通信 |
| HY-MT1.5（混元 Hunyuan-MT1.5-1.8B 官方 GGUF 导出） | 翻译 | `q4_k_m`（默认）、`q8_0` 及 `cuda` 孪生变体 | `node-llama-cpp` 供给到 `<modelsRoot>/runtimes/hy-mt-1.5` |
| BGE（BAAI 向量） | 向量 | `bge-small-zh-v1.5`（默认）、其 int8 构建、`bge-m3` int8 及 `cuda` 孪生变体 | `@huggingface/transformers` + `onnxruntime-node` 供给到 `<modelsRoot>/runtimes/bge` |

下载 URL 钉在经过实测的国内可达主机上（`hf-mirror.com`）；`mirrorBaseUrl` 整体替换每个 URL 的源站。每个下载文件都带钉死的字节数与 sha256；下载经 `.part` 临时文件流式写入，摘要匹配后才重命名。手动放置的文件由周期扫描检出并校验一次。

## 存储布局

`<modelsRoot>` 默认 `<home>/models`（配置项 `modelsRoot`）。布局：`<modelsRoot>/<familyId>/<variantId>/…`，根目录的 `registry.json` 保存逐家族生命周期状态与缓存的完整性结果。`runtimes/<familyId>` 存放供给的运行时，各自带有记录包清单的 `.provisioned` 标记。

## 能力契约

host 半经声明合并认领 `ctx.prismLocalModels`（结构化类型，见 `src/service.ts`），提供：

- `embed(texts): Promise<number[][]>` —— BGE，均值池化，L2 归一化。
- `ocr({ bytes, mime }): Promise<string>` —— RapidOCR 就绪时优先，否则 PaddleOCR sidecar。
- `translate(text, { to }): Promise<string>` —— HY-MT1.5，采用混元 MT 指令模板。
- `install/cancel/remove/probe/catalog/status` 驱动模型页卡片。

模型或运行时未就绪时，每个调用都以类型化的 `LocalModelsError`（`code` + 可操作信息）失败。功能方直接采用这些方法；把 OCR 或向量接进附件、记忆等管线留给它们各自的属主，本插件不做。

## 配置（cordis.patch.yml 行 `local-models`）

- `modelsRoot?: string` —— 模型目录；默认 `<home>/models`。
- `mirrorBaseUrl?: string` —— 整体替换每个文件 URL 的源站。
- `pythonCommand?: string` —— 供给 PaddleOCR venv 用的解释器；默认 `python`。
- `catalogOverride?: string` —— 合并进内置目录的 JSON 文档路径；形态未知在加载时失败。

## HTTP API

经 `connection.fetch.register` 注册的认证路由 `/api/local-models/*`：`GET /catalog`、`GET /status`、`POST /install|cancel|remove|probe`（带 `{modelId[, variantId]}`）。类型化失败以 `{code, message}` 与映射的 HTTP 状态返回。

## 限制

- 经过验证的是 CPU 路径。目录中存在 `cuda` 变体供变体选择，其 probe 负责验证执行提供器；在没有可用提供器的机器上 probe 会大声失败——绝不静默回退 CPU。
- PaddleOCR 的 venv 首次使用时自行下载模型；首次 probe 可能需要数分钟。
- `node-llama-cpp` 在供给阶段下载预编译二进制；CUDA 构建在有 GPU 的机器上尽力支持。
- HY-MT1.5 是内部翻译能力，永远不会成为可选聊天模型。

## 开发

```sh
pnpm exec tsc -p tsconfig.json --noEmit
../../node_modules/.bin/tsdown --config tsdown.config.ts
node ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts
```

桌面运行时在打包时经 `plugins/` 拷贝收编本插件；完整设计与验证记录见 `docs/compose/spec/prism-local-models.md`。
