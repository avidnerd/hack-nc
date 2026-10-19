/**
 * Client for the v2 agent backend (`/api/agent`, backend/app/main.py).
 *
 * M0: one request, one response with the model's validated tool calls. The
 * caller decides what to do with them; nothing is dispatched from here yet.
 * Every failure returns null so the caller falls back to the regex grammar.
 */

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown> | null;
  errors: string[];
}

export interface AgentReply {
  model: string;
  latency_ms: number;
  tool_calls: AgentToolCall[];
  text: string | null;
  valid: boolean;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  prompt_version: string;
}

const AGENT_URL = (import.meta.env.VITE_AGENT_URL as string | undefined) ?? '/api/agent';
// Super's budget is 6000 ms (CLAUDE.md 4.3); allow the network on top.
const TIMEOUT_MS = 7000;

export async function askAgent(text: string, state?: Record<string, unknown>): Promise<AgentReply | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(AGENT_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, state }),
    });
    if (!res.ok) throw new Error(`agent ${res.status}`);
    return (await res.json()) as AgentReply;
  } catch (err) {
    console.warn('[agent] request failed', err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
