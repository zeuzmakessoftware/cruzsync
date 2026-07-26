import { describe, expect, it } from 'vitest';
import {
  TOOL_NAMES,
  TOOL_DESCRIPTIONS,
  toolArgSchemas,
  toolJsonSchema,
  toolResultSchemas,
} from '@/lib/agent/tools/schemas';
import { executeTool, type ToolContext } from '@/lib/agent/tools/registry';
import { buildFunctionDeclarations } from '@/lib/agent/providers/google';
import { redactArgs, summariseResult, buildTraceEntry } from '@/lib/agent/trace';
import { buildSystemPrompt } from '@/lib/agent/prompt';
import { runAgent } from '@/lib/agent/orchestrator';
import { DEFAULT_PREFERENCES } from '@/lib/engine/types';
import { getFixturePlaces } from '@/lib/places/provider';
import { RIVERFRONT } from '@/lib/domain';
import { SUPPORTED_GOOGLE_GEMMA_MODELS, DEFAULT_GEMMA_MODEL, publicRuntimeInfo } from '@/lib/config';
import { getScene } from '@fixtures/scenes';

const scene = getScene('return-long-wait')!;
const outbound = getScene('outbound-11-wins')!;

function ctxFor(sceneId: string): ToolContext {
  const s = getScene(sceneId)!;
  return {
    snapshot: s.build(s.anchorMs),
    nowMs: s.anchorMs,
    findPlaces: async () => getFixturePlaces(s.anchorMs),
    placesProviderName: 'test fixture',
    preferences: DEFAULT_PREFERENCES,
  };
}

/* ------------------------------------------------------------------ */

