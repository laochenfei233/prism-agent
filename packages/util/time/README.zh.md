---
description: "面向接收调用方所报时区的维护者、以及需要解析以某个时区陈述的规则的维护者，说明 IANA 时区规范化与本地读数到瞬时的投影。"
kind: "package-library"
---

# dsh-util-time

[English](README.md) | 中文

## 概述

零依赖的时区词汇，供接收调用方时区的边界、以及以某个时区陈述的规则使用。`canonicalClientTimeZone` 只接受 `UTC` 或 IANA `Area/Location` 名称，并回答该名称在当前平台上的规范拼写，因此别名不会进入持久记录。`resolveLocalInstants` 枚举某个墙上时钟读数在某个时区里所指的瞬时——通常一个，跨重复小时时两个，时区跳过该读数时没有——`localCalendarEpoch` 提供投影用来比对的 UTC 形状取值。本库不格式化任何输出、不持有状态，也不抛出域码。

## 目录

- [使用本包](#use-this-package)
- [API](#api)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

它是**库，不是服务也不是插件**：无 `ctx`、不注册任何东西、不持有状态。

不发布运行时不变量伴生入口；这个纯工具不拥有事件流或可变运行时数据，时区规范化与本地读数投影由单元测试验证，覆盖时区重复与跳过的那些小时。

在接收时区的那个边界上调用 `canonicalClientTimeZone`，让值在进入任何持久物之前先过一遍。不可用的名称回答 `undefined`，由调用方抛出自己的拒绝——Session 提示词用 `session/invalid-time-zone`，subagent 续话用 `subagent/invalid-time-zone`。

当某条已存储或已配置的规则以某个时区陈述一个墙上时钟时间时，调用 `resolveLocalInstants`。它给出的答案是数据：时区重复了该读数时，由调用方决定规则指的是哪一个瞬时；时区跳过它时，也由调用方决定怎么办。不指向任何真实日历时间的读数属于调用方缺陷而非域数据，因此抛 `RangeError`。

-----

<a id="api"></a>
## API

```ts
import { canonicalClientTimeZone, localCalendarEpoch, resolveLocalInstants } from '@deepseek-ai/dsh-util-time'
```

| 导出 | 职责 |
|---|---|
| `canonicalClientTimeZone(value)` | 对接受的时区回答规范的 `UTC` 或 IANA `Area/Location` 名称；空串、带空白、缩写、单段或平台不支持的名称回答 `undefined`。 |
| `resolveLocalInstants(parts, timeZone)` | 某个墙上时钟读数在该时区里所指的升序瞬时：通常一个，跨重复小时两个，时区跳过时没有；并报告该读数是否落在可表示范围之外。 |
| `localCalendarEpoch(parts)` | 携带该读数各字段的 UTC 形状 epoch，也就是投影用来比对候选值的那个值；读数不指向任何真实日历时间时抛 `RangeError`。 |
| `MIN_FOUR_DIGIT_YEAR_MS`、`MAX_FOUR_DIGIT_YEAR_MS` | 本词汇可表示的最早与最晚瞬时，供调用方用自己的错误码拒绝越界规则。 |

<a id="model-experience"></a>
## 模型体验

间接影响，取决于把规范时区记到持久消息上的那个消费方——`dsh-time-context` 据此渲染该轮模型可见的时区指令与时间戳。

#### KV Cache 影响

自身没有。把时区派生文本注入请求的那个消费方，对该请求的缓存行为负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **别名解析取决于运行时的 ICU 数据**——一个别名组规范化成哪个名称由平台回答，因此两个跑在不同 Node 构建上的进程可能给出不同答案。
- **时区偏移同样取决于运行时的 ICU 数据**——投影通过 `Intl` 采样偏移，因此某个时区的规则在某个 tzdata 版本里发生变化时，解析依据的是当前 Node 携带的规则，而不是写规则时生效的那一版。
- **是投影，不是规则引擎**——本库只报告一个读数所指的瞬时，到此为止：它没有重复、间隔、日历的概念，也不判断两个瞬时中规则指的是哪一个，更不持有属于调用方自己的拒绝词汇。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
