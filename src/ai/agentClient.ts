/**
 * Client for the v2 agent backend (`/api/agent`, backend/app/main.py).
 *
 * One turn is a short loop: send the request, execute the tool calls the
 * model returns against the live engine (src/ai/tools.ts), send the results
 * back, and stop when the backend says `done`. Every round lands in an
 * in-memory call log (the "Under the hood" drawer) and every grounding
 * verdict feeds the HUD counter. Any failure returns a failed outcome so the
 * caller falls back to the regex grammar: the app never waits on the network.
 */

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown> | null;
  errors: string[];
}

export interface AgentGrounding {
  checked: boolean;
  passed: boolean;
  rejected: number;
  fallback: boolean;
  numbers: string[];
}

export interface AgentAssistantMessage {
  role: 'assistant';
  content: string | null;
  tool_calls: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
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
  done?: boolean;
  assistant_message?: AgentAssistantMessage | null;
  escalated?: boolean;
  grounding?: AgentGrounding | null;
}

export type AgentMessage = AgentAssistantMessage | { role: 'tool'; tool_call_id: string; content: string };

const CONFIGURED_URL = (import.meta.env.VITE_AGENT_URL as string | undefined) || '';
const AGENT_URL = CONFIGURED_URL || '/api/agent';
/**
 * Whether an agent backend can exist at all: the dev server proxies /api to
 * it, and a hosted build names one with VITE_AGENT_URL. A static deploy with
 * neither (the Vercel demo) never probes, because the 404s would show up as
 * console errors in Chromium; the app then runs on the v1 grammar.
 */
export const BACKEND_CONFIGURED = import.meta.env.DEV || CONFIGURED_URL !== '';
/** Sibling endpoints of the agent URL (…/api/agent → …/api/grounding). */
export const apiUrl = (name: string) => AGENT_URL.replace(/\/agent$/, `/${name}`);
// Super's budget is 6000 ms (CLAUDE.md 4.3); allow the network on top.
const TIMEOUT_MS = 7000;
export const MAX_ROUNDS = 5;
/** After a failed request, skip the agent for this long so voice stays fast. */
const COOLDOWN_MS = 30_000;

async function postJson<T>(url: string, body: unknown, timeoutMs: number): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${url} ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function getJson<T>(url: string, timeoutMs = 4000): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A live device rule lookup (backend /api/rules: Tavily, then Nemotron 3
 * Super, then verbatim checks). Null without a backend or on any failure; the
 * caller then keeps the default rules.
 */
export async function fetchDeviceRules<T>(deviceName: string): Promise<T | null> {
  if (!BACKEND_CONFIGURED) return null;
  // Two Tavily searches and up to two Super calls: about 30 s cold.
  return getJson<T>(`${apiUrl('rules')}?device=${encodeURIComponent(deviceName)}`, 60_000);
}

/** One request, no loop. Null on any failure. Kept for the M0 check (`window.scrub.agent`). */
export async function askAgent(
  text: string,
  state?: Record<string, unknown>,
  history?: AgentMessage[],
): Promise<AgentReply | null> {
  try {
    return await postJson<AgentReply>(AGENT_URL, { text, state, ...(history?.length ? { history } : {}) }, TIMEOUT_MS);
  } catch (err) {
    console.warn('[agent] request failed', err);
    return null;
  }
}

/* ------------------------------------------------------------ availability */

let available = false;
let scans = false;
let coolUntil = 0;

/** Ask the backend whether it can serve the agent. Call once at boot. */
export async function probeAgent(): Promise<boolean> {
  if (!BACKEND_CONFIGURED) return (available = false);
  const h = await getJson<{ ok?: boolean; token_factory?: boolean; scans?: boolean }>(apiUrl('health'));
  available = !!h?.ok && h.token_factory !== false;
  scans = !!h?.ok && !!h.scans;
  return available;
}

/** Whether the backend can start a VISTA-3D job for an uploaded scan. */
export function scansAvailable(): boolean {
  return scans;
}

export function agentAvailable(): boolean {
  return available && performance.now() >= coolUntil;
}

/** Tests and the console: force the flag (e.g. after mocking the backend). */
export function setAgentAvailable(v: boolean): void {
  available = v;
  coolUntil = 0;
}

/* ----------------------------------------------------------- grounding HUD */

export interface GroundingTotals {
  grounded: number;
  rejected: number;
  /** False until the backend has answered once: the counter stays hidden. */
  live: boolean;
}

const totals: GroundingTotals = { grounded: 0, rejected: 0, live: false };
const totalsListeners = new Set<(t: GroundingTotals) => void>();

export function groundingTotals(): GroundingTotals {
  return { ...totals };
}

export function onGrounding(fn: (t: GroundingTotals) => void): () => void {
  totalsListeners.add(fn);
  return () => totalsListeners.delete(fn);
}

function emitTotals(): void {
  for (const fn of totalsListeners) fn({ ...totals });
}

/** Seed the counter from the backend's cumulative totals. */
export async function loadGroundingTotals(): Promise<boolean> {
  if (!BACKEND_CONFIGURED) return false;
  const g = await getJson<{ grounded?: number; rejected?: number }>(apiUrl('grounding'));
  if (!g || typeof g.grounded !== 'number' || typeof g.rejected !== 'number') return false;
  totals.grounded = g.grounded;
  totals.rejected = g.rejected;
  totals.live = true;
  emitTotals();
  return true;
}

