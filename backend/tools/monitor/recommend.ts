import { loadMonitorCatalog } from '../../db/catalog';
import {
  recommendMonitors,
  validateMonitorCriteria,
} from '../../services/recommend-monitors';
import {
  objectSchema,
  parseObject,
  rejectUnknownKeys,
  type RegisteredTool,
} from '../types';

export const recommendMonitorTool: RegisteredTool = {
  definition: {
    type: 'function',
    function: {
      name: 'recommend_monitor',
      description:
        '仅在用户明确请求推荐且当前任务已有完整主机方案时，按显示器预算、分辨率、面板、最低刷新率和用途推荐最多三款数据库真实型号。会保存并更新右侧显示器推荐，不用于仅浏览目录或查询有哪些型号。显示器不计入主机报价，不预测显卡帧率，也不确认购买。',
      parameters: objectSchema({
        budget: { type: 'integer', minimum: 200, maximum: 5000 },
        resolution: { type: 'string', enum: ['1080p', '1440p', '4K'] },
        panel: { type: 'string', enum: ['IPS', 'VA', 'OLED', 'MiniLED'] },
        minRefreshRate: { type: 'integer', minimum: 60, maximum: 320 },
        purpose: { type: 'string', enum: ['办公', '游戏', '剪辑设计', '综合'] },
      }),
    },
  },
  async execute(value, context, runtime) {
    const input = parseObject(value);
    rejectUnknownKeys(input, [
      'budget',
      'resolution',
      'panel',
      'minRefreshRate',
      'purpose',
    ]);
    if (!runtime.result?.plans.length)
      throw Error('请先完成主机配置，再讨论显示器。');
    const recommendation = recommendMonitors(
      validateMonitorCriteria(input),
      await loadMonitorCatalog(),
    );
    const result = { ...runtime.result, monitorRecommendation: recommendation };
    await context.onUpdate?.('monitor', runtime.draft, result);
    runtime.result = result;
    runtime.toolsUsed.push('推荐显示器');
    return recommendation;
  },
};
