import type { Part, Requirements } from '../domain/types';

export const colorCategories = [
  'gpu',
  'memory',
  'motherboard',
  'psu',
  'case',
  'cooler',
] as const;

export function isColorCategory(category: string) {
  return colorCategories.some((item) => item === category);
}

export function requiredPartColor(
  part: Part,
  requirements: Pick<Requirements, 'color' | 'partColors'>,
) {
  if (!isColorCategory(part.category)) return undefined;
  return requirements.partColors?.[part.category] ?? requirements.color;
}
export function matchesRequirementColor(
  part: Part,
  requirements: Pick<Requirements, 'color' | 'partColors' | 'excludedColors'>,
  catalog?: Part[],
) {
  if (
    isColorCategory(part.category) &&
    requirements.excludedColors?.some((color) => part.color.includes(color))
  )
    return false;
  return matchesPartColor(part, requiredPartColor(part, requirements), catalog);
}

// 整套配色约束覆盖有外观颜色的六类配件，CPU 和硬盘不参与配色。
export function matchesPartColor(part: Part, color?: string, catalog?: Part[]) {
  if (!color || color === '不限' || !isColorCategory(part.category))
    return true;
  if (color === '黑色优先，白色备选') {
    // 服务端用完整目录决定该类别能否回退；前端仅检查候选配色，不推断目录缺项。
    if (!catalog)
      return part.color.includes('黑色') || part.color.includes('白色');
    const hasBlack = catalog.some(
      (item) => item.category === part.category && item.color.includes('黑色'),
    );
    return hasBlack ? part.color.includes('黑色') : part.color === '白色';
  }
  return color === '白色' ? part.color === '白色' : part.color.includes(color);
}
