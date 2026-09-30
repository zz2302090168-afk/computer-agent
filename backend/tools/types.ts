import type { Draft } from '../agent/conversation-state';
import type { ModelConfig, ToolDefinition } from '../agent/chat-model';
import type { Progress } from '../agent/progress';
import type { EmbeddingConfig } from '../rag/retrieve';
import type {
  Catalog,
  PcTask,
  RecommendationResult,
  TaskSummary,
} from '../domain/types';

export const categories = [
  'cpu',
  'gpu',
  'memory',
  'motherboard',
  'psu',
  'case',
  'storage',
  'cooler',
] as const;
export const MAX_CANDIDATE_ATTEMPTS = 3;
export const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({ type: 'object', properties, required, additionalProperties: false });
export const categorySchema = { type: 'string', enum: categories };
export const categoryStringsSchema = () =>
  objectSchema(
    Object.fromEntries(
      categories.map((category) => [category, { type: 'string' }]),
    ),
  );

export const requestToolActions = [
  'search_catalog',
  'select_plan',
  'confirm_selections',
  'replace_parts',
  'apply_suggestion',
  'explain_selection',
  'evaluate_plan',
  'find_replacements',
  'retrieve_knowledge',
  'recommend_monitor',
  'update_support',
] as const;

export const supportActions = [
  'continue',
  'new_issue',
  'stop',
  'resolved',
  'handoff',
] as const;
export type SupportAction = (typeof supportActions)[number];

export type ToolRuntime = {
  executionPlan?: import('../agent/execution-plan').ExecutionPlan;
  otherTopic?: 'support' | 'general';
  consultPrebuiltId?: string;
  consultPrebuiltQueried?: boolean;
  requestAction?:
    | 'pending'
    | 'recommend'
    | 'clarify'
    | 'save_requirements'
    | 'other'
    | (typeof requestToolActions)[number];
  supportRequest?: {
    action: SupportAction;
    sourceMessageId: string;
    taskId: string;
  };
  requirementsTaskId?: string;
  configurationTaskId?: string;
  knowledgeUnavailable?: boolean;
  pendingEvaluation?: { planIds: string[] };
  supportEvidence?: Map<
    string,
    { taskId: string; messageId: string; source: 'embedding' | 'local' }
  >;
  supportRetrieval?: {
    taskId: string;
    messageId: string;
    status: 'available' | 'empty' | 'failed' | 'stopped';
    source: 'embedding' | 'local' | 'none';
  };
  supportDelivery?: {
    taskId: string;
    messageId: string;
    action: SupportAction;
    knowledgeId?: string;
    questionId?: import('../support/reply').SupportQuestionId;
  };
  localEdit?: boolean;
  localEditRequest?: {
    messageId: string;
    planId: string;
    draft: Draft;
    categories: string[];
    requirementPatch: string;
    colorPatch: string;
  };
  draft: Draft;
  result: RecommendationResult | null;
  approvedPartIds: Set<string>;
  toolsUsed: string[];
  toolErrors: string[];
  task: PcTask;
  contextChanged: boolean;
  facts: OperationFacts[];
  exploration?: {
    status: 'continue' | 'ready' | 'reference' | 'blocked';
    reason: string;
  };
  failedAttempts?: Map<string, { error: string; observation?: unknown }>;
  recommendationAttemptKeys?: Set<string>;
  candidateSubmissionKeys?: Set<string>;
  readOnlyEvaluationTurn?: boolean;
};

export { ToolExecutionError } from '../domain/errors';

export type ToolMessage = {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  consultPrebuiltId?: string;
  taskId?: string;
  replacementQueries?: import('../agent/chat-model').ModelMessage[];
};
export type OperationFacts = {
  tool: string;
  arguments?: unknown;
  nodeId?: string;
  rejected?: boolean;
  requirementsChanged: boolean;
  partsChanged: boolean;
  quoteChanged: boolean;
  hasPendingItems: boolean;
  failed: boolean;
  error?: string;
};

export type ToolContext = {
  embeddingConfig?: EmbeddingConfig;
  modelConfig?: ModelConfig;
  signal?: AbortSignal;
  onProgress?: (progress: Progress) => void;
  sessionId: string;
  taskId: string;
  currentMessageId: string;
  messages: ToolMessage[];
  tasks: TaskSummary[];
  catalog: Catalog;
  reloadCatalog: () => Promise<Catalog>;
  onUpdate?: (
    type:
      | 'requirements'
      | 'parts'
      | 'plan'
      | 'evaluation'
      | 'task'
      | 'support'
      | 'monitor',
    draft: Draft,
    result: RecommendationResult | null,
  ) => Promise<number>;
  onTaskChange: (task: PcTask) => Promise<void>;
};

export type RegisteredTool = {
  metadata?: import('./metadata').ToolMetadata;
  definition: ToolDefinition;
  execute: (
    argumentsValue: unknown,
    context: ToolContext,
    runtime: ToolRuntime,
  ) => Promise<unknown>;
};

// JSON Schema 只帮助模型生成参数；这里的检查才是服务端信任边界。
export function parseObject(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('工具参数必须是对象');
  return value as Record<string, unknown>;
}

export function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
) {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw Error(`工具参数包含未知字段：${unknown}`);
}
