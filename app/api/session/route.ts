import { database } from '@/backend/db/catalog';
import { sessionId, json } from '@/backend/api/http';
import { stripLegacyFps } from '@/backend/domain/sanitize';
export async function GET(request: Request) {
  try {
    const row = await database()
      .prepare('SELECT requirements,plans FROM sessions WHERE id=?')
      .bind(sessionId(request))
      .first<{ requirements: string; plans: string }>();
    return json(
      row
        ? {
            requirements: JSON.parse(row.requirements),
            plans: stripLegacyFps(JSON.parse(row.plans)),
          }
        : null,
    );
  } catch {
    return json(null);
  }
}
