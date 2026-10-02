# design-assets

[English](README.md) | 中文

Prism 品牌标识矢量源与从 Prism-Agent 旧代码库提取的设计内容。

提取日期：2026-09-24。源仓库完整归档见 `Documents/GitHub/archives/prism-agent-final-*.zip`。

## 目录

### app-icons/

| 文件 | 说明 |
| --- | --- |
| prism-icon-badge.svg / prism-mark.svg | 现行品牌标识矢量源，见 [app-icons/README.zh.md](app-icons/README.zh.md) |

### agent-logos/

5 个渐变几何 SVG（logo:agent:2、3、4、6、7），从 `src/renderer/components/icons/AgentLogo.tsx` 的形状与渐变色值导出为独立静态 SVG；橙色系的 1、5、8 已连同其他橙色图标删除。

### readme-design/

| 文件 | 来源 |
| --- | --- |
| hero.svg | `assets/readme/hero.svg` |
| features.svg | `assets/readme/features.svg` |

### design-docs/

| 文件 | 来源 |
| --- | --- |
| appleDesign.ts | `src/renderer/lib/appleDesign.ts`（弹簧/材质/动效 token） |
| design-audit.md | `docs/compose/spec/design-audit.md` |
| design-conformity-audit-and-mimo-fix.md | `docs/compose/spec/` |
| meeting-ui-apple-design-review.md | `docs/compose/reports/` |

## 会议纪要 logo 说明

会议相关页面（`pages/meetings`、`components/meetings`）无独立 png/svg logo 文件；界面图标均为 lucide-react（Mic、FileText、Sparkles 等），不可作为静态资源提取。会议视觉规范收录于 `design-docs/meeting-ui-apple-design-review.md`。
