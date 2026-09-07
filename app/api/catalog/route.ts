import { loadCatalog } from '@/backend/db/catalog';
import { json } from '@/backend/api/http';
export async function GET() {
  try {
    return json(await loadCatalog());
  } catch {
    return json({ error: '商品数据库尚未初始化，请运行数据库迁移。' }, 503);
  }
}
