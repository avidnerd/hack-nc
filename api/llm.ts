/**
 * Server-side door to the LLM for the hosted build. The browser posts
 * `{ system, user }` here instead of calling Gemini itself, so the API key
 * stays in Vercel's environment (GEMINI_KEY) and never reaches the page.
 *
 * Same contract as src/ai/llm.ts: plain text out, temperature 0, 256 tokens.
 * Requests are capped in size and limited to this site's own pages so the
 * endpoint is not a free general-purpose Gemini proxy.
 */

export const config = { runtime: 'edge' };

const MAX_SYSTEM = 8000;
const MAX_USER = 4000;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const origin = req.headers.get('origin');
  if (origin && new URL(origin).host !== new URL(req.url).host) return json({ error: 'forbidden' }, 403);

  const key = process.env.GEMINI_KEY;
  if (!key) return json({ error: 'llm not configured' }, 503);

  let body: { system?: unknown; user?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad json' }, 400);
  }
  const { system, user } = body;
  if (typeof system !== 'string' || typeof user !== 'string' || system.length > MAX_SYSTEM || user.length > MAX_USER) {
    return json({ error: 'bad request' }, 400);
  }

  const model = process.env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite';
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        // DECISION: flash-lite at minimal thinking answers in ~0.5 s; the
        // full flash models took 3 to 11 s, past the client's 1500 ms limit.
        generationConfig: { temperature: 0, maxOutputTokens: 256, thinkingConfig: { thinkingLevel: 'minimal' } },
      }),
    },
  );
  if (!res.ok) return json({ error: `gemini ${res.status}` }, 502);
  const out = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = out.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? null;
  return json({ text });
}
