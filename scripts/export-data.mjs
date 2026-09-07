import './register-typescript.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
const { parts, prebuilts } = await import('../data/seed/catalog.ts');
const { knowledge } = await import('../knowledge/library.ts');
await writeFile('data/seed/products.json', JSON.stringify(parts, null, 2));
await writeFile('data/seed/prebuilts.json', JSON.stringify(prebuilts, null, 2));
for (const k of knowledge) {
  await mkdir(`knowledge/${k.category}`, { recursive: true });
  await writeFile(
    `knowledge/${k.category}/${k.id}.md`,
    `# ${k.title}\n\n知识ID: ${k.id}\n核对日期: ${k.checkedAt}\n类型: ${k.kind}\n\n${k.content}\n\n来源: ${k.source ?? '本项目设计策略，不作为厂家规格或实测依据'}\n`,
  );
}
console.log('已导出 160 个配件、20 台整机、10 篇知识文档。');
