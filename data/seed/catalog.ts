import {
  labels,
  type Part,
  type Prebuilt,
  type Category,
} from '../../backend/domain/types';
// Synthetic merchant catalog. All names, specifications, ranking tiers and prices are demonstrations.
// No manufactured real-world specifications or benchmark claims are attached to actual brands.
export const parts: Part[] = [];
function add(
  category: Category,
  i: number,
  name: string,
  price: number,
  specs: Record<string, unknown>,
  color = '不适用',
) {
  parts.push({
    id: `${category}-${i}`,
    category,
    categoryLabel: labels[category],
    brand: '星构 DEMO',
    name,
    color,
    price,
    specs,
    demo: true,
  });
}
for (let i = 0; i < 20; i++) {
  const tier = Math.floor(i / 2) + 1,
    white = i % 2 === 1,
    color = white ? '白色' : '黑色';
  const socket = white ? 'DEMO-B' : 'DEMO-A',
    ddr = white ? 'DDR5' : 'DDR4';
  add('cpu', i, `${white ? 'B' : 'A'}${tier} 处理器`, 300 + tier * tier * 42, {
    socket,
    ddr,
    tier,
    cores: 4 + tier * 2,
    power: 45 + tier * 12,
  });
  add(
    'gpu',
    i,
    `G${tier} ${tier < 4 ? 8 : tier < 8 ? 16 : 24}GB`,
    500 + tier * tier * 100,
    {
      tier,
      vram: tier < 4 ? 8 : tier < 8 ? 16 : 24,
      power: 70 + tier * 24,
      length: 220 + tier * 9,
      slots: tier < 6 ? 2 : 3,
      connector: 'PCIe 8pin',
      connectors: tier < 6 ? 1 : 2,
    },
    color,
  );
  add(
    'motherboard',
    i,
    `${white ? 'B' : 'A'}${tier} 主板`,
    250 + tier * 80,
    {
      socket,
      ddr,
      tier,
      form: 'mATX',
      ramSlots: 4,
      maxRam: 128,
      m2: true,
      supportedCpus: Array.from(
        { length: 10 },
        (_, n) => `cpu-${n * 2 + (white ? 1 : 0)}`,
      ),
      biosVerified: true,
    },
    '黑色',
  );
  add(
    'memory',
    i,
    `${ddr} ${tier < 4 ? 16 : tier < 8 ? 32 : 64}GB 双条套装`,
    110 + tier * 65,
    {
      ddr,
      tier,
      capacity: tier < 4 ? 16 : tier < 8 ? 32 : 64,
      sticks: 2,
      height: 35,
    },
    color,
  );
  add(
    'psu',
    i,
    `P${tier} ${400 + tier * 100}W`,
    160 + tier * 65,
    {
      tier,
      watts: 400 + tier * 100,
      connector: 'PCIe 8pin',
      connectors: 4,
      form: 'ATX',
      length: 150,
      eps: 2,
    },
    color,
  );
  add(
    'case',
    i,
    `C${tier} 机箱`,
    110 + tier * 65,
    {
      tier,
      forms: ['mATX', 'ATX'],
      gpuLength: 340 + tier * 5,
      gpuSlots: 4,
      coolerHeight: 165,
      psuForm: 'ATX',
      psuLength: 200,
      ramClearance: 45,
    },
    color,
  );
  add(
    'storage',
    i,
    `S${tier} ${tier < 3 ? 512 : tier < 7 ? 1024 : 2048}GB NVMe`,
    140 + tier * 60 + (white ? 20 : 0),
    {
      tier,
      capacity: tier < 3 ? 512 : tier < 7 ? 1024 : 2048,
      interface: 'M.2 NVMe',
      length: 80,
    },
    '不适用',
  );
  add(
    'cooler',
    i,
    `T${tier} 塔式散热`,
    60 + tier * 38,
    {
      tier,
      sockets: ['DEMO-A', 'DEMO-B'],
      height: 150,
      capacity: 100 + tier * 20,
      ramClearance: 40,
    },
    color,
  );
}
export const prebuilts: Prebuilt[] = Array.from({ length: 20 }, (_, i) => {
  const selected = Object.keys(labels).map((c) =>
    parts.find((p) => p.id === `${c}-${i}`)!,
  );
  return {
    id: `pc-${i}`,
    name: `星构 ${Math.floor(i / 2) + 1} 号整机`,
    brand: '星构 DEMO',
    color: i % 2 ? '白色' : '黑色',
    price: selected.reduce((s, p) => s + p.price, 0) + 150,
    partIds: selected.map((p) => p.id),
    demo: true,
  };
});
