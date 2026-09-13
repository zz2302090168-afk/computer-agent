import { labels, type Catalog, type Category } from '../domain/types';

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error(`${label}必须是对象`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maxLength: number) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    !value.isWellFormed() ||
    Array.from(value).length > maxLength
  )
    throw Error(`${label}必须是非空文本，最多 ${maxLength} 个字符`);
  return value;
}

function price(value: unknown, label: string) {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 2147483647
  )
    throw Error(`${label}必须是 0～2147483647 之间的整数`);
  return value;
}

function demo(value: unknown, label: string) {
  if (typeof value !== 'boolean') throw Error(`${label}必须是布尔值`);
  return value;
}

function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && Object.hasOwn(labels, value);
}

function jsonText(value: unknown, label: string) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > 65535)
    throw Error(`${label}序列化后不能超过数据库 TEXT 字段的 65535 字节`);
  return serialized;
}

// 只验证导入数据与表结构；商家整机不执行 DIY 配件兼容性审核。
export function validateCatalogImport(value: unknown): Catalog {
  const input = record(value, '目录');
  if (!Array.isArray(input.parts) || !Array.isArray(input.prebuilts))
    throw Error('需要 parts 和 prebuilts 数组');
  const partIds = new Set<string>();
  const parts = input.parts.map((value: unknown, index: number) => {
    const row = record(value, `配件 ${index + 1}`);
    const id = text(row.id, `配件 ${index + 1} ID`, 191);
    if (partIds.has(id)) throw Error(`配件 ID 重复：${id}`);
    partIds.add(id);
    if (!isCategory(row.category)) throw Error(`配件 ${id} 类别无效`);
    const specs = record(row.specs, `配件 ${id} 规格`);
    jsonText(specs, `配件 ${id} 规格`);
    return {
      id,
      category: row.category,
      categoryLabel: labels[row.category],
      brand: text(row.brand, `配件 ${id} 品牌`, 191),
      name: text(row.name, `配件 ${id} 名称`, 255),
      color: text(row.color, `配件 ${id} 颜色`, 32),
      price: price(row.price, `配件 ${id} 价格`),
      specs,
      demo: demo(row.demo, `配件 ${id} demo`),
    };
  });
  const byId = new Map(parts.map((part) => [part.id, part]));
  const prebuiltIds = new Set<string>();
  const prebuilts = input.prebuilts.map((value: unknown, index: number) => {
    const row = record(value, `整机 ${index + 1}`);
    const id = text(row.id, `整机 ${index + 1} ID`, 191);
    if (prebuiltIds.has(id)) throw Error(`整机 ID 重复：${id}`);
    prebuiltIds.add(id);
    if (
      !Array.isArray(row.partIds) ||
      row.partIds.length !== Object.keys(labels).length
    )
      throw Error(`整机 ${id} 必须引用八类完整且不重复的商品`);
    const selectedIds = row.partIds.map((value: unknown) =>
      text(value, `整机 ${id} 配件 ID`, 191),
    );
    const categories = new Set<Category>();
    for (const partId of selectedIds) {
      const part = byId.get(partId);
      if (!part) throw Error(`整机 ${id} 引用的配件不存在：${partId}`);
      categories.add(part.category);
    }
    if (
      new Set(selectedIds).size !== Object.keys(labels).length ||
      categories.size !== Object.keys(labels).length
    )
      throw Error(`整机 ${id} 必须引用八类完整且不重复的商品`);
    return {
      id,
      name: text(row.name, `整机 ${id} 名称`, 255),
      brand: text(row.brand, `整机 ${id} 品牌`, 191),
      color: text(row.color, `整机 ${id} 颜色`, 32),
      price: price(row.price, `整机 ${id} 价格`),
      partIds: selectedIds,
      demo: demo(row.demo, `整机 ${id} demo`),
    };
  });
  return { parts, prebuilts };
}

// 十六进制中没有引号、反斜杠或控制字符，不受 NO_BACKSLASH_ESCAPES 影响。
const sqlText = (value: string) =>
  `CONVERT(X'${Buffer.from(value, 'utf8').toString('hex')}' USING utf8mb4)`;

export function buildCatalogImportSql(value: unknown) {
  const { parts, prebuilts } = validateCatalogImport(value);
  return [
    'START TRANSACTION;',
    'DELETE FROM prebuilts;',
    'DELETE FROM products;',
    ...parts.map(
      (part) =>
        `INSERT INTO products(id,category,brand,name,color,price,specs,demo) VALUES(${[
          sqlText(part.id),
          sqlText(part.category),
          sqlText(part.brand),
          sqlText(part.name),
          sqlText(part.color),
          part.price,
          sqlText(jsonText(part.specs, `配件 ${part.id} 规格`)),
          part.demo ? 1 : 0,
        ].join(',')});`,
    ),
    ...prebuilts.map(
      (pc) =>
        `INSERT INTO prebuilts(id,name,brand,color,price,part_ids,demo) VALUES(${[
          sqlText(pc.id),
          sqlText(pc.name),
          sqlText(pc.brand),
          sqlText(pc.color),
          pc.price,
          sqlText(jsonText(pc.partIds, `整机 ${pc.id} 配件 ID`)),
          pc.demo ? 1 : 0,
        ].join(',')});`,
    ),
    "REPLACE INTO metadata(`key`,`value`) VALUES('real-catalog-v2','merchant-import');",
    'COMMIT;',
  ].join('\n');
}
