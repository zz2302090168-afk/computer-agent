import {
  objectSchema,
  parseObject,
  rejectUnknownKeys,
  type RegisteredTool,
} from '../types';

export const finishExplorationTool: RegisteredTool = {
  definition: {
    type: 'function',
    function: {
      name: 'finish_exploration',
      description:
        '探索后确实需要用户决定，或本轮无法继续时结束。说明数据库观察与阻碍，不能把有限尝试说成已证明全局无解；成功方案由组装或整机选择工具保存，不能用本工具宣告成功。',
      parameters: objectSchema({ reason: { type: 'string' } }, ['reason']),
    },
  },
  async execute(value, _context, runtime) {
    // 只有还没真正启动过推荐时才要求先生成：一旦本轮已尝试过 recommend_pc，
    // 注册表就会以“不能重新开始”拒绝再次调用，此时若仍强制要求诊断，
    // 模型将没有任何可用出口，只能在最大轮数内反复失败。
    if (
      runtime.draft.budget &&
      runtime.draft.purpose &&
      !runtime.result?.budgetDiagnostic &&
      !runtime.recommendationAttemptKeys?.size &&
      !runtime.candidateSubmissionKeys?.size
    )
      throw Error(
        '尚无完整目录诊断，不能以局部空查询结束配机；请调用recommend_pc继续生成或取得具体无解证据',
      );
    const input = parseObject(value);
    rejectUnknownKeys(input, ['reason']);
    if (
      typeof input.reason !== 'string' ||
      !input.reason.trim() ||
      input.reason.length > 240
    )
      throw Error('请用240字以内说明已观察到的阻碍或需要用户决定的条件');
    if (runtime.result?.plans.length)
      throw Error('当前已有审核后的方案，不能将成功配置改写为探索失败');
    const diagnostic = runtime.result?.budgetDiagnostic;
    runtime.exploration = {
      status: 'blocked',
      reason: diagnostic
        ? diagnostic.searchComplete
          ? diagnostic.reason
          : '本轮搜索尚未完成：' + diagnostic.reason
        : input.reason.trim(),
    };
    return runtime.exploration;
  },
};
