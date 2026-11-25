---
feature: remote-access-assessment
status: designed
updated: 2026-11-24
branch: none
commits: 评估类文档，无交付提交
---

# 远程接入体系评估：上游 remote-connection 是否替换 pocket

English | [中文](remote-access-assessment.zh.md)

## Report

待实施后回填（本 spec 为评估/决策记录，结论：**不替换**，见 S2.2）。

## [S1] Problem

上游 0.2.3-alpha.2 带来一套远程接入栈：`packages/client/remote-connection`（设置页 "Remote connection"：QR 登录、私有登录链接、owner 审批的浏览器配对）、`packages/host/authentication-token`（启动令牌 → 浏览器 Cookie + `/connect` API 交换）、`packages/host/authentication-desktop`（Electron 主进程 ↔ Host 私有凭证）。fork 侧已有 pocket 的远程体系（hub 38081 端口、二维码含令牌、令牌按 hub 进程轮换、LAN 绑定、手机端适配/推送/PWA/Tailscale 指引）。需要回答：是否用上游这套替换 pocket 的远程访问。

## [S2] Design

### S2.1 能力对照

| 维度 | 上游 remote-connection + auth-desktop/token | pocket 远程体系 |
| --- | --- | --- |
| 解决的问题 | 把**另一台浏览器**接入同一 web 应用（Cookie 级登录） | 把**手机**接入 agent hub（移动 web 适配、会话操作、推送/Bark、PWA、Tailscale 指引） |
| 认证形态 | 一次性 QR 凭证（URL fragment 256-bit）→ 同源 POST 兑换 30 天 Cookie；可复用令牌链接；匿名配对码 + owner 审批 | hub 令牌二维码、令牌按 hub 进程轮换、LAN/公网绑定（38081）、防火墙安装器钩子 |
| 传输面 | webserver 路由（普通 web 应用通道） | pocket hub 专属通道 + 九通道 IM bot |
| 桌面侧 | `authentication-desktop` 依赖 Electron 主进程——**fork 桌面是 Tauri，不适用**（A1 域） | Tauri 壳自有通道 |
| 接入状态（master） | `authentication-token`（web-app patch :316）与 `remote-connection`（:416）已随 resync 接入 web 组合；桌面窗口按上游设计隐藏该设置区块 | pocket 为 patch 插件，桌面/浏览器 profile 均可启用 |

### S2.2 结论：不替换

1. **问题域不同**：remote-connection 解决"第二台浏览器如何登录 web 应用"；pocket 解决"手机如何使用 agent（会话、通知、PWA、IM bot）"。后者承载的推送、移动适配、bot 等能力 remote-connection 完全没有。
2. **authentication-desktop 对 fork 无意义**：它是 Electron 主进程↔Host 的私有凭证通道；fork 桌面是 Tauri（A1），不走这条链。
3. **authentication-token 保留**：它是 web 应用自身的启动认证底座，已接入且与 pocket 无重叠冲突。
4. **pocket 的令牌轮换/LAN 绑定是实测踩坑后的形态**（401 复发、防火墙 Block、安装器钩子均有根因记录），上游配对模型不能直接替代这些运维面。

### S2.3 可借鉴项（列为后续可选改进，不在本 spec 实施）

- pocket 手机端登录可参考 remote-connection 的**配对请求模型**（显示码 + owner 审批 + 一次性凭证兑换），把"二维码直接含令牌"升级为可撤销、可审计的配对流。
- 凭证保管可参考其形态：Host 只留凭证摘要不留明文、Cookie `HttpOnly + SameSite=Strict`、绑定协议+host。
- 文案区分：设置页会出现两个"扫码接入"入口（Remote connection 与 pocket 手机连接），需在双方 hint 里写清各自用途，避免用户混用。

第一条的落地方案已在 [pocket-device-pairing](pocket-device-pairing.md) 定稿（设计、任务与验收），本 spec 仍不实施。

### S2.4 观察项

若上游 remote-connection 后续长出"会话级手机访问/推送"能力（而不只是浏览器登录配对），届时重新评估与 pocket 的收敛；在此之前不做代码替换。

## [S3] Scope

- In scope：本评估与结论记录（本文件）。
- Out of scope：任何代码替换、移除或接线改动；pocket 功能变更。

## Tasks

- [ ] T1: 本评估定稿并归档结论 (depends: none)

## [S4] Acceptance

- [ ] 文档给出逐维度对照（S2.1）与明确结论（S2.2：不替换），并列出可借鉴项与观察项。
- [ ] 不产生任何代码/组合变更；master 上 `authentication-token`/`remote-connection` 维持上游接入现状。
