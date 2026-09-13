import type { ChatState } from './conversation';
import type { PcTask, Plan } from '../domain/types';

export type Progress = {
  scope: string;
  label: string;
  status: 'running' | 'done' | 'error';
  generationId?: string;
  tier?: Plan['tier'];
  phase?: 'prepare' | 'select' | 'adjust' | 'audit' | 'complete';
  branches?: { scope: string; tier?: Plan['tier'] }[];
  plan?: Plan;
  invalidatePlans?: boolean;
};
export type ChatStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'progress'; progress: Progress }
  | { type: 'requirements'; task: PcTask }
  | { type: 'complete'; state: ChatState }
  | { type: 'error'; error: string };

export const toolProgress: Record<string, string> = {
  set_request_action: '明确本轮需求与操作范围',
  update_support: '记录本次排查步骤与反馈',
  select_plan: '审核当前选定方案',
  find_replacements: '保留其他配件，检查替换候选',
  explain_selection: '读取当前配件规格、用途权重与知识依据',
  replace_parts: '仅替换指定配件并审核',
  update_requirements: '记录当前需求',
  authorize_selection: '记录选型授权',
  search_catalog: '查询数据库商品',
  recommend_pc: '准备推荐方案',
  recommend_monitor: '按当前主机筛选显示器',
  assemble_build: '审核配件、兼容性与预算',
  select_prebuilt: '审核整机配置与报价',
  confirm_selections: '重新审核待确认方案',
  retrieve_knowledge: '查询RAG知识库',
  evaluate_plan: '评估当前方案',
  apply_suggestion: '应用建议并重新审核',
  finish_exploration: '整理当前阻碍',
};
