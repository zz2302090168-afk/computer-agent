export const labels = {
  cpu: 'CPU',
  gpu: 'GPU',
  memory: '内存',
  motherboard: '主板',
  psu: '电源',
  case: '机箱',
  storage: '硬盘',
  cooler: '散热',
};
export type Category = keyof typeof labels;
export type Part = {
  id: string;
  category: Category;
  categoryLabel: string;
  brand: string;
  name: string;
  color: string;
  price: number;
  specs: Record<string, unknown>;
  demo: boolean;
};
export type Prebuilt = {
  id: string;
  name: string;
  brand: string;
  color: string;
  price: number;
  partIds: string[];
  demo: boolean;
};
export type MonitorResolution = '1080p' | '1440p' | '4K';
export type MonitorPanel = 'IPS' | 'VA' | 'OLED' | 'MiniLED';
export type MonitorPurpose = '办公' | '游戏' | '剪辑设计' | '综合';
export type MonitorSpecs = {
  resolution: MonitorResolution;
  panel: MonitorPanel;
  refreshRate: number;
  refreshRateNote?: string;
  size: number;
  source?: string;
  checkedAt?: string;
  priceBasis?: 'merchant-authored';
};
export type Monitor = {
  id: string;
  brand: string;
  name: string;
  price: number;
  specs: MonitorSpecs;
  demo: boolean;
};
export type MonitorCriteria = {
  budget?: number;
  resolution?: MonitorResolution;
  panel?: MonitorPanel;
  minRefreshRate?: number;
  purpose?: MonitorPurpose;
};
export type MonitorRecommendation = {
  criteria: MonitorCriteria;
  catalogTotal: number;
  total: number;
  monitors: Monitor[];
  note: string;
};
export type Requirements = {
  budgetTolerance?: number;
  partColors?: Partial<Record<Category, string>>;
  budget: number;
  hardCap: boolean;
  purpose: string;
  mode: 'diy' | 'prebuilt' | 'both';
  color: string;
  message: string;
  brand: string;
  game: string;
  brandPreferences?: Partial<Record<Category, string>>;
  partPreferences?: Partial<Record<Category, string>>;
  seriesPreferences?: Partial<Record<Category, string>>;
  excludedModels?: Partial<Record<Category, string[]>>;
  excludedBrands?: Partial<Record<Category, string[]>>;
  excludedColors?: string[];
  selectionAuthorizations?: Partial<Record<Category, string>>;
  selectionAuthorizationMessageIds?: Partial<Record<Category, string>>;
  selectionSources?: Partial<
    Record<Category, 'user' | 'assistant' | 'confirmed'>
  >;
  selectionConfirmationMessageIds?: Partial<Record<Category, string>>;
  partSelections?: Partial<Record<Category, string>>;
  preferCheaper?: boolean;
  preferExpensive?: boolean;
};
export type Validation = {
  status: 'pass' | 'fail' | 'unknown' | 'not_applicable';
  issues: string[];
};
export type BudgetStatus =
  | 'below_minimum_reference'
  | 'standard'
  | 'above_high_reference';
export type BudgetAssessment = {
  status: BudgetStatus;
  difference: number;
  confirmable: boolean;
  label: string;
  reason: string;
  minimumReference: number;
  highReference: number;
  highReferenceBasis: string;
};
export type Plan = {
  tier?: '方案一' | '方案二' | '方案三' | '低价方案' | '均衡方案' | '高价方案';
  id: string;
  kind: 'diy' | 'prebuilt';
  // 整机自身或任一构成配件为演示商品；旧方案在交付审核时补齐。
  demo?: boolean;
  name: string;
  parts: Part[];
  total: number;
  validation: Validation;
  reason: string;
  score: number;
  budget: BudgetAssessment;
  deliveryAudit?: { status: 'passed' | 'reference'; checkedAt: string };
};
export type Evidence = {
  id: string;
  title: string;
  content: string;
  source: string | null;
  checkedAt: string | null;
};
export type RecommendationResult = {
  monitorRecommendation?: MonitorRecommendation;
  selection?: {
    planId: string;
    status: 'selected' | 'confirmed';
    source: 'user_message' | 'ui';
    messageId?: string;
  };
  requirements: Requirements;
  plans: Plan[];
  summary: string;
  evidence?: Evidence[];
  explanation?: string | null;
  modelStatus?: string;
  evaluation?: PlanEvaluation;
  budgetDiagnostic?: {
    status: BudgetStatus;
    minimumReference?: number;
    highReference?: number;
    reason: string;
    searchComplete: boolean;
    kind?:
      | 'missing_products'
      | 'known_conflict'
      | 'search_insufficient'
      | 'budget_gap';
  };
};
export type PlanSuggestion = {
  id: string;
  planId: string;
  category: Category;
  oldProductId: string;
  candidateProductId: string;
  summary: string;
  valid: boolean;
  reason?: string;
};
export type PlanEvaluation = {
  knowledgeStatus?: 'available' | 'unavailable';
  knowledgeNotice?: string;
  planId: string;
  issues: string[];
  directions: string[];
  suggestions: PlanSuggestion[];
  evidence?: Evidence[];
  createdAt: number;
};
export type Catalog = { parts: Part[]; prebuilts: Prebuilt[] };
export type MonitorCatalog = { monitors: Monitor[] };
export type SupportCase = {
  status: 'active' | 'stopped' | 'resolved' | 'handoff_requested';
  selfServiceStopped?: true;
  symptom: string;
  currentStepId?: string;
  history: { messageId: string; report: string; stepId?: string }[];
};
export type TaskDraft = Partial<Requirements> & {
  support?: SupportCase;
  zeroBudgetPromptMessageId?: string;
  zeroBudgetConfirmed?: boolean;
};
export type PcTask = {
  id: string;
  name: string;
  draft: TaskDraft;
  result: RecommendationResult | null;
  issues: string[];
  version: number;
  updatedAt: number;
};
export type TaskSummary = Pick<
  PcTask,
  'id' | 'name' | 'version' | 'updatedAt'
> & { purpose?: string; budget?: number };
