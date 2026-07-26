/**
 * The agent loop.
 *
 * Two paths produce an answer, and the UI always states which one ran:
 *
 *   live-gemma          Gemma 4 chooses and calls tools via native function
 *                       calling, then writes the explanation.
 *   deterministic-demo  A fixed tool plan runs and a template writes the
 *                       explanation. No language model is involved.
 *
 * A third label, `deterministic-fallback`, appears when Gemma was genuinely
 * attempted and failed. The route comparison is identical in all three cases,
 * because every number comes from the deterministic engine either way. Losing
 * the model costs the rider prose, not correctness.
 */
import { getConfig } from '@/lib/config';
import { ENGINE_VERSION, RIVERFRONT } from '@/lib/domain';
import { formatClock } from '@/lib/gtfs/time';
import { resolvePlacesProvider } from '@/lib/places/provider';
import { DEFAULT_PREFERENCES, type RiderPreferences } from '@/lib/engine/types';
import type { RealtimeSnapshot } from '@/lib/rt/types';
import { buildSystemPrompt } from './prompt';
import { executeTool, type ToolContext } from './tools/registry';
import { buildTraceEntry } from './trace';
import { generateContent, type GeminiContent } from './providers/google';
import type { AgentResult, TraceEntry } from './types';

const MAX_TOOL_ROUNDS = 8;

export interface RunAgentInput {
  message: string;
  direction: 'to-campus' | 'to-home';
  destinationKey?: string;
  snapshot: RealtimeSnapshot;
  nowMs: number;
  demo: boolean;
  preferences?: RiderPreferences;
  /** The rider is already at RiverFront, so the Route 35 leg is behind them. */
  alreadyDowntown?: boolean;
}

function makeContext(input: RunAgentInput): ToolContext {
  const places = resolvePlacesProvider({ demo: input.demo, nowMs: input.nowMs });
  return {
    snapshot: input.snapshot,
    nowMs: input.nowMs,
    findPlaces: (args) => places.find(args),
    placesProviderName: places.name,
    preferences: input.preferences ?? DEFAULT_PREFERENCES,
  };
}

/* ------------------------------------------------------------------ */
/* Deterministic path                                                   */
/* ------------------------------------------------------------------ */

/**
 * A fixed, sensible tool plan. This is what runs with no API key, and it is
 * also the fallback when Gemma is unavailable.
 */
async function runDeterministic(
  input: RunAgentInput,
  ctx: ToolContext,
): Promise<{ trace: TraceEntry[]; toolResults: { tool: string; result: unknown }[] }> {
  const trace: TraceEntry[] = [];
  const toolResults: { tool: string; result: unknown }[] = [];
  let step = 0;

  const call = async (tool: string, args: Record<string, unknown>) => {
    step += 1;
    const outcome = await executeTool(tool, args, ctx);
    trace.push(
      buildTraceEntry({
        step,
        tool,
        rawArgs: args,
        ok: outcome.ok,
        durationMs: outcome.durationMs,
        result: outcome.result,
        error: outcome.error,
      }),
    );
    if (outcome.ok) toolResults.push({ tool, result: outcome.result });
    return outcome.result;
  };

  if (input.direction === 'to-campus') {
    const dest = input.destinationKey ?? 'science-hill';
    await call('get_service_alerts', {});
    // Only build the Route 35 leg when the rider is still on it. Once they are
    // standing downtown, that leg is history and reporting it as unresolvable
    // would be noise.
    let earliestAtArea1: string | undefined;
    if (!input.alreadyDowntown) {
      const leg = (await call('build_multileg_trip', { destinationKey: dest })) as
        | { earliestAtArea1Iso?: string }
        | undefined;
      // Chain the transfer time through, so the standalone comparison and the
      // final recommendation cannot disagree about which route wins.
      earliestAtArea1 = leg?.earliestAtArea1Iso;
    }
    await call('compare_ucsc_options', {
      campusDestination: dest,
      ...(earliestAtArea1 ? { earliestAtArea1 } : {}),
    });
    await call('recommend_next_action', { direction: 'to-campus', destinationKey: dest });
  } else {
    await call('get_service_alerts', { routeId: '35' });
    const schedule = (await call('get_stop_schedule', {
      stopId: RIVERFRONT.AREA_2.stopId,
      routeIds: ['35'],
      // Outbound only: Route 35 also arrives at this stop, and mixing the two
      // directions would make the headway meaningless.
      directionId: 0,
      timeWindowMinutes: 240,
    })) as { departures?: { scheduledDepartureIso: string }[] } | undefined;
    // Derive the real available window from the timetable rather than assuming.
    const nextDeparture = schedule?.departures?.[0]?.scheduledDepartureIso;
    const availableMinutes = nextDeparture
      ? Math.max(0, Math.round((Date.parse(nextDeparture) - ctx.nowMs) / 60_000))
      : 30;
    await call('get_nearby_wait_places', {
      boardingStopId: RIVERFRONT.AREA_2.stopId,
      availableMinutes,
    });
    await call('recommend_next_action', { direction: 'to-home', considerWaitPlaces: true });
  }

  return { trace, toolResults };
}

