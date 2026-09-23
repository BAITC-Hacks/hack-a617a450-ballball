import { session, view, locked, cartAction, checkOrigin, friendlyError } from '../../../server/web/session.ts';
export const runtime = 'nodejs';
export async function GET() {
  try { return Response.json(view(await session())); } catch { return Response.json({ error: 'Не удалось загрузить корзину.' }, { status: 503 }); }
}
export async function POST(request: Request) {
  try { checkOrigin(request); const body = await request.json(); const s = await session(); return Response.json(await locked(s, () => cartAction(s, body))); }
  catch (error) { return Response.json({ error: friendlyError(error) }, { status: 400 }); }
}
