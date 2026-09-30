import { registerHooks } from 'node:module';

// 仅评测子进程启用：在加载时恢复上轮优化前的三处逻辑，不修改生产文件。
if (process.env.PERFORMANCE_VARIANT === 'baseline') {
  registerHooks({
    load(url, context, next) {
      const result = next(url, context);
      if (
        !url.endsWith('/backend/agent/conversation.ts') &&
        !url.endsWith('/backend/agent/execution-plan.ts')
      )
        return result;
      let source =
        typeof result.source === 'string'
          ? result.source
          : Buffer.from(result.source).toString('utf8');
      const replaceOnce = (before, after) => {
        if (source.split(before).length !== 2)
          throw Error('基线转换锚点已变化，禁止静默继续测量');
        source = source.replace(before, after);
      };
      if (url.endsWith('/conversation.ts')) {
        const facts = source.match(
          /facts: runtime\.facts\.map\(\s*\(\{ arguments: _arguments, \.\.\.fact \}\) => fact,?\s*\),/g,
        );
        if (facts?.length !== 1) throw Error('基线事实摘要锚点已变化');
        replaceOnce(facts[0], 'facts: runtime.facts,');
        replaceOnce(
          'if (direct && canCompleteDirectQuery(runtime, directOutput))',
          'if (false && direct && canCompleteDirectQuery(runtime, directOutput))',
        );
      } else {
        const start = source.indexOf(
          '  const summary =',
          source.indexOf('export function executionPlanPrompt'),
        );
        const end = source.indexOf('\n}', start);
        if (start < 0 || end < 0) throw Error('基线计划摘要锚点已变化');
        source =
          source.slice(0, start) +
          '  return `\\n本轮执行计划：${JSON.stringify(runtime.executionPlan?.nodes)}\\n当前仅执行节点${node.id}：${node.goal}。引用原话：${node.sourceQuote}。其他节点由程序调度，不得提前执行或声称完成。保留用户完整消息中的否定和权限边界。完成后仅说明本节点工具事实，程序将继续后续节点。`;' +
          source.slice(end);
      }
      return { ...result, source };
    },
  });
}
