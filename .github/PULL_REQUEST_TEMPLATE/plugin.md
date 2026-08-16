<!-- 写 Fixes #NN 表示解决并自动关闭；写 Related to #NN 仅关联。 -->
<!-- 本模板面向 packages/plugins/** 的插件开发 PR，对应 .agents/skills/dsh-develop-plugin 流程的产物。 -->

关联 Issue：

## 插件设计规格（P1 产物）

- 目标：
- provides / consumes：
- 配置：
- 信任面（static / dynamic / mcp）：
- 拒绝文案（teaching text）：

## 变更与验证

- 变更：

### 测试证据（三层）

- [ ] 单测 + 逐文件 100% 覆盖：`pnpm vitest run packages/plugins/<name>/tests --coverage --config vitest.plugin.config.ts`（PLUGIN=packages/plugins/<name>）
- [ ] 无 key Loader e2e：fixture 三件套（cordis.yml + 脚本化 mock）+ `pnpm vitest run --config vitest.e2e.config.ts examples/<agent>/tests/<name>.e2e.ts`
- [ ] 动态验证：有则记录会话（promote 输入）；跳过则说明原因

### 集成六步

- [ ] `packages/plugins/registry.json` 登记 + `pnpm run plugin:assemble`（聚合已更新）
- [ ] `tsconfig.base.json` paths（包名 + `/invariant`）+ `tsconfig.host.json` 引用
- [ ] `TOOL_PACKAGES` 条目 + `pnpm run gen-tool-catalog`（含 gen-tool-catalog.spec 精确清单同步）
- [ ] `pnpm run gen-module-graph`（含中文对侧 + 配对重录）
- [ ] `examples/package.json` 依赖
- [ ] `pnpm install`（锁文件）

### 门禁

- [ ] plugin:verify / plugin:assemble:check
- [ ] verify-tool-catalog / verify-module-graph / verify-cordis-config
- [ ] typecheck / oxlint / knip
- [ ] 翻译配对（新双语文件已 --write 重录）
