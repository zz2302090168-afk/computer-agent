import type { Part, Prebuilt } from '../../backend/domain/types';
import products from './products.json' with { type: 'json' };
import computers from './prebuilts.json' with { type: 'json' };
import { enrichInferredSpecs } from './inferred-specs';
// 真实型号参考厂家资料；新增演示记录的估价与推定规格明确标记，原商家数据保留。
export const parts = enrichInferredSpecs(products as Part[]);
export const prebuilts = computers as Prebuilt[];
