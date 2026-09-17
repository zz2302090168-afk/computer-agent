# RAG 基线与消融

当前结果见 [v2报告](REPORT.v2.zh-CN.md) 和 [数值快照](results.v2.json)。[v1报告](REPORT.zh-CN.md)保留旧实验事实，不代表当前调用行为。旧版独立传输及回放入口已由正式 `embed` 与 `experiment.mjs` 替代。

## 当前实验

- 正式调用：当前 flash 型号单条请求、最多4路并发，整次向量操作90秒期限，不重试、不猜测重复索引。普通 qwen3.7 每批最多20条；其他型号维持原单请求。
- 基线：标题＋标签＋正文，top-k=4。开发候选：k=2/6、删除标题、删除标签、仅正文；不同文本分别生成向量，传输相同。
- `dataset.v1.json` 已看过的10题全部用于开发；`dataset.v2.json` 按关键结论组织等价证据组，另有6道预先冻结的新题。仍是助手核验的合成标注，没有人工真值。
- `config.v2.json` 在查看测试结果前固定选择顺序。开发集同一文本方案的top-k扫描共用一次排序；测试题基线/候选交替顺序。测试后不重新选方案。
- `corpus.v2.json` 固定98条语料指纹。修正了预算知识与程序默认误差不一致的问题；不能与v1数值直接作因果比较。
- 新题的自由回答回放与4个真实售后调用链场景分开报告。均未覆盖浏览器交互、真实商品数据库配机和部署。

## 复现

在项目根目录执行。配置只读自 `EVAL_ENV_FILE` 指定文件，默认原项目 `.env.local`；环境变量优先。不会修改配置或在结果中保存密钥。Python 3.12依赖见 `requirements.lock.txt`。

```powershell
node --experimental-strip-types --import ./scripts/register-typescript.mjs eval/rag/experiment.mjs
node --experimental-strip-types --import ./scripts/register-typescript.mjs eval/rag/support.mjs
```

**等待应用运行结束**，将两个输出目录填入下方占位：

```powershell
node --experimental-strip-types --import ./scripts/register-typescript.mjs eval/rag/latency.mjs <回放目录>
.venv-ragas312/Scripts/python -X utf8 eval/rag/score.py <回放目录> --expected-rows 12
.venv-ragas312/Scripts/python -X utf8 eval/rag/score.py <售后目录> --expected-rows 4
.venv-ragas312/Scripts/python -X utf8 eval/rag/report-v2.py <回放目录> <售后目录>
```

结果写入被Git忽略的 `eval/results/`。`report-v2.py` 校验行数和评分唯一性，输出 `summary.v2.json`，并首次建立可提交的无对话正文汇总 `results.v2.json`；已有快照时保留，仅输出本次目录的汇总。新版本需使用新配置、题集和输出版本。语料变化后入口会拒绝沿用v2，不要覆盖指纹绕过检查。

## 评审协议

业务评分仍使用 [rubric-v1](RUBRIC.zh-CN.md) 的0/1/2/null刻度。当前提示词是 `judge-prompt.v4.txt`；实际参数、提示词指纹、环境及模型写入每次 `assessment-v4/`。

问题、回答、合成参考、检索资料拆成有来源类型的原文片段。模型只选枚举内的ID；程序补回原文，再严格校验ID、引文、评分与判定对应关系。事实依据不能用待评回答自证，合成参考不能冒充厂家证据。这减少抄错引文的格式失败，但不保证语义判断正确。

先跑5条正反例校准，再批量评分；SDK重试0，结构化尝试1，temperature=0，单项120秒。无效评分保留，不补零或择优重试。`--resume` 只补尚未评分的行，要求配置、模型与通过的校准一致；已失败的行也不会重评。`--expected-rows` 防止对尚未完成的应用文件开始评分。

另使用真实 Ragas 0.4.3 Faithfulness，不把它当正确率。无检索上下文的停止场景不可评分，不计为0。v3校准失败记录和旧v1/v2提示词作为实验历史保留；v4仍与应用使用同一模型，存在评审偏差。

## 耗时与费用

- 冷/热检索各重复两次，顺序对称；报告中位数及范围，不报告小样本P95或显著性。
- 应用完成时间、首段正文回调来自Node运行，不是浏览器可见延迟。并行span不可相加代替总耗时。
- 语料生成、开发检索、测试回答、计时复测、校准及正式评审分别统计Token。没有实际服务价格或缺少用量时，费用保持未知，不填0。
- 后端诊断仍在 `logs/chat/*.jsonl`，保留100轮、每轮最多8MiB、脱敏且不进Git。前端计时仅在本页内存，不提供会话恢复。

本轮目录：

- `eval/results/v2-2026-09-15T07-35-39.429Z/`
- `eval/results/support-2026-09-15T07-36-09.077Z/`