describe('tool schema surface', () => {
  it('declares every specified tool', () => {
    // Twelve, not thirteen: the optional `plan_transit_trip` is specified only
    // for when a legitimate third-party routing provider is configured. None is,
    // so shipping a stub that pretends to plan trips would be worse than
    // omitting it.
    expect(TOOL_NAMES).toHaveLength(12);
    for (const name of [
      'get_vehicle_positions',
      'get_trip_updates',
      'get_service_alerts',
      'get_stop_schedule',
      'build_multileg_trip',
      'analyze_route_evidence',
      'compare_ucsc_options',
      'get_nearby_wait_places',
      'get_place_details',
      'get_walking_time',
      'calculate_safe_wait',
      'recommend_next_action',
    ]) {
      expect(TOOL_NAMES).toContain(name);
    }
  });

  it('every tool has both an argument schema and a result schema', () => {
    for (const name of TOOL_NAMES) {
      expect(toolArgSchemas[name], name).toBeDefined();
      expect(toolResultSchemas[name], name).toBeDefined();
      expect(TOOL_DESCRIPTIONS[name], name).toBeTruthy();
    }
  });

  it('produces JSON Schema for every tool', () => {
    for (const name of TOOL_NAMES) {
      const js = toolJsonSchema(name);
      expect(js, name).toBeTruthy();
      expect(typeof js).toBe('object');
    }
  });

  it('the function declarations sent to Gemma are well formed', () => {
    const decls = buildFunctionDeclarations();
    expect(decls).toHaveLength(TOOL_NAMES.length);
    for (const d of decls) {
      expect(d.name).toBeTruthy();
      expect(d.description.length).toBeGreaterThan(20);
      const params = d.parameters as Record<string, unknown>;
      expect(params).toBeTruthy();
      // Keywords Gemini rejects must have been stripped.
      const json = JSON.stringify(params);
      expect(json).not.toContain('$schema');
      expect(json).not.toContain('additionalProperties');
      expect(json).not.toContain('exclusiveMinimum');
    }
  });

  it('the campus comparison tool cannot be asked about Route 35', () => {
    const bad = toolArgSchemas.compare_ucsc_options.safeParse({
      campusDestination: 'science-hill',
      candidateRouteIds: ['35'],
    });
    expect(bad.success).toBe(false);
  });

  it('rejects malformed arguments rather than coercing them', () => {
    expect(toolArgSchemas.calculate_safe_wait.safeParse({ predictedDeparture: 'soon', walkSeconds: 10 }).success).toBe(
      false,
    );
    expect(
      toolArgSchemas.get_stop_schedule.safeParse({ stopId: '1466', timeWindowMinutes: 99999 }).success,
    ).toBe(false);
    expect(toolArgSchemas.get_nearby_wait_places.safeParse({ boardingStopId: '1466' }).success).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe('tool execution validates both directions', () => {
  it('returns a structured error for an unknown tool', async () => {
    const r = await executeTool('teleport_rider', {}, ctxFor('return-long-wait'));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Unknown tool/);
  });

  it('returns a structured error for invalid arguments instead of throwing', async () => {
    const r = await executeTool('analyze_route_evidence', { routeId: '11' }, ctxFor('outbound-11-wins'));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Invalid arguments/);
  });

  it('a valid call passes its own result schema', async () => {
    const r = await executeTool(
      'compare_ucsc_options',
      { campusDestination: 'science-hill' },
      ctxFor('outbound-11-wins'),
    );
    expect(r.ok).toBe(true);
    expect(toolResultSchemas.compare_ucsc_options.safeParse(r.result).success).toBe(true);
  });

  it('every tool result carries provenance the model can cite', async () => {
    const ctx = ctxFor('outbound-11-wins');
    for (const [name, args] of [
      ['get_vehicle_positions', {}],
      ['get_trip_updates', {}],
      ['get_service_alerts', {}],
      ['get_stop_schedule', { stopId: RIVERFRONT.AREA_1.stopId }],
      ['compare_ucsc_options', { campusDestination: 'science-hill' }],
    ] as const) {
      const r = await executeTool(name, args, ctx);
      expect(r.ok, name).toBe(true);
      const prov = (r.result as { provenance: { source: string; origin: string } }).provenance;
      expect(prov.source, name).toBeTruthy();
      expect(prov.origin, name).toBe('fixture');
    }
  });

  it('evidence payloads always declare that confidence is uncalibrated', async () => {
    const r = await executeTool(
      'compare_ucsc_options',
      { campusDestination: 'science-hill' },
      ctxFor('outbound-11-wins'),
    );
    const options = (r.result as { options: { evidence?: { confidenceIsCalibrated: boolean } }[] }).options;
    for (const o of options) {
      if (o.evidence) expect(o.evidence.confidenceIsCalibrated).toBe(false);
    }
  });

  it('the safe-wait tool refuses a departure it cannot parse', async () => {
    const r = await executeTool(
      'calculate_safe_wait',
      { predictedDeparture: 'tomorrow-ish', walkSeconds: 200 },
      ctxFor('return-long-wait'),
    );
    expect(r.ok).toBe(false);
  });

  it('a headway is only computed when a direction is given', async () => {
    const ctx = ctxFor('return-long-wait');
    const mixed = await executeTool(
      'get_stop_schedule',
      { stopId: RIVERFRONT.AREA_2.stopId, routeIds: ['35'], timeWindowMinutes: 240 },
      ctx,
    );
    const directed = await executeTool(
      'get_stop_schedule',
      { stopId: RIVERFRONT.AREA_2.stopId, routeIds: ['35'], directionId: 0, timeWindowMinutes: 240 },
      ctx,
    );
    // Without a direction the stop mixes arrivals and departures, so we decline.
    expect((mixed.result as { headway: unknown }).headway).toBeNull();
    expect((directed.result as { headway: { maxGapMinutes: number } }).headway.maxGapMinutes).toBe(60);
  });
});

/* ------------------------------------------------------------------ */

describe('trace sanitisation', () => {
  it('redacts anything credential-shaped', () => {
    const out = redactArgs({ apiKey: 'abc123', authToken: 'xyz', userEmail: 'a@b.c', stopId: '1466' });
    expect(out.apiKey).toBe('[redacted]');
    expect(out.authToken).toBe('[redacted]');
    expect(out.userEmail).toBe('[redacted]');
    expect(out.stopId).toBe('1466');
  });

  it('redacts free text the rider typed', () => {
    const out = redactArgs({ message: 'I live at 42 Elm Street and I am late' });
    expect(String(out.message)).toMatch(/^\[redacted free text/);
    expect(String(out.message)).not.toContain('Elm');
  });

  it('coarsens coordinates so a trace cannot pinpoint a person', () => {
    const out = redactArgs({ lat: 36.9734841234, lon: -122.0242081234 });
    expect(String(out.lat).split('.')[1].length).toBeLessThanOrEqual(3);
  });

  it('recurses into nested objects', () => {
    const out = redactArgs({ filters: { apiKey: 'nested-secret', requireQuiet: true } });
    expect((out.filters as Record<string, unknown>).apiKey).toBe('[redacted]');
    expect((out.filters as Record<string, unknown>).requireQuiet).toBe(true);
  });

  it('summaries are short and contain no raw payload', () => {
    const s = summariseResult('compare_ucsc_options', {
      bestRouteId: '11',
      options: [{ routeId: '11' }, { routeId: '18' }],
    });
    expect(s).toBe('best = Route 11 of 2 evaluated');
    expect(s.length).toBeLessThan(120);
  });

  it('a trace entry never contains a reasoning or thinking field', () => {
    const entry = buildTraceEntry({
      step: 1,
      tool: 'get_service_alerts',
      rawArgs: { routeId: '35' },
      ok: true,
      durationMs: 3,
      result: { count: 0, provenance: { source: 'x', origin: 'fixture', observedAtIso: null } },
    });
    const json = JSON.stringify(entry).toLowerCase();
    expect(json).not.toContain('thinking');
    expect(json).not.toContain('chain_of_thought');
    expect(json).not.toContain('reasoning');
    expect(entry.origin).toBe('fixture');
  });
});

/* ------------------------------------------------------------------ */

describe('the system prompt states the guardrails explicitly', () => {
  const prompt = buildSystemPrompt();

  it('teaches the two-leg model and forbids comparing Route 35 with campus routes', () => {
    expect(prompt).toMatch(/NEVER an alternative/i);
    expect(prompt).toContain('Route 35');
    expect(prompt).toContain(RIVERFRONT.AREA_1.stopId);
  });

  it('forbids arithmetic in free text', () => {
    expect(prompt).toMatch(/You do not do arithmetic/i);
  });

  it('mandates the correct wording for a missing vehicle', () => {
    expect(prompt).toContain('No current vehicle position is visible for this trip.');
    expect(prompt).toMatch(/does NOT mean|not mean/i);
  });

  it('forbids inventing crowding, hours and amenities', () => {
    expect(prompt).toMatch(/invent passenger counts/i);
    expect(prompt).toMatch(/opening hours that no tool returned/i);
    expect(prompt).toMatch(/unknown/i);
  });

  it('forbids claiming affiliation with the agency', () => {
    expect(prompt).toMatch(/affiliation with or endorsement by Santa Cruz METRO/i);
  });

  it('forbids presenting confidence as a probability', () => {
    expect(prompt).toMatch(/not calibrated/i);
  });
});

/* ------------------------------------------------------------------ */

describe('provider configuration is honest about what it can do', () => {
  it('only advertises Gemma models the Gemini API actually serves', () => {
    expect(SUPPORTED_GOOGLE_GEMMA_MODELS).toContain('gemma-4-31b-it');
    expect(SUPPORTED_GOOGLE_GEMMA_MODELS).toContain('gemma-4-26b-a4b-it');
    // A Hugging Face-only id must not be offered as if it were callable.
    expect(SUPPORTED_GOOGLE_GEMMA_MODELS as readonly string[]).not.toContain('gemma-4-12b-it');
    expect(SUPPORTED_GOOGLE_GEMMA_MODELS).toContain(DEFAULT_GEMMA_MODEL);
  });

  it('reports deterministic-demo mode when no key is configured', () => {
    const info = publicRuntimeInfo({
      gemmaProvider: 'google',
      gemmaModel: DEFAULT_GEMMA_MODEL,
      demoMode: true,
      gemmaLive: false,
    });
    expect(info.gemmaMode).toBe('deterministic-demo');
    expect(info.modeReason).toMatch(/No GOOGLE_API_KEY/);
  });

  it('never leaks key material into the client payload', () => {
    const info = publicRuntimeInfo({
      gemmaProvider: 'google',
      gemmaModel: DEFAULT_GEMMA_MODEL,
      googleApiKey: 'super-secret-value',
      googlePlacesApiKey: 'another-secret',
      demoMode: false,
      gemmaLive: true,
    });
    const json = JSON.stringify(info);
    expect(json).not.toContain('super-secret-value');
    expect(json).not.toContain('another-secret');
    expect(info.gemmaMode).toBe('live-gemma');
  });
});

/* ------------------------------------------------------------------ */

describe('end-to-end happy path', () => {
  it('to campus: runs the tool chain and recommends a campus route', async () => {
    const result = await runAgent({
      message: "I'm on the 35 from Scotts Valley. Which bus should I transfer to for campus?",
      direction: 'to-campus',
      destinationKey: 'science-hill',
      snapshot: outbound.build(outbound.anchorMs),
      nowMs: outbound.anchorMs,
      demo: true,
    });

    expect(result.explanationMode).toBe('deterministic-demo');
    expect(result.trace.length).toBeGreaterThanOrEqual(3);
    expect(result.trace.every((t) => t.status === 'ok')).toBe(true);
    expect(result.recommendation?.action).toBe('TRANSFER TO 11');
    expect(result.message).toContain('11');
    // The demo must never be presented as a live observation.
    expect(result.message).toMatch(/demonstration data/i);
  });

  it('the comparison and the recommendation always agree on the winner', async () => {
    for (const sceneId of ['outbound-11-wins', 'outbound-11-ghost'] as const) {
      const s = getScene(sceneId)!;
      const result = await runAgent({
        message: 'Which bus?',
        direction: 'to-campus',
        destinationKey: 'science-hill',
        snapshot: s.build(s.anchorMs),
        nowMs: s.anchorMs,
        demo: true,
        alreadyDowntown: sceneId === 'outbound-11-ghost',
      });
      const cmp = result.toolResults.find((t) => t.tool === 'compare_ucsc_options')?.result as {
        bestRouteId: string | null;
      };
      expect(`TRANSFER TO ${cmp.bestRouteId}`, sceneId).toBe(result.recommendation?.action);
    }
  });

  it('going home: recommends a place and its leave-by matches the place card exactly', async () => {
    const result = await runAgent({
      message: 'Where can I hang out without missing the 35?',
      direction: 'to-home',
      snapshot: scene.build(scene.anchorMs),
      nowMs: scene.anchorMs,
      demo: true,
    });

    expect(result.recommendation?.action).toBe('WAIT AT A PLACE');
    const rec = result.recommendation as unknown as {
      leaveByIso: string;
      waitPlaces: { name: string; feasible: boolean; leaveByIso: string }[];
    };
    const top = rec.waitPlaces.find((p) => p.feasible)!;
    // One leave-by time on the screen, not two that differ by a minute.
    expect(top.leaveByIso).toBe(rec.leaveByIso);
  });

  it('never asserts a cancellation anywhere in the rider-facing output', async () => {
    for (const sceneId of ['outbound-11-wins', 'outbound-11-ghost', 'return-long-wait'] as const) {
      const s = getScene(sceneId)!;
      const result = await runAgent({
        message: 'What should I do?',
        direction: s.direction === 'to-home' ? 'to-home' : 'to-campus',
        destinationKey: 'science-hill',
        snapshot: s.build(s.anchorMs),
        nowMs: s.anchorMs,
        demo: true,
      });
      expect(result.message.toLowerCase(), sceneId).not.toMatch(/\bis cancelled\b|\bwas cancelled\b|\bnot running\b/);
    }
  });

  it('degrades to schedule-only language when there is no real-time evidence at all', async () => {
    const bare = {
      ...outbound.build(outbound.anchorMs),
      vehicles: [],
      tripUpdates: [],
    };
    const result = await runAgent({
      message: 'Which bus?',
      direction: 'to-campus',
      destinationKey: 'science-hill',
      snapshot: bare,
      nowMs: outbound.anchorMs,
      demo: true,
    });
    expect(result.recommendation).toBeTruthy();
    expect(result.message).toMatch(/no current vehicle position is visible/i);
  });

  it('reports honestly when the destination eliminates most routes', async () => {
    const result = await runAgent({
      message: 'I need Crown & Merrill.',
      direction: 'to-campus',
      destinationKey: 'crown-merrill',
      snapshot: outbound.build(outbound.anchorMs),
      nowMs: outbound.anchorMs,
      demo: true,
    });
    const cmp = result.toolResults.find((t) => t.tool === 'compare_ucsc_options')?.result as {
      bestRouteId: string | null;
      options: { routeId: string; feasible: boolean; blockedReasons: string[] }[];
    };
    expect(cmp.bestRouteId).toBe('18');
    expect(cmp.options.find((o) => o.routeId === '11')!.blockedReasons.join(' ')).toMatch(/does not serve/);
  });
});

describe('redaction is precise, not indiscriminate', () => {
  it('does not redact ordinary fields that merely contain a sensitive substring', () => {
    const out = redactArgs({
      destinationKey: 'science-hill',
      placeId: 'osm:node/1',
      routeId: '11',
      stopId: '1466',
      keyword: 'coffee',
    });
    // These are exactly the fields that make a trace auditable.
    expect(out.destinationKey).toBe('science-hill');
    expect(out.placeId).toBe('osm:node/1');
    expect(out.routeId).toBe('11');
    expect(out.keyword).toBe('coffee');
  });

  it('still redacts genuine credentials in every common casing', () => {
    const out = redactArgs({
      apiKey: 'a',
      api_key: 'b',
      'x-api-key': 'c',
      GOOGLE_API_KEY: 'd',
      authToken: 'e',
      accessToken: 'f',
      key: 'g',
      userEmail: 'h',
    });
    for (const [k, v] of Object.entries(out)) {
      expect(v, k).toBe('[redacted]');
    }
  });
});
