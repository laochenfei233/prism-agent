---
kind: upgrade-guide
description: "超过 `grantTimeoutMs` 的 Windows 沙箱授权现在以 SANDBOX_UNAVAILABLE 让命令失败，而不是卡住所有对话。"
---

# Windows 沙箱准备不再冻结 Host

English | [中文](guide.md)

## 变更

在 Windows 上，为 `workspace-write` 准备工作区的 ACL 写授权（对整个目录树做一次 `SetNamedSecurityInfoW` 继承传播）此前运行在 Host 主线程上。大工作区（带 worktree 或装满 `node_modules` 的 monorepo）的首次授权会阻塞事件循环，传播持续多久，该 Host 上的所有对话就僵住多久——工具调用、历史加载和 Web UI 全部排在后面等待。

授权现在运行在短生命周期的辅助进程（`@deepseek-ai/dsh-sandbox-windows-acl/grant-runner`）中，Host 最多等待 `grantTimeoutMs`（`sandbox-local` 的新配置项，默认 120000）。等待期间 Host 始终可响应。等待超时后该命令以 `SANDBOX_UNAVAILABLE` 失败，而辅助进程继续在后台完成；同一会话的下一条命令会复用它正在落地的 ACL，因为已存在的精确 ACE 会跳过传播。

## 迁移

1. 无需操作：默认值即修复冻结。Windows 上受沙箱约束的命令行为不变。
2. 仅当你最大工作区的单次首次授权确实需要更久、且宁愿等待也不想看到命令失败一次时，才调大 `sandbox-local` 配置中的 `grantTimeoutMs`（例如 `120000` → `600000`）。
3. 若希望快速失败、让后台授权自行完成，可调小该值：下一条命令会复用已完成的授权。
4. 确认修复：在大工作区中运行受约束命令，并在准备期间加载另一个对话的历史——必须能正常响应。若准备超过等待上限，工具结果会指明工作区并说明准备仍在进行；等其落地后重跑该命令。
