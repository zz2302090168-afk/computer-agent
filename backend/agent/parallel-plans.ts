import type { Plan } from '../domain/types';
import { budgetRange, recommendationTargets } from '../rules/budget';
import { completeRequirements } from './conversation-state';
import { chatCompletion, type ModelMessage } from './chat-model';
import { toolProgress } from './progress';
import { auditDelivery } from '../services/delivery-audit';
import type { Progress } from './progress';
import {
  ToolExecutionError,
  MAX_CANDIDATE_ATTEMPTS,
  type RegisteredTool,
  type ToolContext,
  type ToolRuntime,
} from '../tools/types';

const signature = (plan: Plan) =>
  plan.kind === 'prebuilt'
    ? `prebuilt:${plan.id}`
    : `diy:${plan.parts
        .map((part) => part.id)
        .sort()
        .join('|')}`;
function submittedSignature(name: string, args: Record<string, unknown>) {
  if (name === 'assemble_build' && Array.isArray(args.productIds))
    return `diy:${args.productIds.map(String).sort().join('|')}`;
  if (name === 'select_prebuilt' && typeof args.prebuiltId === 'string')
    return `prebuilt:${args.prebuiltId}`;
  return null;
}

// 分支独立审核后可先预览，不写任务；主调用最终重审并保存整批。
export async function exploreParallelPlans(
  seeds: Plan[],
  context: ToolContext,
  runtime: ToolRuntime,
  tools: RegisteredTool[],
): Promise<Plan[]> {
  const unique = seeds.filter(
    (plan, index) =>
      seeds.findIndex((other) => signature(other) === signature(plan)) ===
      index,
  );
  const requirements = completeRequirements(runtime.draft);
  const range = budgetRange(
    requirements.budget,
    requirements.hardCap,
    undefined,
    requirements.budgetTolerance,
  );
  const targets = recommendationTargets(
    requirements.budget,
    requirements.hardCap,
    requirements.budgetTolerance,
  );
  const branches = unique.map((seed, index) => {
    const target = targets.reduce((best, value) =>
      Math.abs(value - seed.total) < Math.abs(best - seed.total) ? value : best,
    );
    return {
      seed,
      tier: (['方案一', '方案二', '方案三'] as const)[index],
      target,
      min: Math.max(range.min, target - Math.abs(seed.total - target)),
      max: Math.min(range.max, target + Math.abs(seed.total - target)),
    };
  });
  const generationId = crypto.randomUUID(),
    used = new Set<string>();
  context.onProgress?.({
    scope: 'main',
    label: `并行生成 ${branches.length} 套候选方案`,
    status: 'running',
    generationId,
    branches: branches.map((branch, index) => ({
      scope: `plan-${index}`,
      tier: branch.tier,
    })),
  });
  const outcomes = await Promise.allSettled(
    branches.map(async ({ seed, tier, min, max, target }, index) => {
      const scope = `plan-${index}`,
        label = tier ?? '候选方案';
      const progress = (
        text: string,
        status: 'running' | 'done' | 'error' = 'running',
        phase: Progress['phase'] = 'select',
        plan?: Plan,
      ) =>
        context.onProgress?.({
          scope,
          label: text,
          status,
          generationId,
          tier,
          phase,
          plan,
        });
      const finish = async (candidate: Plan) => {
        progress(
          candidate.kind === 'prebuilt'
            ? '核对最新整机、报价与配色'
            : '核对最新报价、配色与兼容性',
          'running',
          'audit',
        );
        const catalog = await context.reloadCatalog();
        context.signal?.throwIfAborted();
        const selected = used.has(signature(candidate)) ? seed : candidate;
        const audited = auditDelivery(
          [{ ...selected, tier }],
          requirements,
          catalog,
        )[0]!;
        used.add(signature(audited));
        progress(
          candidate.kind === 'prebuilt'
            ? '整机记录已核验，可先查看'
            : '八类配件已审核，可先查看',
          'done',
          'complete',
          audited,
        );
        return audited;
      };
      const local: ToolRuntime = {
        ...runtime,
        draft: structuredClone(runtime.draft),
        result: null,
        task: structuredClone(runtime.task),
        approvedPartIds: new Set(),
        toolsUsed: [],
        toolErrors: [],
        facts: [],
        failedAttempts: new Map(),
        exploration: undefined,
      };
      const branchContext: ToolContext = {
        ...context,
        onUpdate: undefined,
        onProgress: undefined,
      };
      const allowed = tools.filter(
        (tool) =>
          tool.definition.function.name === 'search_catalog' ||
          (seed.kind === 'diy'
            ? tool.definition.function.name === 'assemble_build'
            : tool.definition.function.name === 'select_prebuilt'),
      );
      const messages: ModelMessage[] = [
        {
          role: 'system',
          content: `你负责${label}的独立选型。当前真实需求：${JSON.stringify(requirements)}。
      本分支总价范围 ${min}～${max}，优先贴近本档目标 ${target}，不得比初始候选偏离目标更多。各方案按目标价区分，不代表性能实测。结合用途考虑不同配件取舍，说明实际差异；不得为凑差异牺牲明确需求。
      先观察下面数据库候选；需要改进时查询数据库，根据新观察自主换件，最多提交 ${MAX_CANDIDATE_ATTEMPTS} 个不重复候选组合。配置生成只依据业务规则与商品数据库；资料不足项由程序标记待确认，不能补写商品规格。
      用户指定型号、品牌、六类配色、预算及购买方式不可放宽。黑色优先白色备选仅当前目录该类别无黑色时回退。
      提交八类ID用assemble_build；商家整机用select_prebuilt，不拆换整机。工具通过后停止。
      候选是程序搜索所得，不是用户指定配置，可以保留；不能编造价格、规格或FPS。
      其他分支已保留以下配置，不得提交相同组合：${JSON.stringify(unique.filter((plan) => plan !== seed).map(signature))}`,
        },
        { role: 'user', content: JSON.stringify({ candidate: seed }) },
      ];
      const submitted = new Set<string>();
      let candidateAttempts = 0,
        correctionLimitReached = false;
      progress('开始选型');
      try {
        if (!context.modelConfig) {
          return await finish(seed);
        }
        for (let round = 0; round < 6; round++) {
          context.signal?.throwIfAborted();
          progress(round ? '根据查询与审核结果继续选型' : '分析数据库候选');
          const response = await chatCompletion(
            context.modelConfig,
            messages,
            allowed.map((tool) => tool.definition),
            'required',
            context.signal,
          );
          messages.push(response);
          if (!response.tool_calls?.length) {
            messages.push({
              role: 'system',
              content: '请提交候选ID供程序审核；文字回复不能代替配置提交。',
            });
            continue;
          }
          for (const [callIndex, call] of response.tool_calls.entries()) {
            let output: unknown;
            try {
              context.signal?.throwIfAborted();
              if (callIndex >= 8) throw Error('单轮最多执行八次调用');
              const tool = allowed.find(
                (item) => item.definition.function.name === call.function.name,
              );
              if (!tool) throw Error('当前分支不允许修改需求或任务');
              const args = JSON.parse(call.function.arguments || '{}');
              const combination = submittedSignature(call.function.name, args);
              if (combination) {
                if (submitted.has(combination))
                  throw Error('该组合已经提交过，请依据上次问题更换候选');
                if (candidateAttempts >= MAX_CANDIDATE_ATTEMPTS) {
                  correctionLimitReached = true;
                  throw Error(
                    `本分支已达到 ${MAX_CANDIDATE_ATTEMPTS} 个候选组合的修正上限`,
                  );
                }
                submitted.add(combination);
                candidateAttempts++;
              }
              progress(
                toolProgress[call.function.name] ?? '处理候选',
                'running',
                call.function.name === 'search_catalog' ? 'select' : 'audit',
              );
              output = await tool.execute(args, branchContext, local);
              const plan = local.result?.plans[0];
              if (plan) {
                local.result = null;
                if (plan.total < min || plan.total > max)
                  throw Error(`该配置总价不在本分支 ${min}～${max} 范围内`);
                if (
                  unique.some(
                    (other) =>
                      other !== seed && signature(other) === signature(plan),
                  )
                )
                  throw Error(
                    '该配置已被其他分支保留，请调整候选或提交本分支初始配置',
                  );
                return await finish(plan);
              }
            } catch (cause) {
              context.signal?.throwIfAborted();
              output = {
                error: cause instanceof Error ? cause.message : '候选执行失败',
                observation:
                  cause instanceof ToolExecutionError
                    ? cause.observation
                    : undefined,
              };
              progress(
                correctionLimitReached
                  ? '候选修正已达上限，准备复核初始候选'
                  : '根据审核问题调整配件组合',
                'running',
                correctionLimitReached ? 'audit' : 'adjust',
              );
            }
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify(output),
            });
            if (correctionLimitReached) break;
          }
          if (correctionLimitReached) break;
        }
      } catch {
        context.signal?.throwIfAborted();
        progress('选型暂时中断，审核已有搜索候选', 'running', 'audit');
      }
      if (submitted.has(signature(seed))) {
        progress('原始候选已提交失败，不再重复审核', 'error', 'audit');
        throw Error('本分支没有在修正上限内找到新的合格组合');
      }
      try {
        progress('未找到新组合，固定复核原始程序候选', 'running', 'audit');
        return await finish(seed);
      } catch (cause) {
        progress('当前候选未通过审核，等待重新生成', 'error', 'audit');
        throw cause;
      }
    }),
  );
  const failure = outcomes.find((outcome) => outcome.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  return outcomes.flatMap((outcome) =>
    outcome.status === 'fulfilled' ? [outcome.value] : [],
  );
}
