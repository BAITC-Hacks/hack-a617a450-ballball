import { session, view, locked, chat, checkOrigin, friendlyError } from '../../../server/web/session.ts';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const body = await request.json();
    if (typeof body.message !== 'string') return Response.json({ error: 'Введите сообщение.' }, { status: 400 });
    const s = await session();
    return Response.json(await locked(s, async () => { await chat(s, body.message); return view(s); }));
  } catch (error) { return Response.json({ error: friendlyError(error) }, { status: 400 }); }
}
