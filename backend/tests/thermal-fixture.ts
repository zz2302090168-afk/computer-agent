import { labels, type Part, type Category } from '../domain/types';
import { thermalEvidenceKey } from '../rules/compatibility';

// 仅合成测试资料：逐组合生成核验记录，绝不写入真实商品数据库。
export function addSyntheticThermalEvidence(catalog: Part[]) {
  const combinations = (Object.keys(labels) as Category[]).reduce<Part[][]>(
    (rows, category) =>
      rows.flatMap((row) =>
        catalog
          .filter((part) => part.category === category)
          .map((part) => [...row, part]),
      ),
    [[]],
  );
  for (const box of catalog.filter((part) => part.category === 'case')) {
    box.specs.thermalAssessments = combinations
      .filter((parts) => parts.includes(box))
      .map((parts) => ({
        configurationKey: thermalEvidenceKey(parts),
        status: 'pass',
        verified: true,
        source: 'synthetic test evidence; not manufacturer data',
      }));
  }
}
