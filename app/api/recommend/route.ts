import { env } from 'cloudflare:workers';
import { loadCatalog, database } from '@/backend/db/catalog';
import { parseRequirements } from '@/backend/agent/requirements';
import { recommend } from '@/backend/services/recommend';
import { retrieveKnowledge } from '@/backend/rag/retrieve';
import { explainWithModel } from '@/backend/agent/model';
import { readJson, sessionId, json } from '@/backend/api/http';
import { budgetRange } from '@/backend/rules/budget';
export async function POST(request: Request) {
  try {
    const input = await readJson(request),
      requirements = parseRequirements(input),
      catalog = await loadCatalog();
    const plans = recommend(requirements, catalog.parts, catalog.prebuilts),
      range = budgetRange(requirements.budget, requirements.hardCap);
    const evidence = retrieveKnowledge(
      `${requirements.purpose} ${requirements.message} 预算 兼容 FPS`,
      5,
    );
    let explanation: null | string = null,
      modelStatus = '未配置模型，使用规则引导与知识检索';
    try {
      explanation = await explainWithModel(
        {
          key: env.MODEL_API_KEY,
          base: env.MODEL_BASE_URL,
          model: env.MODEL_NAME,
        },
        {
          requirements,
          plans: plans.map((p) => ({
            name: p.name,
            parts: p.parts.map((x) => x.name),
            reason: p.reason,
          })),
          evidence,
        },
      );
      if (explanation) modelStatus = '模型解释已生成，报价与规则由后端计算';
    } catch {
      modelStatus = '模型暂时不可用，已返回规则推荐';
    }
    const summary = plans.length
      ? `找到 ${plans.length} 套方案，价格均在 ¥${range.min.toLocaleString()}～¥${range.max.toLocaleString()} 内。`
      : '当前目录没有同时满足预算、颜色和兼容性要求的方案。可以修改预算或偏好后重试；系统不会扩大预算区间。';
    const id = sessionId(request);
    await database()
      .prepare(
        'INSERT INTO sessions(id,requirements,plans,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET requirements=excluded.requirements,plans=excluded.plans,updated_at=excluded.updated_at',
      )
      .bind(id, JSON.stringify(requirements), JSON.stringify(plans), Date.now())
      .run();
    return json(
      { requirements, plans, summary, evidence, explanation, modelStatus },
      200,
      id,
      new URL(request.url).protocol === 'https:',
    );
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : '推荐失败' }, 400);
  }
}
