import { session, view } from '../../../server/web/session.ts';
export const runtime = 'nodejs';
export async function GET() {
  try { return Response.json(view(await session())); } catch { return Response.json({ error: 'Сервис временно недоступен. Попробуйте позже.' }, { status: 503 }); }
}
