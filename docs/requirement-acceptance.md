# 用户需求验收（2026-09-23）

完整候选 → 逐项需求验收 → 既有适配性检查 → Delivery Audit → 原有版本校验与状态写入。需求失败或未知通过现有 ToolExecutionError.observation 返回当前模型循环；任何修改重新验收，没有新建修复循环。商家整机保持不执行 DIY 兼容性检查的项目约定。

## 需求与证据

固定预算、八类完整性、品牌/型号、排除项和配色沿用现有 State 与规则。新增 `requirementItems` 按 ID 合并，未提交旧项保留，明确取消使用 `active=false`，版本由程序递增。原文必须逐字引用当前用户消息；不使用助手文案生成验收依据。数值单位采用目录单位：容量 GB、尺寸 mm、体积 L。软性品牌/型号应写为 soft 条目，不写入既有强制筛选字段。

规则检查容量、尺寸、散热类型、保留商品 ID；每个 active 条目都有 pass/fail/unknown，硬要求只有全部 pass 才放行。缺字段、推定资料、漏答和未知不能通过；软偏好不阻断，逐项结果随工具结果传回主模型。未知反馈要求补查，不将资料不足认定成不合格并强行换件。

完整候选的语义条目批量调用一次 Jev，规则硬失败/缺资料时先返回，不调用 Jev。通过凭证绑定有效需求、候选、报价和目录资料，并以进程内签名防止伪造；重审同一候选复用语义结果，程序规则仍重算。任何需求版本或商品变化均令旧结果失效。刷新会话不恢复凭证。

局部修改先冻结本轮需求、配色和替换范围；失败不提交结果，修复不能扩大范围或删约束。`preserve` 条目绑定七类原商品 ID，可进一步明确“除了显卡都别换”。自然语言到 State 的提取仍由既有主模型负责：程序保证 State 条目不漏检，不能据此宣称模型永不漏提取用户表达。

## Jev 与运行边界

