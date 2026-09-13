import type {
  Monitor,
  MonitorCatalog,
  MonitorCriteria,
  MonitorPurpose,
  MonitorRecommendation,
} from '../domain/types';

const resolutions = ['1080p', '1440p', '4K'] as const;
const panels = ['IPS', 'VA', 'OLED', 'MiniLED'] as const;
const purposes = ['办公', '游戏', '剪辑设计', '综合'] as const;

export function validateMonitorCriteria(value: unknown): MonitorCriteria {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('显示器筛选条件无效');
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    'budget',
    'resolution',
    'panel',
    'minRefreshRate',
    'purpose',
  ]);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw Error(`显示器筛选条件包含未知字段：${unknown}`);
  const criteria: MonitorCriteria = {};
  if (input.budget !== undefined) {
    if (
      typeof input.budget !== 'number' ||
      !Number.isInteger(input.budget) ||
      input.budget < 200 ||
      input.budget > 5000
    )
      throw Error('显示器预算必须是 200 到 5000 元的整数');
    criteria.budget = input.budget;
  }
  if (input.resolution !== undefined) {
    if (!resolutions.includes(input.resolution as (typeof resolutions)[number]))
      throw Error('显示器分辨率仅支持 1080p、1440p 或 4K');
    criteria.resolution = input.resolution as MonitorCriteria['resolution'];
  }
  if (input.panel !== undefined) {
    if (!panels.includes(input.panel as (typeof panels)[number]))
      throw Error('显示器面板类型无效');
    criteria.panel = input.panel as MonitorCriteria['panel'];
  }
  if (input.minRefreshRate !== undefined) {
    if (
      typeof input.minRefreshRate !== 'number' ||
      !Number.isInteger(input.minRefreshRate) ||
      input.minRefreshRate < 60 ||
      input.minRefreshRate > 320
    )
      throw Error('最低刷新率必须是 60 到 320Hz 的整数');
    criteria.minRefreshRate = input.minRefreshRate;
  }
  if (input.purpose !== undefined) {
    if (!purposes.includes(input.purpose as MonitorPurpose))
      throw Error('显示器用途无效');
    criteria.purpose = input.purpose as MonitorPurpose;
  }
  return criteria;
}

function assertCatalog(monitors: Monitor[]) {
  for (const monitor of monitors) {
    const { specs } = monitor;
    if (
      !monitor.id ||
      !monitor.brand ||
      !monitor.name ||
      !Number.isInteger(monitor.price) ||
      monitor.price < 200 ||
      monitor.price > 5000 ||
      !resolutions.includes(specs.resolution) ||
      !panels.includes(specs.panel) ||
      !Number.isInteger(specs.refreshRate) ||
      specs.refreshRate < 60 ||
      specs.refreshRate > 320
    )
      throw Error(`显示器目录商品 ${monitor.id} 的基础数据无效`);
  }
}

function purposeScore(monitor: Monitor, purpose: MonitorPurpose | undefined) {
  if (!purpose || purpose === '综合') return 0;
  const { resolution, panel, refreshRate } = monitor.specs;
  if (purpose === '游戏')
    return (
      refreshRate * 4 +
      (resolution === '1440p' ? 120 : resolution === '4K' ? 90 : 40) +
      (panel === 'OLED' ? 80 : panel === 'MiniLED' ? 45 : 0)
    );
  if (purpose === '剪辑设计')
    return (
      (resolution === '4K' ? 260 : resolution === '1440p' ? 110 : 0) +
      (panel === 'OLED' || panel === 'MiniLED' ? 80 : 25) +
      Math.min(refreshRate, 120)
    );
  return (
    (resolution === '4K' ? 170 : resolution === '1440p' ? 100 : 30) +
    (panel === 'IPS' ? 45 : panel === 'MiniLED' ? 35 : 0) -
    Math.max(0, refreshRate - 120) / 4
  );
}

export function recommendMonitors(
  criteria: MonitorCriteria,
  catalog: MonitorCatalog,
): MonitorRecommendation {
  assertCatalog(catalog.monitors);
  const matches = catalog.monitors
    .filter((monitor) => !monitor.demo)
    .filter((monitor) =>
      criteria.budget === undefined ? true : monitor.price <= criteria.budget,
    )
    .filter((monitor) =>
      criteria.resolution === undefined
        ? true
        : monitor.specs.resolution === criteria.resolution,
    )
    .filter((monitor) =>
      criteria.panel === undefined
        ? true
        : monitor.specs.panel === criteria.panel,
    )
    .filter((monitor) =>
      criteria.minRefreshRate === undefined
        ? true
        : monitor.specs.refreshRate >= criteria.minRefreshRate,
    )
    .sort(
      (a, b) =>
        purposeScore(b, criteria.purpose) - purposeScore(a, criteria.purpose) ||
        b.specs.refreshRate - a.specs.refreshRate ||
        b.price - a.price ||
        a.id.localeCompare(b.id),
    )
    .slice(0, 3);
  return {
    criteria,
    catalogTotal: catalog.monitors.filter((monitor) => !monitor.demo).length,
    total: matches.length,
    monitors: matches,
    note: matches.length
      ? '显示器为独立外设推荐，未计入主机报价；目录价不是实时市场价，不承诺游戏帧率。未附厂家来源的规格待核实，不能视为已验证参数。'
      : '当前目录没有同时满足这些显示器条件的真实型号，请放宽面板、分辨率、刷新率或预算条件。',
  };
}
