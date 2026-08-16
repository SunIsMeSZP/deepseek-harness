# @deepseek-ai/dsh-weather

[English](README.md) | 中文

面向模型的天气工具：`weather(latitude?, longitude?)` 返回某个坐标对的当前摄氏温度与数字天气代码，经由 [web 能力缝](../../web/web/README.md)从可配置的天气预报 API 获取。默认端点是免 key 的 Open-Meteo API。

## 工具

- `weather(latitude?, longitude?)` 获取当前天气。省略坐标时回退到配置的 `defaultLocation`；两者都没有时以 `WEATHER_LOCATION_REQUIRED` 失败。越界坐标以 `WEATHER_INVALID_COORDINATES` 失败；API 返回非 2xx 以 `WEATHER_API_STATUS` 失败；响应体不是预期的 JSON 记录以 `WEATHER_BAD_RESPONSE` 失败。

## 配置

```yaml
- id: weather
  name: '@deepseek-ai/dsh-weather'
  config:
    apiBaseUrl: https://api.open-meteo.com/v1/forecast
    defaultLocation:
      latitude: 31.2
      longitude: 121.5
```

两个键均可选。组合还必须挂载 web 缝（`@deepseek-ai/dsh-web`）与一个 fetch provider，例如 `@deepseek-ai/dsh-web-fetch-http`。

## 模型体验

### 工具 schema 与结果

#### 模型看到什么

生成的 [`weather` schema](../../../docs/tool-catalog.md#deepseek-aidsh-weather)。成功结果是单个短文本块，含温度、坐标与天气代码；规范值以结构化形式携带相同字段。

#### Token 影响

每次调用：固定 schema 成本加一个短结果。

#### KV Cache 影响

该工具视图不变时 schema 前缀稳定。调用与结果追加在可复用的请求前缀之后，不会使早前条目失效。

## 已知限制与后续工作

- **不支持按城市输入**——工具接受坐标而非地名；地理编码属于调用方或未来的姊妹工具。
- **天气代码保持数字**——映射为人类可读标签推迟到有消费者需要时。
- **Provider 选择跟随缝**——端点可用性、重定向与大小限制是 web provider 的策略，不属于本包。
