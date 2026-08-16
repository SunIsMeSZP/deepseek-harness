# Agent Note: 插件工程层 —— 清单门禁、脚手架与注册表

Status: proposed

[English](2026-08-17-plugin-engineering-layer.md) | 中文

## Problem

同一 checkout 内的并行插件开发，把冲突集中在共享的提交文件上——lockfile、生成目录及其手工维护的注册表、聚合 tsconfig——以及全仓门禁上（逐文件覆盖率、目录新鲜度、typecheck）。动态包（`cordis_define`）只存在于进程内存（见[自指 cordis 工具集](../../implemented/feature/2026-07-08-self-referential-cordis-toolset.md)），没有转正为已发布静态包的通道。静态包经由 npm 发布、通过 cordis.yml 激活，但仓库没有为它们提供任何工程面：没有清单声明，没有脚手架，没有已发布插件的注册表。

## Proposal

加一层很薄的插件工程层：运行时保持原生，只固定门禁能看见的东西。

### dsh.plugin 清单

每个插件包在 package.json 里声明 `dsh.plugin`：`type`（host|client|dual-half|mcp）、`mount`（static|dynamic，默认 static）、`name`（注册表 id）、`provides`/`consumes` 能力列表、可选的 `configSchema` 路径、可选的 `trust` 块（仅限 dynamic 挂载）、以及 `mcp` 启动块（仅限 mcp 类型）。`scripts/verify-plugin-manifests.ts` 校验声明字段，并进入 `hygiene`（`pnpm run plugin:verify`）。校验刻意只做字段层面：`consumes` 的服务解析仍以 cordis 启动为权威；清单门禁只拒绝在任何组合下都非法的声明。

### plugins 组与注册表

插件位于 `packages/plugins/<name>`（深度二的 workspace 布局不变）。`packages/plugins/registry.json` 是提交的封闭清单；`scripts/assemble-registry.ts` 渲染 `packages/plugins/aggregate.cordis.yml`——一条指向每个已注册插件自带 cordis.yml 片段的 include 链。默认调用执行写入；`--check`（`pnpm run plugin:assemble:check`，`hygiene` 的一部分）双向校验成员关系与聚合文件的新鲜度。

### 脚手架

`pnpm run plugin:scaffold <name> --type host|client|dual-half|mcp` 生成符合门禁形态的骨架：函数插件形态的宿主半（`name`/`inject`/`Config`/`apply`，无默认导出）、client/dual-half 的浏览器半、cordis.yml 片段、带「模型体验」与「已知限制」两节的双语 README、测试与清单。生成的包立即通过 `plugin:verify`。

### 刻意划定的 v1 边界

- `consumes` 条目只校验名称形式；解析仍归 cordis 启动。
- 由 `provides` 推导目录沿用[发现包清单](2026-06-20-discover-package-inventory.md)的方向；动态定义的 promote、按插件 CI fan-out、生成包的聚合注册都是后续增量，不在本提案内。

## Alternatives considered

**独立插件 harness 仓库。** 现在否决：门禁、目录与构建 face 都住在本仓库，第二个家会复制它们并产生漂移。当插件出现仓外消费者时再议（见 Risks）。

**不做清单——扩展现有手工注册表（TOOL_PACKAGES 之类）。** 否决：每个消费者（注册表、UI、CI、目录）都会各自维护一份列表；一份声明喂饱全部。

**promote 与目录推导放进本增量。** 否决：两者都需要清单与注册表格式先稳定；一起交付等于一次冻结三种年轻格式。

## Acceptance criteria

- `scripts/plugin-manifests.ts`、`scripts/verify-plugin-manifests.ts`、`scripts/scaffold-plugin.ts` 与 `scripts/assemble-registry.ts` 存在，其 spec 覆盖校验矩阵、脚手架往返与注册表双向检查。
- `packages/plugins/registry.json` 与生成的 `aggregate.cordis.yml` 已提交且新鲜；两个插件门禁都在 `hygiene` 中运行并在当前树上通过。
- 脚手架生成的插件包一经注册即通过 `plugin:verify` 与 `plugin:assemble:check`。
- 任何已发布组合与既有门禁的行为均不改变。

## Risks

- 封闭清单对「先于注册表条目存在的插件」会造成摩擦；双向检查带着精确的补救指引响亮失败，这是接受的代价。
- 脚手架生成的包在注册进聚合之前不受门禁校验；README 记录注册步骤，提交的脚手架输出只由脚手架 spec 的往返测试覆盖。
- 字段层面的 `consumes` 校验会接受一个 cordis 在启动时拒绝的名字；启动错误就是响亮的失败点，在目录推导的解析器落地前可接受。
