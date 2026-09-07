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
  brandPreferences?:Partial<Record<Category,string>>;
  partPreferences?:Partial<Record<Category,string>>;
  seriesPreferences?:Partial<Record<Category,string>>;
  selectionAuthorizations?:Partial<Record<Category,string>>;
  selectionSources?:Partial<Record<Category,'user'|'assistant'|'confirmed'>>;
  partSelections?:Partial<Record<Category,string>>;
  preferCheaper?:boolean;
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
export type PcTask={id:string;name:string;draft:Partial<Requirements>;result:RecommendationResult|null;issues:string[];version:number;updatedAt:number};
export type TaskSummary=Pick<PcTask,'id'|'name'|'version'|'updatedAt'> & {purpose?:string;budget?:number};
