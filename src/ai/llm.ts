/**
 * The one door to a language model: `complete(system, user) -> string | null`.
 *
 * Used for exactly two things (§2): rescuing a voice command the regex grammar
 * missed, and rewording a finished narration. Never for geometry or numbers.
 * Hard 1500 ms timeout; every failure returns null and the caller falls back to
 * its template, so the app never waits on the network.
 */

const TIMEOUT_MS = 1500;

type Provider = 'gemini' | 'anthropic' | 'proxy' | 'off';

function provider(): Provider {
  const want = (import.meta.env.VITE_LLM ?? 'gemini').toLowerCase();
  if (want === 'off') return 'off';
  // The hosted build (scripts/build-web.mjs) ships no key; /api/llm holds it.
  if (want === 'proxy') return 'proxy';
  if (want === 'anthropic' && import.meta.env.VITE_ANTHROPIC_KEY) return 'anthropic';
  if (import.meta.env.VITE_GEMINI_KEY) return 'gemini';
  if (import.meta.env.VITE_ANTHROPIC_KEY) return 'anthropic';
  return 'off';
}

export function llmEnabled(): boolean {
  return provider() !== 'off';
}

export function llmName(): string {
  return provider();
}

export async function complete(system: string, user: string, timeoutMs = TIMEOUT_MS): Promise<string | null> {
  const p = provider();
  if (p === 'off') return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const text =
      p === 'proxy'
        ? await proxy(system, user, ctrl.signal)
        : p === 'gemini'
          ? await gemini(system, user, ctrl.signal)
          : await anthropic(system, user, ctrl.signal);
    console.info(`[llm] ${p} answered in ${(performance.now() - t0).toFixed(0)} ms`);
    return text;
  } catch (err) {
    console.warn(`[llm] ${p} failed after ${(performance.now() - t0).toFixed(0)} ms`, err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function proxy(system: string, user: string, signal: AbortSignal): Promise<string | null> {
  const res = await fetch('/api/llm', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ system, user }),
  });
  if (!res.ok) throw new Error(`proxy ${res.status}`);
  const json = (await res.json()) as { text?: string | null };
  return json.text ?? null;
}

async function gemini(system: string, user: string, signal: AbortSignal): Promise<string | null> {
  const key = import.meta.env.VITE_GEMINI_KEY as string;
  // gemini-2.5-flash is closed to new keys; see api/llm.ts for the latency pick.
  const model = (import.meta.env.VITE_GEMINI_MODEL as string | undefined) ?? 'gemini-3.5-flash-lite';
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 256, thinkingConfig: { thinkingLevel: 'minimal' } },
      }),
    },
  );
  if (!res.ok) throw new Error(`gemini ${res.status}`);
  const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  return json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? null;
}

async function anthropic(system: string, user: string, signal: AbortSignal): Promise<string | null> {
  const key = import.meta.env.VITE_ANTHROPIC_KEY as string;
  const model = (import.meta.env.VITE_ANTHROPIC_MODEL as string | undefined) ?? 'claude-haiku-5-5';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      // A hackathon demo calls the API straight from the page; a deployment
      // would proxy this through a server instead of shipping a key.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 256,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}`);
  const json = (await res.json()) as { content?: { type: string; text?: string }[] };
  return json.content?.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('') ?? null;
}