适配器核对了 [官方接口及 OpenAPI](https://api.typesafe.ai/docs)：POST `https://api.typesafe.ai/v1/systemone`，`model/state/questions`；每个 choice 的 `choice/confidence/probabilities` 必须完整合法。不使用虚构 SDK。仅发送待语义验收的需求与相关商品证据，不发送整段聊天。

复用后端 `TYPESAFE_API_KEY`、`TYPESAFE_MODEL`；未改 `.env.local`。默认 `JEV_REQUIREMENT_CONFIDENCE=0.8`、`JEV_REQUIREMENT_PROBABILITY=0.9` 是未经业务数据校准的初值。2 秒上限沿用现有 Jev 适配器设置，父请求取消继续向上抛；服务故障、无凭据、畸形响应均为 unknown，无自动重试。调用接入现有 trace；写入沿用现有 onUpdate/版本校验，没有新持久化 checkpoint。

主循环原为16轮，按本次明确要求收紧为8轮；内部选型分支仍最多6轮、3次不重复候选提交，未放宽。Jev在已有工具步骤内运行，失败后的模型修复仍占原循环额度。达到预算保留具体未满足/未知 observation，不提交失败候选。内部选型分支调用仍沿用原本独立预算，并非整次请求所有模型合计8次。

## 兼容性 unknown 的变化

用户明确要求 DIY 适配性只有 pass 才最终交付。原实现无条件给所有 DIY 加入“散热满载能力与风道待确认”，因此现在无证据的真实目录候选会被阻断。

新增可信数据库字段 `case.specs.thermalAssessments`，记录项为 `{configurationKey,status,verified,source}`。`configurationKey` 使用 `thermalEvidenceKey(parts)`，绑定完整八类 ID 与规格（排除核验记录自身和价格）；仅对应当前组合、`verified=true` 且非推定、具备来源的 `status=pass` 才能消除该未知项。该字段只由可信商品资料维护端录入，模型工具不能写入；不得根据名称、CPU TDP 或 Jev 猜测生成。其他未知（如 BIOS）仍阻断。

没有替真实商品补造或录入任何证据。测试夹具的合成核验记录仅验证程序路径，不代表厂家认证或实测性能。普通方案分析允许列出未知问题，但不生成交付通过标记；最终交付入口默认严格检查。

## 修改文件

| 文件 | 用途 |
| --- | --- |
| `backend/domain/requirement-acceptance.ts`、`backend/domain/types.ts` | 条目、逐项结论、验收凭证类型 |
| `backend/services/requirement-state.ts`、`backend/agent/conversation-state.ts` | ID合并、版本与有效需求 |
| `backend/tools/requirements/schema.ts`、`update.ts` | 提取说明、原文绑定、防止修复放宽要求 |
| `backend/services/requirement-acceptance.ts`、`backend/agent/jev-requirements.ts` | 程序规则、批量语义适配、结构化 observation、失效控制 |
| `backend/services/recommend.ts`、`delivery-audit.ts`、`edit-plan.ts` | 组装、整机、局部替换与统一审核接入 |
| `backend/tools/build/assemble.ts`、`select-prebuilt.ts`、`recommend.ts`、`selection.ts`、`edit.ts`、`apply-suggestion.ts` | 原工具调用链与保存前门禁；反馈软性结果 |
| `backend/agent/parallel-plans.ts`、`conversation.ts`、`backend/tools/types.ts` | 复用循环、保留最终错误、8轮预算、局部修复范围冻结 |
| `backend/rules/compatibility.ts`、`backend/services/evaluate.ts` | 可信完整组合证据；分析与最终交付边界 |
| `backend/tests/requirement-acceptance.test.ts`、`thermal-fixture.ts`、`pc-fixture.ts` | 新增验收/异常/流程测试与隔离商品夹具 |
| `backend/tests/core.test.ts`、`budget-audit.test.ts`、`tool-scenarios.test.ts`、`conversation-rounds.test.ts` | 根据明确新行为更新旧断言，保留原预算/配色等约束验证 |
| `backend/tests/model-requirement-acceptance.ts`、`scripts/test.mjs`、`.env.example` | 真实合成探针、测试注册、阈值配置说明 |

## 验证记录

改动前 `pnpm test`：296/296通过。新增测试覆盖任务要求的12类行为；中文否定测试验证结构化提取结果的原文绑定与规则执行，主模型真实自然语言提取尚未做完整端到端验证。

真实 Jev：`node --experimental-strip-types --import ./scripts/register-typescript.mjs backend/tests/model-requirement-acceptance.ts`。2026-09-23合成中文5例一次批量调用，766ms，结果 pass/fail/unknown/pass/fail，与预设一致。见 `reports/requirement-acceptance-live.json`。这不是业务准确率或阈值校准结论。

最终 `pnpm test`：311/311通过，0失败，0跳过（26.59秒）；`pnpm typecheck`、`pnpm lint`、`pnpm build` 全部退出码0。`git diff --check` 通过（仅有Windows换行提示）。未进行真实 MySQL 数据变更、真实用户聊天、浏览器交互或性能评测；真实目录缺资料导致的阻断属于明确的安全边界，不能声称线上所有配置都可交付。

## 失败 observation 示例（节选）

```json
{
  "code": "requirement_acceptance_failed",
  "stage": "requirements",
  "candidateVersion": "<程序生成的当前配置指纹>",
  "passed": false,
  "issues": [{
    "requirementId": "ram",
    "text": "内存至少32GB",
    "strength": "hard",
    "status": "fail",
    "expected": 32,
    "actual": 16,
    "evidence": [{"productId":"memory","field":"capacity","value":16}],
    "missingInformation": [],
    "action": "在授权范围内修改对应配置"
  }],
  "preserveConstraints": {"budget":8000,"hardCap":true,"requirementItems":"<实际返回全部当前有效条目>"},
  "retryable": true,
  "guidance": "不得放宽预算、删除硬约束或更换未获授权的部件；所有修改后重新验收。无法完成则保留原方案并报告具体冲突。"
}
```

完整 observation 还含所有逐项 `checks`。上例中的尖括号是文档占位符，实际返回指纹和完整对象。
