import type { ChatState } from './conversation';
import type { Plan } from '../domain/types';

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
  | { type: 'progress'; progress: Progress }
  | { type: 'complete'; state: ChatState }
  | { type: 'error'; error: string };

export const toolProgress: Record<string, string> = {
  update_support: '保存排查步骤与反馈',
  select_plan: '审核并保存当前选定方案',
  find_replacements: '保留其他配件，检查替换候选',
  explain_selection: '读取当前配件规格、用途权重与知识依据',
  replace_parts: '仅替换指定配件并审核',
  undo_last_change: '恢复上一次修改前的配置并审核',
  update_requirements: '记录当前需求',
  authorize_selection: '记录选型授权',
  search_catalog: '查询数据库商品',
  recommend_pc: '准备推荐方案',
  assemble_build: '审核配件、兼容性与预算',
  select_prebuilt: '审核整机配置与报价',
  confirm_selections: '重新审核待确认方案',
  retrieve_knowledge: '查询RAG知识库',
  evaluate_plan: '评估当前方案',
  apply_suggestion: '应用建议并重新审核',
  create_task: '创建任务',
  switch_task: '恢复并审核任务',
  reset_current_task: '重置任务需求',
  finish_exploration: '整理当前阻碍',
};
