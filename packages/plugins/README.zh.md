# plugins/ —— 面向第三方形态的插件包

[English](README.md) | 中文

针对 harness 自身扩展点开发的插件的工程驻地：每个包声明一份 `dsh.plugin`
清单（type、mount、提供/消费的能力、配置 schema），插件工具链的其他视图
都从它推导——校验门、注册表聚合器与脚手架。

| 制品 | 职责 |
|---|---|
| [`registry.json`](registry.json) | 提交的成员清单：每份插件清单都必须出现的封闭清单 |
| [`aggregate.cordis.yml`](aggregate.cordis.yml) | 生成的 include 链，逐条指向各注册插件自带的 `cordis.yml` 片段（`pnpm run plugin:assemble` 生成；由 `pnpm run plugin:assemble:check` 校验新鲜度） |
| `<name>/` | 单个插件包，由 `pnpm run plugin:scaffold <name> --type host\|client\|dual-half\|mcp` 脚手架生成 |

## 包

| 包 | 职责 | 工具 |
|---|---|---|
| [`clock/`](clock/README.md) | 面向模型的 IANA 时区挂钟读数 | `clock` |
| [`weather/`](weather/README.md) | 面向模型的当前天气（经 web 缝） | `weather` |

清单形态由 `pnpm run plugin:verify`（`hygiene` 的一部分）校验；`consumes`
的服务解析仍以 cordis 启动为权威。设计出处：[插件工程层 Agent Note](../../.agents/notes/proposed/process/2026-08-17-plugin-engineering-layer.md)。
