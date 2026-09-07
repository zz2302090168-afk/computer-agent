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
export type Requirements = {
  budget: number;
  hardCap: boolean;
  purpose: string;
  mode: 'diy' | 'prebuilt' | 'both';
  color: string;
  message: string;
  brand: string;
  game: string;
};
export type Validation = {
  status: 'pass' | 'fail' | 'unknown';
  issues: string[];
};
export type Plan = {
  id: string;
  kind: 'diy' | 'prebuilt';
  name: string;
  parts: Part[];
  total: number;
  validation: Validation;
  reason: string;
  fps: { message: string; range?: number[] };
  score: number;
};
export type Evidence = {
  id: string;
  title: string;
  content: string;
  source: string | null;
  checkedAt: string;
};
export type RecommendationResult = {
  requirements: Requirements;
  plans: Plan[];
  summary: string;
  evidence?: Evidence[];
  explanation?: string | null;
  modelStatus?: string;
};
export type Catalog = { parts: Part[]; prebuilts: Prebuilt[] };
