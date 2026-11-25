---
kind: upgrade-guide
description: "DeepSeek 会话导入入口从侧边栏“新建会话”行移到「设置 → 数据」下跨 Agent 导入页的第一张来源卡。"
---
# DeepSeek 会话导入入口移到了导入页

[English](guide.md) | 中文

## 变更

`deepseek-chat-import` 可选 bundle 不再向侧边栏的“新建会话”行注入按钮（`sidebar.session.action`）。同一个导入对话框现在从「DeepSeek 网页版导出（ZIP）」来源卡打开——它是「设置 → 数据 → 导入对话」页的第一张来源卡。上传路由、限额预检与导入出的会话都保持不变。

## 迁移

1. 打开「设置 → 数据 → 导入对话」，使用「DeepSeek 网页版导出（ZIP）」来源卡导入 `deepseek_data-*.zip` 导出文件。
2. 其余一切不变：bundle 开关、仅 owner 可导入的权限、上传路由与导入的会话行为都和以前一样。
