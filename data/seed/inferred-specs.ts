import type { Part } from '../../backend/domain/types';
import source from './products.json' with { type: 'json' };

type Provenance = { origin?: unknown; status?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const sourceById = new Map((source as Part[]).map((part) => [part.id, part]));

// 旧库不重导 seed 时，只补上缺失的推定字段；商家后来填入的型号规格永远优先。
export function enrichInferredSpecs(parts: Part[]): Part[] {
  return parts.map((part) => {
    const reference = sourceById.get(part.id);
    const referenceProvenance = reference?.specs.provenance;
    if (!reference || !isRecord(referenceProvenance)) return part;
    const specs = { ...part.specs };
    const provenance = isRecord(specs.provenance)
      ? { ...specs.provenance }
      : {};
    const inferredFields = new Set(
      Array.isArray(specs.inferredFields) ? specs.inferredFields : [],
    );
    let changed = false;
    for (const [field, value] of Object.entries(referenceProvenance)) {
      if (!isRecord(value)) continue;
      const entry = value as Provenance;
      if (entry.origin === 'synthetic' && entry.status === 'inferred') {
        if (specs[field] !== undefined) continue;
        specs[field] = reference.specs[field];
        provenance[field] = value;
        inferredFields.add(field);
        changed = true;
      } else if (
        field === 'biosVerified' &&
        specs.biosVerified !== true &&
        provenance[field] === undefined
      ) {
        provenance[field] = value;
        changed = true;
      }
    }
    if (!changed) return part;
    specs.provenance = provenance;
    if (inferredFields.size) specs.inferredFields = [...inferredFields];
    return { ...part, specs };
  });
}