/** Writes the rider-facing prose without a language model. */
function composeDeterministicMessage(
  toolResults: { tool: string; result: unknown }[],
  snapshot: RealtimeSnapshot,
): string {
  const rec = toolResults.find((t) => t.tool === 'recommend_next_action')?.result as
    | Record<string, never>
    | undefined;
  const cmp = toolResults.find((t) => t.tool === 'compare_ucsc_options')?.result as
    | Record<string, never>
    | undefined;
  const places = toolResults.find((t) => t.tool === 'get_nearby_wait_places')?.result as
    | Record<string, never>
    | undefined;

  if (!rec) return 'No recommendation could be produced from the available data.';

  const lines: string[] = [];
  lines.push(`${rec.headline as unknown as string}. ${rec.subhead as unknown as string}.`);

  if (cmp?.options) {
    const opts = cmp.options as unknown as {
      routeId: string;
      feasible: boolean;
      blockedReasons: string[];
      evidence?: { label: string; vehicleAgeSeconds: number | null };
    }[];
    const parts = opts.map((o) => {
      if (!o.feasible) return `the ${o.routeId} is out (${o.blockedReasons[0] ?? 'not feasible'})`;
      return o.evidence?.label === 'observed'
        ? `the ${o.routeId} has a position from ${o.evidence.vehicleAgeSeconds}s ago`
        : `the ${o.routeId} has no current vehicle position visible`;
    });
    if (parts.length) lines.push(`Comparing the campus routes: ${parts.join('; ')}.`);
  }

  if (places?.places) {
    const list = places.places as unknown as {
      name: string;
      feasible: boolean;
      summary: string;
    }[];
    const feasible = list.filter((p) => p.feasible);
    const recommendedName = (rec.subhead as unknown as string)?.split(' · ')[0];
    // recommend_next_action already named the winner in its subhead, and its
    // numbers come from a stricter uncertainty buffer. Repeating the same place
    // here would restate it with slightly different minutes, so mention the
    // alternatives instead.
    const others = feasible.filter((p) => p.name !== recommendedName);
    if (others.length) {
      lines.push(
        `${others.length} other nearby option${others.length === 1 ? '' : 's'} also work${
          others.length === 1 ? 's' : ''
        }: ${others.slice(0, 3).map((p) => p.name).join(', ')}.`,
      );
    }
    const rejected = list.length - feasible.length;
    if (rejected > 0) {
      lines.push(
        `${rejected} nearby place${rejected === 1 ? ' was' : 's were'} ruled out for closing too early or having unverifiable hours.`,
      );
    }
    if (feasible.length === 0 && places.fallbackAdvice) {
      lines.push(places.fallbackAdvice as unknown as string);
    }
  }

  if (rec.leaveByIso) {
    lines.push(`Leave by ${formatClock(Date.parse(rec.leaveByIso as unknown as string))}.`);
  }
  lines.push(rec.backupPlan as unknown as string);
  if (rec.reevaluateAtIso) {
    lines.push(
      `This advice should be re-checked at ${formatClock(Date.parse(rec.reevaluateAtIso as unknown as string))}.`,
    );
  }

  if (snapshot.origin === 'fixture') {
    lines.push('All vehicle data above is labelled demonstration data, not a live observation.');
  } else if (snapshot.origin === 'cache' || snapshot.freshness.label !== 'fresh') {
    lines.push(
      `Real-time data is ${snapshot.freshness.ageSeconds}s old (${snapshot.freshness.label}), so treat it as indicative rather than current.`,
    );
  }

  return lines.join(' ');
}

/* ------------------------------------------------------------------ */
/* Gemma path                                                           */
/* ------------------------------------------------------------------ */

