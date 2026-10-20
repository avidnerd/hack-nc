import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyGrounding,
  runAgentTurn,
  type AgentReply,
} from '../src/ai/agentClient.ts';
import {
  executeTool,
  metricsOut,
  movePlaneBy,
  optimizeReasonCodes,
  planeOut,
  r1,
  ruleOfReason,
  stentOut,
  stentRules,
  templateReply,
  type OptimizeOutcome,
} from '../src/ai/tools.ts';
import { Centerline } from '../src/devices/centerline.ts';
import { evaluateStent, ostiaOnCenterline, placeStent, sizeAt } from '../src/devices/stent.ts';
import type { CenterlineData, PlanMetrics } from '../src/types.ts';

const tools = JSON.parse(readFileSync(new URL('../shared/tools.json', import.meta.url), 'utf8')) as {
  tools: { function: { name: string } }[];
};

const aorta = JSON.parse(
  readFileSync(new URL('../public/data/aorta/centerlines.json', import.meta.url), 'utf8'),
) as CenterlineData;
const cl = new Centerline(aorta.vessels.aorta);
const ostia = ostiaOnCenterline(cl, aorta.renalOstia);

function metrics(p: Partial<PlanMetrics>): PlanMetrics {
  return {
    remnantPct: 50,
    resectedMl: 100,
    healthyRemnantMl: 900,
    marginMm: 10,
    tumorIncomplete: false,
    vesselsCrossed: 0,
    vesselName: null,
    vesselId: 0,
    nearestVesselMm: 20,
    nearestVesselId: 0,
    ...p,
  };
}

describe('tool result helpers', () => {
  it('rounds unit-bearing numbers to one decimal', () => {
    expect(r1(31.249)).toBe(31.2);
    expect(r1(31.25)).toBe(31.3);
    expect(metricsOut(metrics({ remnantPct: 38.96, marginMm: 10.04, vesselsCrossed: 2 }))).toEqual({
      flr_pct: 39,
      margin_mm: 10,
      vessels_crossed: 2,
    });
    expect(planeOut({ n: [0.123456, 0, 0.99], d: -12.345 })).toEqual({ normal: [0.1235, 0, 0.99], d: -12.3 });
  });

  it('offsets a plane along its normal, toward the resected side', () => {
    const p = movePlaneBy({ n: [1, 0, 0], d: 10 }, [10, 0, 0], null, 5);
    expect(p.n).toEqual([1, 0, 0]);
    expect(p.d).toBe(15);
  });

  it('rotates the normal about a world axis through the pivot', () => {
    const pivot: [number, number, number] = [10, 4, -3];
    const p = movePlaneBy({ n: [1, 0, 0], d: 10 }, pivot, { axis: 'z', deg: 90 }, 0);
    expect(p.n[0]).toBeCloseTo(0, 9);
    expect(p.n[1]).toBeCloseTo(1, 9);
    // The pivot stays on the plane.
    expect(p.n[0] * pivot[0] + p.n[1] * pivot[1] + p.n[2] * pivot[2] - p.d).toBeCloseTo(0, 9);
    const q = movePlaneBy({ n: [1, 0, 0], d: 10 }, pivot, { axis: 'z', deg: 90 }, -2);
    expect(q.d).toBeCloseTo(p.d - 2, 9);
  });

  it('breaks a sealing stent into passing rules', () => {
    const st = placeStent(cl, ostia);
    expect(st.seals).toBe(true);
    const rules = stentRules(st, ostia);
    expect(rules.map((r) => r.id)).toEqual(['renal', 'neck_length', 'oversize', 'angulation']);
    expect(rules.every((r) => r.pass)).toBe(true);
    expect(rules[1].value).toBe(r1(st.neckMm));
    expect(rules[2].limit).toEqual([10, 20]);
    expect(rules[3].unit).toBe('deg');
    const out = stentOut(st, 'gore_excluder', ostia);
    expect(out).toMatchObject({ device_id: 'gore_excluder', seals: true, s0_mm: r1(st.s0), rules_source: 'default' });
    expect(Object.keys(out).sort()).toEqual(['device_id', 'diameter_mm', 'length_mm', 'oversize_pct', 'rules', 'rules_source', 's0_mm', 'seals']);
  });

  it('flags the renal rule when the graft covers an ostium', () => {
    const lowest = Math.max(...ostia.map((o) => o.s));
    const s0 = lowest - 10;
    const st = evaluateStent(cl, ostia, s0, sizeAt(cl, s0));
    expect(st.seals).toBe(false);
    const renal = stentRules(st, ostia)[0];
    expect(renal.pass).toBe(false);
    expect(renal.value).toBe(-10);
  });

  it('maps a stent fail reason to its rule id', () => {
    expect(ruleOfReason('Neck too short, 8 millimeters')).toBe('neck_length');
    expect(ruleOfReason('Neck angled 62 degrees')).toBe('angulation');
    expect(ruleOfReason('Undersized, 4 percent oversize')).toBe('oversize');
    expect(ruleOfReason('Left renal artery covered')).toBe('renal');
    expect(ruleOfReason('Above the renal arteries')).toBe('renal');
    expect(ruleOfReason(null)).toBe(null);
  });

  it('names what the start violated, the search, and an avoided structure still cut', () => {
    const o: OptimizeOutcome = {
      res: {
        plane: { n: [1, 0, 0], d: 0 },
        before: metrics({}),
        after: metrics({}),
        angleDeg: 12,
        offsetMm: 3,
        feasible: false,
        violated: ['margin', 'vessels'],
        vessel: null,
        candidates: 10,
        ms: 1,
      },
      before: metrics({ marginMm: 4, vesselsCrossed: 1 }),
      after: metrics({ marginMm: 8, vesselsCrossed: 0 }),
      th: { marginMin: 10, remnantMin: 30, vesselPenalty: 'hard' },
      wide: true,
      hadCut: true,
    };
    expect(optimizeReasonCodes(o, true)).toEqual(['margin_below_min', 'vessels_crossed', 'wide_search', 'avoid_crossed']);
    expect(optimizeReasonCodes({ ...o, wide: false, hadCut: false }, false)).toEqual(['no_cut', 'local_search']);
  });

  it('builds a template reply only from tool values', () => {
    const text = templateReply([
      { name: 'optimize_plane', result: { after: { flr_pct: 39.1, margin_mm: 10.2, vessels_crossed: 0 } } },
      { name: 'resect', result: { resected_ml: 412.3, remnant_flr_pct: 39.1 } },
    ]);
    expect(text).toBe('Optimized. FLR 39.1 %, margin 10.2 mm, 0 vessels crossed. Resects 412.3 mL. FLR 39.1 %.');
    expect(templateReply([])).toBe('Done.');
  });
});

