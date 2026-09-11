import type { Part, Prebuilt } from '../../backend/domain/types';
import products from './products.json' with { type: 'json' };
import computers from './prebuilts.json' with { type: 'json' };
import { enrichInferredSpecs } from './inferred-specs';
// Real manufacturer models; all prices are merchant-authored catalog prices.
export const parts = enrichInferredSpecs(products as Part[]);
export const prebuilts = computers as Prebuilt[];
