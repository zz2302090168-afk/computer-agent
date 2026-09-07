import type { Requirements } from '../domain/types';
import { budgetRange } from '../rules/budget';
export function parseRequirements(value: unknown): Requirements {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('请求必须是 JSON 对象');
  const input = value as Record<string, unknown>;
  const text = (v: unknown, fallback = '') =>
    typeof v === 'string' ? v : fallback;
  const message = text(input.message).slice(0, 2000);
  let budget = Number(input.budget),
    purpose = text(input.purpose),
    mode = text(input.mode, 'both'),
    color = text(input.color, '不限');
  const match = message.match(
    /(?:预算|最多|不超过|上限|控制在)\s*(\d+(?:\.\d+)?)\s*(万|千|k)?/i,
  );
  if (match)
    budget =
      Number(match[1]) *
      (match[2] === '万' ? 10000 : /千|k/i.test(match[2] ?? '') ? 1000 : 1);
  if (/办公|文档/.test(message)) purpose = '办公';
  if (/游戏|CS2|黑神话|赛博朋克|瓦罗兰特/i.test(message)) purpose = '游戏';
  if (/剪辑|设计/.test(message)) purpose = '剪辑设计';
  if (/编程|开发/.test(message)) purpose = '编程';
  if (/本地\s*AI|大模型|显存/i.test(message)) purpose = '本地 AI';
  if (/白色/.test(message)) color = '白色';
  else if (/黑色/.test(message)) color = '黑色';
  if (/整机/.test(message)) mode = 'prebuilt';
  if (/DIY|自己装|自由搭配/i.test(message)) mode = 'diy';
  if (!['diy', 'prebuilt', 'both'].includes(mode)) throw Error('购买方式无效');
  if (!['不限', '黑色', '白色'].includes(color)) throw Error('颜色选项无效');
  if (!['游戏', '办公', '剪辑设计', '编程', '本地 AI'].includes(purpose))
    throw Error('请先选择主要用途');
  const hardCap =
    input.hardCap === true || /最多|不超过|上限|不能超|不要超/.test(message);
  budgetRange(budget, hardCap);
  return {
    budget,
    purpose,
    mode: mode as Requirements['mode'],
    color,
    message,
    hardCap,
    brand: text(input.brand),
    game: message.match(/CS2|黑神话|赛博朋克|瓦罗兰特/i)?.[0] ?? '',
  };
}
