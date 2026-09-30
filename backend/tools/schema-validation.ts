import { parseObject } from './types';

// 本项目工具Schema子集的前置检查；不替代工具内部的权限、数据库和业务审核。
// 未支持的约束拒绝直执行，交给既有工具循环处理，不能悄悄忽略。
export function validateToolArguments(
  value: unknown,
  rawSchema: unknown,
  path = 'args',
): void {
  const schema = parseObject(rawSchema);
  const supported = [
    'type',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'enum',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'minItems',
    'maxItems',
    'description',
  ];
  if (Object.keys(schema).some((key) => !supported.includes(key)))
    throw Error(`${path}含未支持的参数约束`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value))
    throw Error(`${path}枚举值无效`);
  switch (schema.type) {
    case 'object': {
      const input = parseObject(value);
      const properties = parseObject(schema.properties ?? {});
      for (const key of (schema.required ?? []) as string[])
        if (!(key in input)) throw Error(`${path}缺少${key}`);
      for (const [key, child] of Object.entries(input)) {
        if (!(key in properties)) throw Error(`${path}包含未知字段${key}`);
        validateToolArguments(child, properties[key], `${path}.${key}`);
      }
      break;
    }
    case 'array':
      if (!Array.isArray(value)) throw Error(`${path}必须是数组`);
      if (
        (typeof schema.minItems === 'number' &&
          value.length < schema.minItems) ||
        (typeof schema.maxItems === 'number' && value.length > schema.maxItems)
      )
        throw Error(`${path}数组长度无效`);
      value.forEach((child, index) =>
        validateToolArguments(child, schema.items, `${path}[${index}]`),
      );
      break;
    case 'number':
    case 'integer':
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (schema.type === 'integer' && !Number.isInteger(value)) ||
        (typeof schema.minimum === 'number' && value < schema.minimum) ||
        (typeof schema.maximum === 'number' && value > schema.maximum) ||
        (typeof schema.exclusiveMinimum === 'number' &&
          value <= schema.exclusiveMinimum)
      )
        throw Error(`${path}数值无效`);
      break;
    case 'string':
    case 'boolean':
      if (typeof value !== schema.type) throw Error(`${path}类型无效`);
      break;
    default:
      throw Error(`${path}参数类型未支持`);
  }
}
