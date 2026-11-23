# prism-session-autoarchive

[English](README.md) | 中文

侧边栏的定时整理：插件每个间隔跑一趟，把最后写入时间早于 `idleDays`（默认 30 天）的顶层会话加入 Workspace 归档集，并把不再有可见会话、安静超过 `projectIdleDays`（默认 14 天）的项目加入项目归档集。这里说的「归档」与侧边栏自带归档动作写入的是同一份持久、可逆的状态——什么都不删除，一切都能恢复。

**该功能默认关闭。** 插件挂载后保持闲置，直到你在本插件 schema 自动生成的设置页里打开 `enabled` 开关，或在 bundle 的 `cordis.patch.yml` 行里写 `enabled: true`。用户指南完整描述了这套行为（`docs/user/guide/auto-archive.md`，已投影到网站「自动化」一节）。

## 概览

- **可逆，且只针对闲置对象。** 只有窗口内会话日志没有变化过的会话才会进入归档集；想再用它，取消归档即可。项目只有在不名下无可见会话、且最新写入（或注册时间）超过项目窗口时才会进入归档集。
- **只处理顶层对话。** 子代理会话与分叉会话一律跳过：归档集会拒绝它命名的会话继续执行步骤，而委派它的父会话可能仍要继续这个子会话。已 pin 的会话同样跳过，因为归档会丢掉 pin。
- **绝不取消正在跑的工作。** 仍有活跃回合的会话会被归档集拒绝；扫描记录这次拒绝后继续处理下一个。
- **默认工作区豁免。** 首次使用注册的默认工作区绝不会被归档，除非部署设置 `includeDefaultWorkspace: true`。
- **重新添加文件夹即恢复项目。** 规范化文件夹路径就是项目的身份：再次添加被隐藏项目的文件夹会恢复原注册，而不是新建第二条。
- **在设置里配置。** 每个字段都是可实时编辑的配置项，插件自动生成的设置页可以直接改窗口，不必编辑 `cordis.yml`。同一插件还注册了列出隐藏项目并支持逐行恢复的设置节。

## 安装

插件是一个 profile bundle。把它加进 profile 的 bundle 列表，它会贡献一行 `cordis.patch.yml`：

```yaml
- id: prism-session-autoarchive
  name: 'prism-session-autoarchive'
  config:
    enabled: false
    idleDays: 30
    projectIdleDays: 14
    includeDefaultWorkspace: false
    sweepIntervalMinutes: 1440
```

还没安装这个包的检出可以把该行指向构建产物：`name: 'file:///absolute/path/to/plugins/prism-session-autoarchive/lib/index.js'`。

## 配置

| 字段 | 默认值 | 取值范围 | 作用 |
|---|---|---|---|
| `enabled` | `false` | 布尔 | 总开关；`false` 时插件保持挂载但完全不扫描 |
| `idleDays` | `30` | 1–3650 | 多少天没有对话后进入归档集 |
| `projectIdleDays` | `14` | 1–3650 | 项目多少天没有任何会话写入后进入项目归档集 |
| `includeDefaultWorkspace` | `false` | 布尔 | 是否允许默认工作区在闲置后被归档 |
| `sweepIntervalMinutes` | `1440` | 5–10080 | 扫描间隔（分钟） |

五个字段都是 `volatile`：设置页把值写进 Loader 递给插件的同一个 Config 引用，下一趟扫描即读到。任何 volatile 修改都会重新武装间隔，因此修改后的周期扫描要再等一个完整的 `sweepIntervalMinutes`；不涉及重启，也不需要重挂插件。

## 一趟扫描如何决策

1. 读取每个已存储的会话，加上本进程已创建但尚未落盘的会话。
2. 跳过已归档、已 pin、标记 `origin: 'subagent'` 或带 `parentSession` 的会话。
3. 其余会话按 `max(createdAt, updatedAt)` 计时——头部创建时间，若后端有报告则再取存储产物的最后写入时间。
4. 逐个归档超过截止时间的会话；仍在运行而被归档集拒绝的跳过。
5. 用同一份列表评估每个 Workspace：名下没有可见顶层会话、且最新账目写入（含已归档与子代理写入）或注册时间超过 `projectIdleDays` 的 Workspace 进入项目归档集；重新出现可见会话的隐藏 Workspace 当场恢复。除非 `includeDefaultWorkspace` 开启，默认工作区一律跳过。

首趟扫描在插件加载 60 秒后运行，之后按 `sweepIntervalMinutes` 继续。同一时刻只跑一趟：上一趟还在进行时到达的 tick 立即返回。失败的趟记录警告并保持下一个 tick 继续武装。

## 已知限制与暂缓事项

- **空白会话不单独分类。** 从未收到用户消息的会话没有特殊待遇：和其他闲置会话一样，到龄即归档。
- **活动时钟取日志最后写入。** 后端因维护（格式迁移、checkpoint）重写日志会让该会话看起来活跃，于是再等一个窗口。归档会迟到，但不会错。
- **没有手动「立即归档」。** 扫描是唯一触发方式；想立刻归档某个会话或项目，请使用侧边栏或设置里的操作。
- **测试套件没有 Loader 组合用例。** 规格解析插件自身的 schema（因此 volatile 引用无法冒充普通值），并通过记录型依赖驱动扫描，但没有任何用例把 Loader、Workspace 注册表和计时器一起启动：入口组合用 `prism --profile web --dump-config` 检查，首趟扫描在下次启动后的应用里运行。
