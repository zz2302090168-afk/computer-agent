import type { Progress } from '../backend/agent/progress';

export function updateProgress(
  items: Progress[],
  incoming: Progress,
): Progress[] {
  if (incoming.invalidatePlans)
    return [
      incoming,
      ...items
        .filter((item) => item.scope !== 'main')
        .map(
          (item): Progress => ({
            ...item,
            plan: undefined,
            status: 'error',
            label: '候选已撤回，等待重新审核',
          }),
        ),
    ];
  if (incoming.branches)
    return [
      incoming,
      ...incoming.branches.map(
        (branch): Progress => ({
          ...branch,
          generationId: incoming.generationId,
          label: '等待独立选型',
          status: 'running',
          phase: 'select',
        }),
      ),
    ];
  const generation = items.find((item) => item.generationId)?.generationId;
  if (
    incoming.generationId &&
    generation &&
    incoming.generationId !== generation
  )
    return items;
  const index = items.findIndex((item) => item.scope === incoming.scope);
  if (index < 0) return [...items, incoming];
  return items.map((item, position) => (position === index ? incoming : item));
}
