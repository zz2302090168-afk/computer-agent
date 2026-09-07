import type { Part, Prebuilt, Requirements } from '../domain/types';
import {matchBenchmarks,type Conditions} from '../performance/estimate';
import {benchmarks} from '../../data/benchmarks/records';
export { validateBuild as validate_build } from '../rules/compatibility';
export { retrieveKnowledge as retrieve_knowledge } from '../rag/retrieve';
export function search_parts(
  parts: Part[],
  filter: {
    category?: string;
    brand?: string;
    color?: string;
    maxPrice?: number;
  },
) {
  return parts.filter(
    (p) =>
      (!filter.category || p.category === filter.category) &&
      (!filter.brand || p.brand.includes(filter.brand)) &&
      (!filter.color || filter.color === '不限' || p.color === filter.color) &&
      (!filter.maxPrice || p.price <= filter.maxPrice),
  );
}
export function search_prebuilt_pcs(pcs: Prebuilt[], r: Requirements) {
  return pcs.filter(
    (p) =>
      (r.color === '不限' || p.color === r.color) &&
      (!r.brand || p.brand.includes(r.brand)),
  );
}
export function calculate_quote(ids: string[], catalog: Part[]) {
  if (new Set(ids).size !== ids.length) throw Error('商品重复');
  return ids.reduce((s, id) => {
    const p = catalog.find((p) => p.id === id);
    if (!p || !Number.isFinite(p.price) || p.price < 0)
      throw Error('商品不存在或报价无效');
    return s + p.price;
  }, 0);
}
export function estimate_fps(parts: Part[], game: string,conditions?:Omit<Conditions,'cpuId'|'gpuId'|'memoryId'|'game'>) {
  if(!parts.some(p=>p.demo)&&conditions){
    const find=(category:string)=>parts.find(p=>p.category===category)?.id??'';
    return matchBenchmarks({...conditions,cpuId:find('cpu'),gpuId:find('gpu'),memoryId:find('memory'),game},benchmarks);
  }
  return {
    message: parts.some((p) => p.demo)
      ? 'FPS 暂不提供：当前是演示型号，没有对应的真实游戏测试。'
      : `FPS 资料不足：尚未匹配 ${game || '指定游戏'} 的同配置、同画质实测。`,
    range: undefined,
  };
}
