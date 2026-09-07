# 装机研究所 · 电脑推荐 Agent

第一版可运行工程：DIY / 整机推荐、八类商品目录、预算与兼容性硬校验、方案恢复与替换、知识检索与可选模型解释。

## 本地运行

需要 Node.js 22.13+ 和 pnpm。首次安装后初始化数据库，再启动：

```powershell
pnpm install
pnpm db:migrate
pnpm dev
```

如包管理器提示构建脚本需要授权，按项目实际需要审核 esbuild、sharp、workerd。访问启动日志中的地址（通常为 http://localhost:3000）。首次读取目录会将真实型号目录写入数据库；后续不会覆盖已维护的数据。

## 数据和硬规则

- 160 条真实型号配件（八类各 20 条）、20 套商家组装套餐；厂家规格来自对应商品资料，价格为商家自行设定的目录价。
- 不保存库存数量或在售状态。数据库存在的商品参与候选筛选。
- `abs(主机总价 - 预算) <= 1000`，用户明确上限时还需不超过该上限。
- 整机使用商家整机目录价，配件行展示商家目录价但不代表拆件成交价。DIY 不含可选代装费用，商家组装套餐含 150 元装机费。均不含显示器。
- 厂家资料与项目推荐策略分开保存。当前版本已撤下帧率预测；用户询问时只说明不提供该功能。

## 模型配置

默认不需要密钥即可体验规则推荐。接入支持 chat-completions 的 HTTPS 模型服务时，在本地 `.dev.vars` 设置 `MODEL_BASE_URL`（含 `/v1` 等 API 基础路径）、`MODEL_NAME`、`MODEL_API_KEY`，然后重启开发服务。部署环境使用 Sites secret 设置，不提交密钥。该适配器尚未在真实密钥下验证。

## 检查

```powershell
pnpm test
pnpm typecheck
node scripts/smoke.mjs
pnpm build
```

## 更新商品目录

`data/seed/products.json` 和 `prebuilts.json` 是可阅读导出，种子源为 `data/seed/catalog.ts`。修改种子源后运行 `pnpm data:export`。已有数据库不会因修改种子而自动改变。

实际商家数据使用 `{ "parts": [...], "prebuilts": [...] }` JSON。运行 `node scripts/prepare-import.mjs <文件路径>` 可验证并生成 `data/merchant-import.sql`；生成本身不修改数据库。该 SQL 为本地 SQLite 完整目录替换，执行前备份，执行后清除旧会话避免旧报价。线上导入需要后续后台能力，不把本地事务脚本直接套用线上 D1。

目录与限制详见 [架构说明](docs/architecture.md)。当前不是企业级生产发布版；更完整的型号资料、模型联调与后台权限属于后续工作。
