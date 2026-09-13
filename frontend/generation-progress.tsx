import type { Progress } from '@/backend/agent/progress';

const stages = {
  prepare: '准备候选',
  select: '筛选配件',
  adjust: '调整组合',
  audit: '审核配置',
  complete: '审核完成',
};
export default function GenerationProgress({ items }: { items: Progress[] }) {
  const branches = items.filter(
    (item) => item.generationId && item.scope !== 'main',
  );
  const current = items.find((item) => item.scope === 'main');
  const ready = branches.filter((item) => item.status === 'done').length;
  const active = [...branches]
    .reverse()
    .find((item) => item.status === 'running');
  const status = active
    ? `${active.tier ?? '候选方案'} · ${stages[active.phase ?? 'select']} · ${active.label}`
    : (current?.label ?? '正在处理需求');
  return (
    <output className="generation-progress" aria-live="polite">
      <span aria-hidden="true" />
      {branches.length ? '正在生成' : '正在处理'}：{status}
      {branches.length > 0 && ` · ${ready}/${branches.length} 套已完成`}
    </output>
  );
}
