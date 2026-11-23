---
feature: prism-autonomy
status: designed
updated: 2026-11-23
branch: feat/prism-autonomy
commits: 26b7c472a5..HEAD # 交付时填写
---

# 自主审批预设

[English](prism-autonomy.md) | 中文

## Report

## [S1] 问题

在默认的 `workspace-write` 预设下，每一个会触发审批的动作都会打断用户：guardrails 栏杆（重复调用、单轮写文件预算、依赖清单写入）和沙箱升级全部落到审批卡片上。唯一出厂可用的无人值守方式是 `danger-full-access`，但它同时去掉了沙箱约束、也不再有任何询问。缺少一个中间档：既保留沙箱和红线，又能自动应答常规审批。

## [S2] 设计

### S2.1 autonomous-guarded 预设

base bundle 的 permission-presets 预设表新增一个预设：`autonomous-guarded`，`workspace-write` + `ask`。在其下，所有审批 ask 都自动应答，除非命中可配置的"仍需人工"清单（默认：沙箱升级）。自主模式依赖 `ask` 策略——在 `never` 下审批服务会在任何应答器运行之前直接拒绝。

### S2.2 插件与预设映射

新插件 `@prism/prism-autonomy`（`plugins/prism-autonomy`），像其他 prism 插件一样通过 bundle patch 行接入。其配置：

```ts
preset: string // 默认 'autonomous-guarded'——触发自主模式的预设
requireHuman: Array<{ tool?: string; reasonPrefix?: string }> // 默认 [{ reasonPrefix: 'escalate sandbox to' }]
```

会话当前预设读取自一个 session projection `autonomy`，它折叠持久化的 `permission/preset` 事件，因此在重载与重启后仍然成立（可重放）。其余任何预设都意味着 off。配置错误在加载时响亮失败：`preset` 必须存在于 permission-presets 目录中。

### S2.3 审批应答器

插件在远程客户端桥接之前注册一个应答器（在 `approval/request` waterfall 上 prepend）：

- 会话当前预设不是 `preset` → 委托（`next()`），行为不变。
- 请求命中 require-human 匹配器（按 `toolName` 和/或人类可读的 `reason` 前缀）→ 委托。
- 否则 → `allowed-once`。

deny 栏杆不受影响（它们根本不产生 ask）。审批审计对（`approval/asked` + `approval/decided`）照常记录每一次自动应答；由于远程桥接监听器位于下游，被自动应答的请求不会在客户端弹出审批卡片。

### S2.4 实时变更的模型通知

当实时会话的预设切入或切出自主预设时，插件注入一条用户消息（source `prism-autonomy`），告知模型审批现已自动放行（守卫清单除外）——或已恢复人工。模型可见 ⟺ 已记录：该通知是一条落入日志的用户消息。重放不会重复注入。

### S2.5 边界

- ACP 托管的会话不受影响，除非有人显式切到自主预设（默认 off）。
- 自动应答按请求生效；审计对里的 `allowed-once` 与人工允许完全同形。v1 不新增独立的 autonomy 事件类型。
- v1 无客户端 UI：切换走现有的 `/permission` 命令和设置页的权限选择器。

### S2.6 测试

- 插件单元测试：状态派生（off/guarded）、应答器阶梯、prepend 顺序、require-human 匹配器、响亮失败的预设校验、实时变更通知、重放安全。
- 一份覆盖切换通知的 recorded-session 快照（模型可见变更）。

## [S3] 范围

- 范围内：插件包（源码、测试、README 双语、bundle patch 行）、base bundle patch 的 `autonomous-guarded` 预设行、切换通知快照。
- 范围外：客户端 UI、permission-presets 核心改动、新会话事件类型、子代理/委托传播、额外档位（edit/yolo）。

## Tasks

- [ ] T1: 插件骨架——package、tsconfig、config schema、session projection、响亮失败校验 (depends: none)
- [ ] T2: 审批应答器 (depends: T1)
- [ ] T3: 实时变更的模型通知 (depends: T1)
- [ ] T4: base bundle patch 的 `autonomous-guarded` 预设行 + 插件的 bundle patch 行 (depends: T1)
- [ ] T5: 单元测试 + recorded-session 快照 (depends: T2, T3)
- [ ] T6: README 双语 + 规格文档双语定稿 (depends: T5)

## [S4] 验收

- [ ] `autonomous-guarded` 会话把 guardrails ask（写预算、重复调用、依赖清单）自动落定为 `allowed-once`，且审批卡片不到达客户端。
- [ ] 沙箱升级 ask 仍交给人工。
- [ ] 默认会话（其他任何预设）行为与现状完全一致。
- [ ] deny 栏杆（如 `rm -rf` 命令守卫）仍然拒绝。
- [ ] 切入或切出自主预设恰好注入一条模型通知，且有快照覆盖。
