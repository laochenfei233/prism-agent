/**
 * The minutes structures this tool offers. Each template is the section outline the
 * model fills from the recording's transcript; the identifiers are the values of the
 * tool's `template` parameter.
 * @module @deepseek-ai/dsh-experimental-tool-meeting-minutes/templates
 */

/** Identifier of one offered minutes structure. */
export type MinutesTemplateId = 'default' | 'detailed' | 'action-focused' | 'decision'

/** The structure applied when the model does not choose one. */
export const DEFAULT_MINUTES_TEMPLATE: MinutesTemplateId = 'default'

/** The offered minutes structures, in the order the tool schema lists them. */
export const MINUTES_TEMPLATE_IDS: readonly MinutesTemplateId[] = ['default', 'detailed', 'action-focused', 'decision']

/** Basic minutes: agenda, discussion, and the decisions taken. */
const DEFAULT_TEMPLATE = `# 会议纪要

## 基本信息
- 会议主题：
- 参会人员：
- 会议时间：
- 会议时长：

## 议题与讨论
1.

## 决议与行动项
- [ ]

## 备注
`

/** Detailed minutes: per-topic discussion, dissent, and a decision record. */
const DETAILED_TEMPLATE = `# 会议纪要（详细版）

## 基本信息
- 会议主题：
- 参会人员：
- 会议时间：
- 会议时长：
- 会议地点：

## 议题列表
### 议题1：
**讨论内容：**
-

**不同意见：**
-

**结论：**
-

## 决策记录
| 序号 | 决策内容 | 负责人 | 截止日期 |
|------|----------|--------|----------|
| 1    |          |        |          |

## 行动项
- [ ] 任务1 - 负责人：  - 截止日期：

## 下次会议
- 时间：
- 议题预告：
`

/** Action-focused minutes: decisions, an owner table, and blockers. */
const ACTION_FOCUSED_TEMPLATE = `# 会议纪要（行动项聚焦）

## 会议概要
- 日期：
- 参会人员：

## 核心决策
1.

## 行动项清单
| 序号 | 任务描述 | 负责人 | 优先级 | 截止日期 | 状态 |
|------|----------|--------|--------|----------|------|
| 1    |          |        |        |          | 待办 |

## 风险与阻塞
-

## 跟进计划
-
`

/** Decision-record minutes: the options weighed and the reasoning for each decision. */
const DECISION_TEMPLATE = `# 会议纪要（决策记录）

## 会议信息
- 日期：
- 参会人员：
- 会议目的：

## 决策清单
### 决策1：
- **背景：**
- **选项：**
  - 选项A：
  - 选项B：
- **最终决定：**
- **理由：**

## 待决事项
-

## 后续行动
-
`

/** Every offered structure by identifier. */
export const MINUTES_TEMPLATES: Readonly<Record<MinutesTemplateId, string>> = {
  'action-focused': ACTION_FOCUSED_TEMPLATE,
  'decision': DECISION_TEMPLATE,
  'default': DEFAULT_TEMPLATE,
  'detailed': DETAILED_TEMPLATE,
}
