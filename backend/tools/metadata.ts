import type { ToolRuntime } from './types';

type Action = Exclude<ToolRuntime['requestAction'], 'pending' | undefined>;
export type ToolMetadata = {
  parallelRead?: boolean;
  taskTypes: readonly Action[];
  primaryFor: readonly Action[];
  effect: 'read' | 'write' | 'control';
  preservesConfigurationOnFailure: boolean;
};

const reads: Action[] = [
  'search_catalog',
  'retrieve_knowledge',
  'explain_selection',
  'find_replacements',
  'evaluate_plan',
  'save_requirements',
  'clarify',
  'recommend',
  'select_plan',
  'confirm_selections',
  'replace_parts',
  'apply_suggestion',
  'recommend_monitor',
  'update_support',
];
const meta = (
  taskTypes: Action[],
  primaryFor: Action[],
  effect: ToolMetadata['effect'],
  preservesConfigurationOnFailure = false,
): ToolMetadata => ({
  taskTypes,
  primaryFor,
  effect,
  preservesConfigurationOnFailure,
});

// 参数Schema和执行器仍来自工具本身；此处集中声明路由及副作用策略。
export const toolMetadata: Record<string, ToolMetadata> = {
  set_request_action: meta([], [], 'control'),
  revise_execution_plan: meta([], [], 'control'),
  search_catalog: {
    ...meta(reads, ['search_catalog'], 'read'),
    parallelRead: true,
  },
  retrieve_knowledge: meta(reads, ['retrieve_knowledge'], 'read'),
  update_requirements: meta(
    ['recommend', 'clarify', 'save_requirements'],
    ['clarify', 'save_requirements'],
    'write',
  ),
  authorize_selection: meta(
    ['recommend', 'clarify', 'save_requirements'],
    [],
    'write',
  ),
  recommend_pc: meta(['recommend'], [], 'write'),
  assemble_build: meta(['recommend'], [], 'write'),
  select_prebuilt: meta(['recommend'], [], 'write'),
  finish_exploration: meta(['recommend'], [], 'control'),
  select_plan: meta(['select_plan'], ['select_plan'], 'write', true),
  confirm_selections: meta(
    ['confirm_selections'],
    ['confirm_selections'],
    'write',
    true,
  ),
  replace_parts: meta(['replace_parts'], ['replace_parts'], 'write', true),
  apply_suggestion: meta(
    ['apply_suggestion'],
    ['apply_suggestion'],
    'write',
    true,
  ),
  explain_selection: {
    ...meta(
      ['explain_selection', 'evaluate_plan'],
      ['explain_selection'],
      'read',
      true,
    ),
    parallelRead: true,
  },
  find_replacements: {
    ...meta(
      ['find_replacements', 'evaluate_plan'],
      ['find_replacements'],
      'read',
      true,
    ),
    parallelRead: true,
  },
  evaluate_plan: meta(['evaluate_plan'], ['evaluate_plan'], 'read', true),
  recommend_monitor: meta(
    ['recommend_monitor'],
    ['recommend_monitor'],
    'write',
  ),
  update_support: meta(['update_support'], ['update_support'], 'write'),
};