async function runGemma(
  input: RunAgentInput,
  ctx: ToolContext,
  apiKey: string,
  model: string,
): Promise<{ message: string; trace: TraceEntry[]; toolResults: { tool: string; result: unknown }[] }> {
  const trace: TraceEntry[] = [];
  const toolResults: { tool: string; result: unknown }[] = [];
  let step = 0;

  const contents: GeminiContent[] = [
    // Gemma on the Gemini API has no separate system-instruction slot, so the
    // system prompt leads the conversation as the first user turn.
    { role: 'user', parts: [{ text: buildSystemPrompt() }] },
    {
      role: 'model',
      parts: [{ text: 'Understood. I will call tools for every number and never do the arithmetic myself.' }],
    },
    {
      role: 'user',
      parts: [
        {
          text: [
            `Rider message: ${input.message}`,
            `Direction: ${input.direction}`,
            input.destinationKey ? `Campus destination: ${input.destinationKey}` : '',
            `Current time: ${new Date(input.nowMs).toISOString()}`,
            input.snapshot.origin === 'fixture'
              ? 'NOTE: real-time data in this session is demonstration fixture data. Label it as such.'
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
    },
  ];

  let finalText = '';

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await generateContent({ apiKey, model, systemPrompt: '', contents });
    const calls = res.parts.filter((p) => p.functionCall);
    const text = res.parts
      .map((p) => p.text)
      .filter(Boolean)
      .join('\n')
      .trim();

    if (calls.length === 0) {
      finalText = text;
      break;
    }

    // Record the model's turn verbatim so the conversation stays coherent.
    contents.push({ role: 'model', parts: res.parts });

    const responseParts = [];
    for (const part of calls) {
      const fc = part.functionCall!;
      step += 1;
      const outcome = await executeTool(fc.name, fc.args ?? {}, ctx);
      trace.push(
        buildTraceEntry({
          step,
          tool: fc.name,
          rawArgs: fc.args ?? {},
          ok: outcome.ok,
          durationMs: outcome.durationMs,
          result: outcome.result,
          error: outcome.error,
        }),
      );
      if (outcome.ok) toolResults.push({ tool: fc.name, result: outcome.result });

      responseParts.push({
        functionResponse: {
          name: fc.name,
          // A validation failure is handed back as structured data so the model
          // can correct its arguments rather than being left to guess.
          response: outcome.ok
            ? (outcome.result as Record<string, unknown>)
            : { error: outcome.error ?? 'tool failed' },
        },
      });
    }

    contents.push({ role: 'user', parts: responseParts });

    if (text) finalText = text;
  }

  if (!finalText) {
    finalText = composeDeterministicMessage(toolResults, input.snapshot);
  }

  return { message: finalText, trace, toolResults };
}

/* ------------------------------------------------------------------ */

export async function runAgent(input: RunAgentInput): Promise<AgentResult> {
  const cfg = getConfig();
  const ctx = makeContext(input);

  if (cfg.gemmaLive && cfg.googleApiKey) {
    try {
      const out = await runGemma(input, ctx, cfg.googleApiKey, cfg.gemmaModel);
      return {
        message: out.message,
        explanationMode: 'live-gemma',
        trace: out.trace,
        recommendation: out.toolResults.find((t) => t.tool === 'recommend_next_action')?.result as
          | Record<string, unknown>
          | undefined,
        toolResults: out.toolResults,
        model: cfg.gemmaModel,
        engineVersion: ENGINE_VERSION,
      };
    } catch (err) {
      // Gemma failed. The deterministic engine still answers correctly; only the
      // prose degrades, and we say so rather than pretending the model ran.
      const reason = err instanceof Error ? err.message : String(err);
      const det = await runDeterministic(input, ctx);
      return {
        message: composeDeterministicMessage(det.toolResults, input.snapshot),
        explanationMode: 'deterministic-fallback',
        fallbackReason: reason,
        trace: det.trace,
        recommendation: det.toolResults.find((t) => t.tool === 'recommend_next_action')?.result as
          | Record<string, unknown>
          | undefined,
        toolResults: det.toolResults,
        model: cfg.gemmaModel,
        engineVersion: ENGINE_VERSION,
      };
    }
  }

  const det = await runDeterministic(input, ctx);
  return {
    message: composeDeterministicMessage(det.toolResults, input.snapshot),
    explanationMode: 'deterministic-demo',
    trace: det.trace,
    recommendation: det.toolResults.find((t) => t.tool === 'recommend_next_action')?.result as
      | Record<string, unknown>
      | undefined,
    toolResults: det.toolResults,
    model: cfg.gemmaModel,
    engineVersion: ENGINE_VERSION,
  };
}
