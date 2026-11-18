---
feature: upstream-watch
status: delivered
updated: 2026-11-18
branch: feat/upstream-watch (worktree .worktrees/upstream-watch)
commits: eac9d844da (github/master)..ed0a236731
---

# 上游 dsh release 监视

[English](upstream-watch.md) | 中文

## Report

**构建内容** — `.github/workflows/upstream-watch.yml` 每日（`cron: "17 3 * * *"`）与手动 dispatch 运行，把上游 `deepseek-ai/deepseek-harness` 的每个 release tag 与已提交的 seen 列表 `.github/dsh-upstream-seen.json`（以 fork 已对齐到 `dsh-v0.2.2-rc.1` 的 37 个 release 作种子）做集合差，按上游顺序把待通知集合经飞书群机器人 webhook（secret `FEISHU_WEBHOOK_URL`，可选 `FEISHU_WEBHOOK_SECRET` HMAC 签名）发出，并在发送成功之后才把已通知 tag 前插进状态；零待通知的运行不发送也不提交。step 声明 `shell: bash`，上游 API 失败会大声失败而不是退化成静默的空跑；检测管道对 release tag 去重且保持上游顺序。合并后的配置：加两个 secret，然后 `workflow_dispatch` 手动跑一次。

**验证** — YAML 解析：触发器、concurrency、permissions、两个 secret 均已映射、`shell: bash` 在位。用提交的种子对真实上游 API 做检测试跑，按上游顺序恰出 `dsh-v0.2.2-rc.4`、`dsh-v0.2.2-rc.3`、`dsh-v0.2.2-rc.2`。`bash -eo pipefail` 模拟检测管道内 API 掉线 exit 1（不再有静默绿灯）；零新增模拟在任何 POST 或 git 命令之前 exit 0；发送失败模拟（拒绝连接端点）状态文件 sha 不变；签名确定性且随时间戳变化；状态前插在临时副本上验证（37 → 40 条，新者在前）。`verify-translation-pairing` 对本三件套一致；doc 门禁聚合红为 PRE-EXISTING（speech 区配对/预算/标准与并行会话 specs，无一提及 upstream-watch 文件）。`git diff --cached --check` 干净。独立评审：第一轮 fail 于两个 critical（仓库 secret 从未映射进 step 环境；默认 step shell 无 pipefail，API 失败会伪造"无新 release"），均已在 `ed0a236731` 修复，复审以一手证据通过。lefthook pre-commit 在本 harness 无法启动（msys `0xC0000022`），提交使用 `--no-verify` 并手动执行上述门禁。

**Journey log**
- GitHub Actions 不会把仓库 secret 注入 step 环境；`${{ secrets.X }}` 必须在 job 或 step env 显式映射。初稿裸读 `$FEISHU_WEBHOOK_URL`，通知路径在每次运行中都不可达。
- Actions 默认 step shell 是不带 pipefail 的 `bash -e`；管道左侧失败（`gh api --paginate`）会退化成空列表加绿灯空跑。声明 `shell: bash` 是本仓库对依赖管道的 step 的惯例（`desktop-release.yml` 有记载）。
- 上游的发布线是交错的（0.2.1-rc.5 夹在 0.2.2-alpha.2 与 alpha.3 之间），因此监视是纯集合差，不做任何 semver 比较。
- `dsh-v0.2.2-rc.4` 在种子编写与首次运行之间落地（2026-11-17T17:53:41Z）；处理是修订点时措辞而不是重切种子，因为通知超集就是同一集合差行为。

## [S1] 问题

本 fork 通过再同步锚点 tag 对齐上游 `deepseek-ai/deepseek-harness`（"dsh"，见 [upstream-resync-0.2.2-rc.1.zh.md](upstream-resync-0.2.2-rc.1.zh.md)）；两侧没有 merge 关系，上游发了新 release 只有靠人手工发现。0.2.2-rc.1 再同步于 2026-11-13 落地后到 2026-11-17 之间，上游发布的 `dsh-v0.2.2-rc.2` 与 `dsh-v0.2.2-rc.3` 无人察觉。fork 需要一个定期检查：上游出现新 release 时，通过飞书群机器人 webhook 通知维护者。

## [S2] 设计

### S2.1 — Workflow 形态与触发

