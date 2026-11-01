---
description: "通过作用域交互路径响应 Host 权限请求的浏览器批准界面。"
kind: "package-reference"
---
# @deepseek-ai/dsh-client-ui-approval

[English](README.md) | 中文

## 概述

基于 Agent-scoped Remote Event waterfall 的浏览器审批界面。插件通过 `ctx.uiSession` 发布每个待处理请求、接管 Conversation composer、按需渲染关联的 Tool 详情，并将用户决定返回给等待中的 Host 请求。同一个请求还会作为该 Session 侧栏行的第二行出现——请求方的一行摘要加上「拒绝」与「允许一次」——因此卡在审批上的后台会话不必打开就能作答。当浏览器必须为等待中的 Host 操作收集批准时，请使用它。卡片可以用键盘作答：卡片持有焦点时 Enter 允许一次、Escape 拒绝；方向键在两个动作之间移动焦点，Enter 按下当前聚焦的动作；两条路径调用与按钮相同的处理函数。

## 目录

- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

聚焦审批详情区域后，Enter 批准，Esc 拒绝。插件挂载期间，这两个按键不能分配给可编辑快捷键。聚焦“拒绝”按钮后，Enter 保留按钮原生拒绝操作。输入控件与输入法候选保留各自的按键。键盘和指针操作共用同一待处理请求锁；已撤销或替换的请求不能再次作答，较早请求的失败也不会解锁替代请求。侧栏行只用它的两个按钮作答、不占用任何按键；其无障碍名称包含 Session 标题，因此读屏软件在读列表时知道这个按钮决定的是哪个 Session。在两处中任一处作答结算的都是同一个 Host 请求，另一处呈现随之消失。

<a id="model-experience"></a>
## 模型体验

无，因为本包只在浏览器中呈现审批请求，不注册任何面向模型的内容。

#### KV Cache 影响

无；审批请求和响应的呈现不会改变模型请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **面板只提供临时决定**——它支持仅本次允许和拒绝；持久权限策略仍由 Host 侧审批包拥有。请求方提供的本地化展示文案跟随界面语言，不改写审计原因，也不翻译模型生成的文本。
- **行内摘要是请求方原文**——该行原样显示 `displayReason` 或 `reason`，因此沙箱越权读作 `escalate sandbox to <mode>: <一句话>`。结构化的目标（命令首行、文件路径、diff 规模）需要在审批请求及其审计事件上增加摘要字段。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
