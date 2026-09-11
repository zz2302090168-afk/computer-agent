# 项目约定

使用中文说明需求、取舍和验证结果。业务目录按职责分离，企业级优化后置。

- 配件与整机均不保存库存数量或在售状态。
- 预算分三段：低于实时数据库最低完整配置 L 时仅展示八类兼容的超预算参考且禁止确认；高于目录内实际最高完整兼容参考 H 时展示该最高参考并允许节省；L 到 H 之间总价与预算差额绝对值不超过 1000 元，明确上限时收紧上界。
- 预算规则集中在 backend/rules/budget.ts，禁止复制独立常量到多个后端模块。
- 用户明确选择“黑色优先，白色备选”时，仅当前目录该类别没有黑色商品才回退白色；最贵指满足预算及兼容性约束的最高总价，不代表性能最强。
- 整套配色约束覆盖显卡、内存、主板、电源、机箱和散热；CPU 和硬盘不参与配色。缺少对应颜色时明确说明，不能仅换机箱便宣称满足。
- 商品只能来自数据库；演示型号与真实商品分开标注。
- 配置必须覆盖八类配件，替换后重算报价与兼容性。
- 商家组装整机作为数据库中的完整商品处理，不执行 DIY 配件兼容性审核；仍须核对整机存在性、八类构成、售价、预算、配色和用户指定型号，且不得宣称已验证兼容。
- 先配置主机，再讨论显示器。
- 不编造厂家规格、实测 FPS、1% low 或统计置信度。
- 不把 API 密钥放入前端、Git 或知识文档。
- 改动核心规则后运行 pnpm test；交付前运行类型检查、相关代码检查和构建。

配置交付、替换、确认和旧方案恢复必须通过统一程序审核，以当前任务需求与数据库商品重新核对完整性、配色、型号、预算和兼容性。审核失败不得展示为合格方案，返回具体问题供当前 Agent 继续修正；无需额外模型审核调用。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
