export type Benchmark = {
  cpuId: string;
  gpuId: string;
  memoryId: string;
  game: string;
  gameVersion: string;
  driver: string;
  resolution: string;
  preset: string;
  rayTracing: boolean;
  upscaling: string;
  frameGeneration: boolean;
  scene: string;
  fps: number;
  source: string;
  testedAt: string;
};
export type Conditions = Pick<
  Benchmark,
  | 'cpuId'
  | 'gpuId'
  | 'memoryId'
  | 'game'
  | 'gameVersion'
  | 'driver'
  | 'resolution'
  | 'preset'
  | 'rayTracing'
  | 'upscaling'
  | 'frameGeneration'
  | 'scene'
>;
export function matchBenchmarks(conditions: Conditions, records: Benchmark[]) {
  const matching = records.filter(
    (r) =>
      Object.entries(conditions).every(
        ([k, v]) => r[k as keyof Benchmark] === v,
      ) &&
      Number.isFinite(r.fps) &&
      r.fps > 0 &&
      r.source.startsWith('https://') &&
      r.testedAt,
  );
  if (!matching.length)
    return {
      status: 'insufficient',
      message: '没有同配置、同条件的可追溯测试；不生成 FPS 数字。',
    };
  const fps = matching.map((r) => r.fps);
  return {
    status: 'measured',
    range: [Math.min(...fps), Math.max(...fps)],
    message: '同条件实测范围，不是预测置信区间。',
    sources: [...new Set(matching.map((r) => r.source))],
  };
}
