export const embeddingConfig = {
  key: 'test',
  base: 'https://embedding.test/v1',
  model: 'test-embedding',
};

const concepts = [
  ['无信号', '黑屏', '显示器'],
  ['不开机', '不通电', '电源'],
  ['断网', 'WiFi', '网络'],
  ['DDR4', 'DDR5', '内存', '主板'],
  ['预算', '价格', '总价'],
  ['过热', '温度', '噪声'],
  ['蓝屏', '重启', '死机'],
] as const;

function vector(text: string) {
  return [
    ...concepts.map((words) =>
      words.reduce((count, word) => count + Number(text.includes(word)), 0),
    ),
    1,
  ];
}

export async function embeddingFetch(_url: unknown, options?: RequestInit) {
  const body = JSON.parse(options?.body as string) as { input: string[] };
  return Response.json({
    object: 'list',
    data: body.input.map((text, index) => ({
      object: 'embedding',
      index,
      embedding: vector(text),
    })),
  });
}