/** grounded += 1 when the text passed (or fell back to a template); rejected += its rejections. */
export function applyGrounding(t: GroundingTotals, g: AgentGrounding | null | undefined): GroundingTotals {
  if (!g) return t;
  return {
    grounded: t.grounded + ((g.checked && g.passed) || g.fallback ? 1 : 0),
    rejected: t.rejected + (g.rejected > 0 ? g.rejected : 0),
    live: true,
  };
}

function countGrounding(g: AgentGrounding | null | undefined): void {
  if (!g) return;
  Object.assign(totals, applyGrounding(totals, g));
  emitTotals();
}

/* ---------------------------------------------------------------- call log */

export interface AgentLogEntry {
  id: number;
  at: number;
  text: string;
  round: number;
  model: string;
  latency_ms: number | null;
  tools: string[];
  /** true/false once a grounding verdict exists for this round; null when no text was checked. */
  grounded: boolean | null;
  escalated: boolean;
  error: string | null;
}

const log: AgentLogEntry[] = [];
const logListeners = new Set<(entries: readonly AgentLogEntry[]) => void>();
let nextLogId = 1;

export function agentLog(): readonly AgentLogEntry[] {
  return log;
}

export function onAgentLog(fn: (entries: readonly AgentLogEntry[]) => void): () => void {
  logListeners.add(fn);
  return () => logListeners.delete(fn);
}

function record(e: Omit<AgentLogEntry, 'id' | 'at'>): void {
  log.push({ id: nextLogId++, at: Date.now(), ...e });
  if (log.length > 100) log.shift();
  for (const fn of logListeners) fn(log);
}

/* -------------------------------------------------------------------- loop */

export type ToolExecutor = (name: string, args: Record<string, unknown> | null) => Promise<Record<string, unknown>>;

export interface TurnResult {
  /** True when the backend finished the turn; `text` is then the reply to show. */
  ok: boolean;
  text: string | null;
  /** Every tool executed this turn, in order, with its result. */
  executed: { name: string; result: Record<string, unknown> }[];
  rounds: number;
  error: string | null;
}

/** OpenAI-format assistant message for a reply that did not carry one. */
function assistantFrom(reply: AgentReply): AgentAssistantMessage {
  return {
    role: 'assistant',
    content: reply.text,
    tool_calls: reply.tool_calls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
    })),
  };
}

/**
 * Run one agent turn. `state` is read before every request so each round
 * sees the plan as the previous round's tools left it.
 */
export async function runAgentTurn(
  text: string,
  opts: { state: () => Record<string, unknown>; execute: ToolExecutor },
): Promise<TurnResult> {
  const history: AgentMessage[] = [];
  const executed: TurnResult['executed'] = [];
  const fail = (rounds: number, error: string): TurnResult => {
    coolUntil = /timeout|abort|fetch|network|50[23]/i.test(error) ? performance.now() + COOLDOWN_MS : coolUntil;
    return { ok: false, text: null, executed, rounds, error };
  };

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    let reply: AgentReply;
    try {
      reply = await postJson<AgentReply>(
        AGENT_URL,
        { text, state: opts.state(), ...(history.length ? { history } : {}) },
        TIMEOUT_MS,
      );
    } catch (err) {
      const msg = err instanceof Error ? (err.name === 'AbortError' ? 'timeout' : err.message) : String(err);
      record({ text, round, model: '—', latency_ms: null, tools: [], grounded: null, escalated: false, error: msg });
      console.warn('[agent] request failed', msg);
      return fail(round, msg);
    }
    const calls = Array.isArray(reply.tool_calls) ? reply.tool_calls : [];
    const g = reply.grounding ?? null;
    countGrounding(g);
    const invalid = !reply.valid || calls.some((c) => c.errors?.length || c.arguments === null);
    record({
      text,
      round,
      model: reply.model ?? '—',
      latency_ms: typeof reply.latency_ms === 'number' ? reply.latency_ms : null,
      tools: calls.map((c) => c.name),
      grounded: g && (g.checked || g.fallback) ? (g.checked && g.passed) || g.fallback : null,
      escalated: !!reply.escalated,
      error: invalid ? (calls.flatMap((c) => c.errors ?? [])[0] ?? 'invalid reply') : null,
    });
    if (invalid) return fail(round, 'invalid tool calls');

    // DECISION: tool calls are executed even on a `done` reply. The backend
    // cannot run the engine, so a call it sends is always for the browser;
    // with done set, no further round follows.
    const results: { id: string; name: string; result: Record<string, unknown> }[] = [];
    for (const c of calls) {
      const result = await opts.execute(c.name, c.arguments);
      results.push({ id: c.id, name: c.name, result });
      executed.push({ name: c.name, result });
    }

    if (reply.done || calls.length === 0) {
      return { ok: true, text: reply.text ?? null, executed, rounds: round, error: null };
    }
    history.push(reply.assistant_message ?? assistantFrom(reply));
    for (const r of results) history.push({ role: 'tool', tool_call_id: r.id, content: JSON.stringify(r.result) });
  }
  return fail(MAX_ROUNDS, `no answer after ${MAX_ROUNDS} rounds`);
}