describe('tool executor', () => {
  it('has a case for every tool in shared/tools.json and never throws', async () => {
    // No host installed in a unit test: every tool answers with an error object.
    for (const t of tools.tools) {
      const r = await executeTool(t.function.name, {});
      expect(r).toHaveProperty('error');
    }
    expect(await executeTool('no_such_tool', {})).toHaveProperty('error');
  });
});

describe('grounding counter', () => {
  it('counts a passed or template reply once and adds rejections', () => {
    const t0 = { grounded: 5, rejected: 1, live: true };
    expect(applyGrounding(t0, { checked: true, passed: true, rejected: 0, fallback: false, numbers: [] })).toEqual({ grounded: 6, rejected: 1, live: true });
    expect(applyGrounding(t0, { checked: true, passed: false, rejected: 2, fallback: true, numbers: [] })).toEqual({ grounded: 6, rejected: 3, live: true });
    expect(applyGrounding(t0, { checked: false, passed: false, rejected: 0, fallback: false, numbers: [] })).toEqual({ grounded: 5, rejected: 1, live: true });
    expect(applyGrounding(t0, null)).toBe(t0);
  });
});

describe('agent loop', () => {
  afterEach(() => vi.unstubAllGlobals());

  const base: Omit<AgentReply, 'tool_calls' | 'text' | 'done' | 'assistant_message'> = {
    model: 'nemotron-super',
    latency_ms: 800,
    valid: true,
    prompt_tokens: 100,
    completion_tokens: 20,
    prompt_version: 'agent_v1',
    escalated: false,
    grounding: null,
  };

  function scripted(replies: AgentReply[]) {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        bodies.push(JSON.parse(init.body) as Record<string, unknown>);
        const r = replies.shift();
        return r ? new Response(JSON.stringify(r), { status: 200 }) : new Response('{}', { status: 503 });
      }),
    );
    return bodies;
  }

  it('executes tool calls, sends the results back and returns the final text', async () => {
    const bodies = scripted([
      {
        ...base,
        tool_calls: [{ id: 'c1', name: 'optimize_plane', arguments: { margin_min_mm: 10 }, errors: [] }],
        text: null,
        done: false,
        assistant_message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'optimize_plane', arguments: '{"margin_min_mm":10}' } }],
        },
      },
      {
        ...base,
        tool_calls: [],
        text: 'Margin 10.2 mm.',
        done: true,
        assistant_message: null,
        grounding: { checked: true, passed: true, rejected: 0, fallback: false, numbers: ['10.2 mm'] },
      },
    ]);
    const calls: string[] = [];
    const turn = await runAgentTurn('optimize', {
      state: () => ({ case_id: 'liver' }),
      execute: async (name) => {
        calls.push(name);
        return { after: { margin_mm: 10.2 } };
      },
    });
    expect(turn).toMatchObject({ ok: true, text: 'Margin 10.2 mm.', rounds: 2 });
    expect(calls).toEqual(['optimize_plane']);
    expect(bodies[0]).toEqual({ text: 'optimize', state: { case_id: 'liver' } });
    const history = bodies[1].history as { role: string; tool_call_id?: string; content?: string }[];
    expect(history.map((m) => m.role)).toEqual(['assistant', 'tool']);
    expect(history[1].tool_call_id).toBe('c1');
    expect(JSON.parse(history[1].content!)).toEqual({ after: { margin_mm: 10.2 } });
  });

  it('fails without executing anything on invalid calls or a server error', async () => {
    scripted([{ ...base, valid: false, tool_calls: [{ id: 'c1', name: 'measure', arguments: null, errors: ['bad'] }], text: null, done: false }]);
    const exec = vi.fn(async () => ({}));
    const bad = await runAgentTurn('x', { state: () => ({}), execute: exec });
    expect(bad.ok).toBe(false);
    expect(exec).not.toHaveBeenCalled();

    scripted([]);
    const down = await runAgentTurn('x', { state: () => ({}), execute: exec });
    expect(down).toMatchObject({ ok: false, executed: [] });
  });

  it('gives up after five rounds of tool calls', async () => {
    const loop: AgentReply = { ...base, tool_calls: [{ id: 'c', name: 'get_state', arguments: {}, errors: [] }], text: null, done: false };
    scripted(Array.from({ length: 6 }, () => ({ ...loop })));
    const turn = await runAgentTurn('x', { state: () => ({}), execute: async () => ({ ok: true }) });
    expect(turn.ok).toBe(false);
    expect(turn.rounds).toBe(5);
    expect(turn.executed).toHaveLength(5);
  });
});
