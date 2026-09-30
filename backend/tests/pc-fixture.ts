import {
  labels,
  type Catalog,
  type Category,
  type Part,
  type PcTask,
} from '../domain/types';
import { completeRequirements } from '../agent/conversation-state';
import { assembleBuild } from '../services/recommend';
import type { ToolContext, ToolRuntime } from '../tools/types';
import { embeddingConfig } from './embedding-fixture';
import { addSyntheticThermalEvidence } from './thermal-fixture';
// 仅用于可重复验证的演示夹具，不进入商品数据库或生产推荐。
export function fixture() {
  const specs: Record<Category, Record<string, unknown>> = {
    cpu: { socket: 'AM5', ddr: 'DDR5' },
    gpu: { length: 300, thickness: 40, recommendedPsu: 650, connector: 'none' },
    memory: { ddr: 'DDR5', capacity: 32, sticks: 2, height: 30 },
    motherboard: {
      socket: 'AM5',
      ddr: 'DDR5',
      supportedCpus: ['cpu'],
      biosVerified: true,
      maxRam: 128,
      ramSlots: 4,
      form: 'ATX',
      m2: true,
    },
    psu: { watts: 750, form: 'ATX', length: 150 },
    case: {
      forms: ['ATX'],
      gpuLength: 400,
      gpuThickness: 80,
      coolerHeight: 170,
      psuForm: 'ATX',
      psuLength: 200,
    },
    storage: { interface: 'M.2 NVMe' },
    cooler: { sockets: ['AM5'], height: 150, ramClearance: 50 },
  };
  const base: Part[] = (Object.keys(labels) as Category[]).map((category) => ({
    id: category,
    category,
    categoryLabel: labels[category],
    brand: '测试品牌',
    name: `测试${labels[category]}`,
    price: 1000,
    color: '黑色',
    specs: specs[category],
    demo: true,
  }));
  const variant = (
    category: Category,
    id: string,
    price: number,
    overrides: Partial<Part> = {},
  ): Part => ({
    ...structuredClone(base.find((part) => part.category === category)!),
    id,
    name: id,
    price,
    ...overrides,
  });
  const catalog: Catalog = {
    parts: [
      ...base,
      variant('gpu', 'gpu-cheaper', 950),
      variant('gpu', 'gpu-upper', 1050),
      variant('gpu', 'gpu-under-limit', 949),
      variant('gpu', 'gpu-over-limit', 1051),
      variant('gpu', 'gpu-too-long', 1000, {
        specs: { ...specs.gpu, length: 450 },
      }),
      variant('gpu', 'gpu-more-power', 1000, {
        specs: { ...specs.gpu, recommendedPsu: 900 },
      }),
      variant('psu', 'psu-1000', 1000, {
        specs: { ...specs.psu, watts: 1000 },
      }),
      variant('gpu', 'gpu-white', 1000, { color: '白色' }),
      variant('storage', 'storage-cheaper', 900),
      variant('case', 'case-premium', 2000),
    ],
    prebuilts: [],
  };
  const draft = completeRequirements({
    budget: 8000,
    budgetTolerance: 50,
    purpose: '游戏',
    mode: 'diy',
    color: '黑色',
  });
  addSyntheticThermalEvidence(catalog.parts);
  const plans = ['gpu-cheaper', 'gpu', 'gpu-upper'].map((gpuId, index) => ({
    ...assembleBuild(
      base.map((part) => (part.category === 'gpu' ? gpuId : part.id)),
      draft,
      catalog.parts,
    ),
    id: `plan-${index}`,
    tier: (['低价方案', '均衡方案', '高价方案'] as const)[index],
  }));
  const task: PcTask = {
    id: 'task',
    name: '测试主机',
    draft,
    result: {
      requirements: draft,
      plans: structuredClone(plans),
      summary: '三套测试候选',
    },
    issues: [],
    version: 1,
    updatedAt: 1,
  };
  const runtime: ToolRuntime = {
    task,
    draft: structuredClone(draft),
    result: structuredClone(task.result),
    approvedPartIds: new Set(),
    toolsUsed: [],
    toolErrors: [],
    facts: [],
    contextChanged: false,
  };
  const saved: PcTask[] = [];
  const context: ToolContext = {
    embeddingConfig,
    sessionId: 'session',
    taskId: 'task',
    currentMessageId: 'current',
    messages: [
      { id: 'current', role: 'user', content: '当前测试请求', taskId: 'task' },
    ],
    tasks: [],
    catalog,
    reloadCatalog: async () => catalog,
    onTaskChange: async () => {},
    onUpdate: async (_type, nextDraft, result) => {
      const version = saved.length + 2;
      saved.push(
        structuredClone({ ...task, draft: nextDraft, result, version }),
      );
      return version;
    },
  };
  return { runtime, context, catalog, saved };
}