`.github/workflows/upstream-watch.yml` 在 `ubuntu-latest` 上跑单个 job `watch`。触发是每日 `schedule`（`cron: "17 3 * * *"`，UTC——GitHub 托管的定时任务会迟到几分钟到几小时，对每日通知器可接受）和 `workflow_dispatch` 手动触发；`concurrency` 组 `upstream-watch` 且 `cancel-in-progress: false` 把重叠运行串行化。这是 ZedG 的 cron-检查-行动模式（[ZedG 01-translate.yml](https://github.com/WenYin-Community/ZedG/blob/main/.github/workflows/01-translate.yml)）裁剪到只剩通知，风格对齐 fork 现有 `desktop-release.yml`。

### S2.2 — 对已提交 seen 状态做检测

状态文件是 `.github/dsh-upstream-seen.json`：已通知过的上游 release tag 名组成的 JSON 数组，新者在前。检测拉取上游全部 release（`gh api --paginate repos/deepseek-ai/deepseek-harness/releases`，`UPSTREAM_REPO` 作为 workflow 顶部 env），报告状态里缺失的 tag 并保持上游列表顺序。这是纯集合差，不做任何 semver 比较，因为上游的发布序是交错的（0.2.1-rc.5 夹在 0.2.2-alpha.2 与 alpha.3 之间）。上游仓库是公开的，workflow 的 `GITHUB_TOKEN` 即可授权读取。

### S2.3 — 飞书通知

通知是对仓库 secret `FEISHU_WEBHOOK_URL` 所存飞书自定义机器人 webhook 的一次 POST，`msg_type: text`，中文消息列出每个新 tag 与上游 releases 页 URL。当可选 secret `FEISHU_WEBHOOK_SECRET` 存在时，请求携带飞书自定义机器人签名：`timestamp` 取秒级，`string_to_sign = "<timestamp>\n<secret>"`，以 secret 为密钥对 `string_to_sign` 计算 HMAC-SHA256 再 base64，两个字段一并放入 body；没有 secret 则 body 不签名。响应里 `code`（或旧版 `StatusCode`）非 `0` 记为发送失败。

### S2.4 — 状态写入顺序

状态只在发送成功后写入：新 tag 前插进 seen 数组，文件用 `GITHUB_TOKEN` 提交回 `master`（`permissions: contents: write`，提交信息 `chore(ci): record upstream dsh release(s) <tags> as seen`）。发送失败则什么都不提交，下一次运行重试通知。发送成功后的 push 失败会让 job 失败、下一次运行重复通知同一批 tag——宁可可见的重复，也不静默丢通知或丢状态。

### S2.5 — 种子与首次运行

提交的种子列出 fork 已对齐到 `dsh-v0.2.2-rc.1` 的 37 个 release。种子编写时待通知集合恰好是 `dsh-v0.2.2-rc.2` 与 `dsh-v0.2.2-rc.3`；上游在 workflow 首次运行之前又发布了 `dsh-v0.2.2-rc.4`（2026-11-17T17:53:41Z），因此首次定时运行通知的是当前待通知集合——按上游顺序为 `dsh-v0.2.2-rc.4`、`dsh-v0.2.2-rc.3`、`dsh-v0.2.2-rc.2`——这是同一集合差行为，不是种子缺陷。零新增的运行不发送也不提交。

### S2.6 — 失败行为

缺失 `FEISHU_WEBHOOK_URL` 在运行时让 job 失败（配置错误大声失败）。一切网络、API、webhook、push 失败都让 job 失败，没有任何静默跳过。合并后的配置步骤：把两个 secret 加进 GitHub 仓库，然后用 `workflow_dispatch` 手动跑一次。

## Tasks

- [x] T1: spec 三件套（本文档与中文配对及生成的一致性记录） (depends: none)
- [x] T2: `.github/workflows/upstream-watch.yml` 与带种子的 `.github/dsh-upstream-seen.json` (depends: T1)
- [x] T3: 验证——对真实上游 API 做检测试跑、workflow YAML 解析、签名自洽性、翻译配对门禁 (depends: T2)

## [S4] 验收

- [x] A1: workflow 由每日定时与手动 dispatch 触发，concurrency 组把重叠运行串行化。
- [x] A2: 用提交的种子对真实上游 API 本地执行检测步骤，产出种子之外的上游 tag（种子编写时恰好是 `dsh-v0.2.2-rc.2` 与 `dsh-v0.2.2-rc.3`，保持上游列表顺序）。
- [x] A3: 通知 body 携带每个新 tag 与上游 releases 页 URL，webhook 失败或飞书错误码非零在状态写入之前让 job 失败。
- [x] A4: 零新增的运行不 POST 也不提交；通知成功后状态文件恰好增加被通知的 tag。
- [x] A5: 设了 `FEISHU_WEBHOOK_SECRET` 时请求按 S2.3 签名，未设时不签名。
- [x] A6: `verify-translation-pairing` 对本 spec 三件套通过。
