# 全链路试跑

范围：真实模型、真实业务工具、冻结的只读 MySQL 商品快照、临时会话状态。显示器 SQL 使用快照适配器，不能把这个脚本称为真实数据库端到端测试。浏览器检查另行记录。

## 执行

1. `node --experimental-strip-types --import ./scripts/register-typescript.mjs eval/system/snapshot.mjs`
2. `node --experimental-strip-types --import ./scripts/register-typescript.mjs eval/system/pilot.mjs <快照目录> <唯一运行名称> [场景ID...]`
3. `node eval/system/review.mjs <快照目录>`

配置默认从原项目 `.env.local` 只读加载；可用 `EVAL_ENV_FILE` 指定位置。不得打印配置或改写文件。运行名称不能重复，失败记录不能覆盖。每轮保留模型原始结果与诊断链。源码归档使用 `.ts.txt`，避免被应用编译为可执行源文件；内容哈希仍指向原始字节。

`EVAL_CASES_FILE=eval/system/adjacent.v1.json` 运行相邻边界案例。`EVAL_TOPIC_CANDIDATE=1` 仅在该评测进程中装配未采用的主题说明候选；默认生产主题参数保持原样。早期对照使用过 `EVAL_TOPIC_BASELINE=1`，该历史开关已被替代，旧 manifest 保留原值。

所有场景均为开发资料，`humanVerified=false`。程序检查通过不代表语义正确。`review.v2.json` 补充目录独立计数、纠正无解误判，保留旧判断并列，不能根据旧 `programPassed` 发布完整成功率。H03 旧夹具未标注均衡方案，只能验证选定与确认状态，不能验证选对方案。

`EVAL_COMPACT_PLAN_CONTEXT=1` 为离线性能候选，将完全相同的方案配件对象合并引用，每次发送前核验能够无损还原；默认关闭，不用于线上。`eval.compact_context` 记录发送前后字符数，普通 `model.start` 仍是变换前上下文。实际服务返回 Token 用于用量比较。首轮仅减少约1.3% Token、未显示耗时收益，未采用，详见 `docs/performance-tuning.md`。

本轮结果和限制见 `docs/evaluation-execution.md`。原始目录与日志在被 Git 忽略的 `eval/results/`，不提交到仓库。

## 语义评审校准

`eval/rag/score.py <冻结目录> --calibrate-only --calibration-file <难例JSON> --judge-version v6` 使用简化提示词与程序填写的固定版本号。`--thinking` 仅用于同模型思考模式的离线对照，不改变应用配置。默认v4保留历史重现用途，不表示该版本通过当前校准。

难例可指定逐维 `expectedMetrics` 和精确类别 `expectedCriticalFailures`；不能只检查是否存在任意严重错误。校准不通过会阻止批量评分；已有校准记录也不能原地覆盖。无效引文、未知ID、缺失原因的null及分数/结论冲突仍拒绝。新鲜校准例使用后即成为开发资料，不能再充当独立测试。

v5、v6及思考模式结果见 `docs/judge-calibration.md`。这些是离线评测候选，均未通过自动验收门槛，不据此宣称应用质量提升。

后续独立模型对照见 `docs/judge-independent.md`。GLM-5.3在当前接口要求开启思考模式；评审输出上限使用 `--max-output-tokens 8192`，默认仍为4096，可选范围512～16384。上限写入评审配置，非默认上限使用独立结果目录；不改变应用模型、超时或重试次数。

离线调用示例（使用冻结目录及已准备的校准文件）：

```powershell
$env:JUDGE_MODEL_NAME='glm-5.3'
.venv-ragas312/Scripts/python -X utf8 eval/rag/score.py <冻结目录> --calibrate-only --calibration-file <校准文件> --judge-version v6 --thinking --max-output-tokens 8192
```

曾尝试接口原生JSON Schema及更完整的请求约束，仍出现非法分数，相关实验分支已撤回。原始请求配置、输出和冻结脚本在结果目录保存；不能因为接口接受参数就宣称有强制结构保证。本地严格校验始终保留。
