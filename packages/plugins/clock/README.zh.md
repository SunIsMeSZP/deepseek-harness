# @deepseek-ai/dsh-clock

[English](README.md) | 中文

面向模型的挂钟工具：`clock` 读取 IANA 时区下的当前日期与时间。本包是 [plugins 组](../README.md)的第一个成员，经由[插件工程层](../../../.agents/notes/proposed/process/2026-08-17-plugin-engineering-layer.md)脚手架、注册并受门禁约束。

## 工具

- `clock(timeZone?, format?)` 返回当前读数。`format: 'iso'`（默认）渲染 ISO-8601 时刻加时区本地文本；`format: 'unix'` 渲染裸 Unix 毫秒。解析后的时区与 Unix 毫秒始终随规范值返回。

非法时区以 `CLOCK_INVALID_ZONE` 响亮失败。组合级回退时区在插件装载时解析，因此配置错误的时区会在组合启动时失败，而不是拖到第一次调用。

## 配置

```yaml
- id: clock
  name: '@deepseek-ai/dsh-clock'
  config:
    timeZone: UTC
```

`timeZone` 为可选 IANA 时区，默认 `UTC`，在调用未指定时生效。

## 模型体验

### 工具 schema 与结果

#### 模型看到什么

生成的 [`clock` schema](../../../docs/tool-catalog.md#deepseek-aidsh-clock)。成功结果是单个短文本块，携带时区、ISO-8601 时刻与时区本地渲染。

#### Token 影响

每次调用：固定 schema 成本加一个短结果。

#### KV Cache 影响

该工具视图不变时 schema 前缀稳定。调用与结果追加在可复用的请求前缀之后，不会使早前条目失效。

## 已知限制与后续工作

- **无持久事件流**——读数只是逐调用值，不产生会话事件；因此本包的不变式伴生注册空安装器。
- **时区数据库随运行时走**——IANA 时区可用性取决于 Node ICU；冷门时区会在装载或调用时以 `CLOCK_INVALID_ZONE` 失败。
