# prism-session-autoarchive

[English](README.md) | 中文

自动归档无人再动的会话：插件每天跑一次，把最后写入时间早于 `idleDays`（默认 30 天）的顶层会话加入 Workspace 归档集，让侧边栏不再堆积不会再打开的对话。这里说的「归档」与侧边栏自带的归档动作写入的是同一份持久、可逆的状态——什么都不删除，任何被归档的会话都能从归档视图恢复。

## 概览

- **可逆，且只针对闲置会话。** 只有在窗口内会话日志没有变化过的会话才会进入归档集；想再用它，取消归档即可。
- **只处理顶层对话。** 子代理会话与分叉会话一律跳过：归档集会拒绝它命名的会话继续执行步骤，而委派它的父会话可能仍要继续这个子会话。已 pin 的会话同样跳过，因为归档会丢掉 pin。
- **绝不取消正在跑的工作。** 仍有活跃回合的会话会被归档集拒绝；扫描记录这次拒绝后继续处理下一个。
- **在设置里配置。** 每个字段都是可实时编辑的配置项，插件自动生成的设置页可以直接改窗口，不必编辑 `cordis.yml`。

## 安装

插件是一个 profile bundle。把它加进 profile 的 bundle 列表，它会贡献一行 `cordis.patch.yml`：

```yaml
- id: prism-session-autoarchive
  name: 'prism-session-autoarchive'
  config:
    enabled: true
    idleDays: 30
    sweepIntervalMinutes: 1440
```

还没安装这个包的检出可以把该行指向构建产物：`name: 'file:///absolute/path/to/plugins/prism-session-autoarchive/lib/index.js'`。

## 配置

| 字段 | 默认值 | 取值范围 | 作用 |
|---|---|---|---|
| `enabled` | `true` | 布尔 | `false` 时插件保持挂载但完全不扫描 |
| `idleDays` | `30` | 1–3650 | 多少天没有对话后进入归档集 |
| `sweepIntervalMinutes` | `1440` | 5–10080 | 两次扫描之间的分钟数 |

三个字段都是 `volatile`，设置页可以直接改：Loader 会用新值重新加载插件，下一轮扫描即生效。

## 一轮扫描怎么判断

1. 读取每个已存会话，加上本进程创建但尚未落盘的会话。
2. 跳过已归档、已 pin、标为 `origin: 'subagent'` 或带 `parentSession` 的会话。
3. 用 `max(createdAt, updatedAt)` 计算会话的最后活动时间——header 的创建时间，以及后端能提供时取二者较晚的存储产物最后写入时间。
4. 逐个归档早于截止时间的会话；被归档集以「仍在运行」拒绝的会话跳过。

首次扫描在插件加载 60 秒后执行，之后按 `sweepIntervalMinutes` 间隔。同一时刻只跑一轮：本轮未结束时到达的 tick 立即返回。某一轮失败会记一条 warning，下一个 tick 照常。

## Known Limitations and Deferred Work

- **空会话不做区分。** 从未收到用户消息的会话没有特殊处理：够旧之后与其它闲置会话一样被归档。
- **活动时钟是日志的最后写入时间。** 后端因维护重写日志（格式迁移、checkpoint）会让该会话看起来刚活跃过，于是它再等一个窗口。宁可晚归档，也不会错归档。
- **没有手动「立即归档」。** 扫描是唯一触发方式；想立刻归档某个会话，用侧边栏的归档动作。
- **定时接线在运行中的应用里验证，而不是在测试套件里。** spec 覆盖选择与扫描行为；安装与设置项在启动后的 profile 上验证。
