/**
 * Headway is COMPUTED from the active service day, never hardcoded.
 *
 * Route 35's real Santa Cruz METRO evening timetable runs every 30 minutes and
 * then degrades to hourly after 20:00. Baking "30 minutes" into the product
 * would understate the evening wait by half and quietly break the exact promise
 * CruzSync makes to the rider.
 */
import { getScheduledDepartures } from '@/lib/gtfs/feed';
import type { ScheduledDeparture } from '@/lib/gtfs/types';

export interface HeadwayAnalysis {
  routeId: string;
  stopId: string;
  /** Gaps in minutes between consecutive departures in the window. */
  gapsMinutes: number[];
  /** Gap between the next departure and the one after it -- the cost of missing it. */
  nextGapMinutes: number | null;
  medianGapMinutes: number | null;
  maxGapMinutes: number | null;
  /** True when the gaps are not uniform, e.g. 30 min becoming 60 min. */
  degrades: boolean;
  /** Rider-facing sentence describing the real cost of missing this bus. */
  summary: string;
  departures: ScheduledDeparture[];
}

export interface HeadwayQuery {
  routeId: string;
  stopId: string;
  nowMs: number;
  /** Only consider departures in this direction, when given. */
  directionId?: number;
  windowMinutes?: number;
}

export function analyzeHeadway(q: HeadwayQuery): HeadwayAnalysis {
  const windowMinutes = q.windowMinutes ?? 240;
  let departures = getScheduledDepartures({
    stopId: q.stopId,
    routeIds: [q.routeId],
    fromMs: q.nowMs,
    windowMinutes,
  });
  if (q.directionId !== undefined) {
    departures = departures.filter((d) => d.directionId === q.directionId);
  }

  const times = departures.map((d) => d.departureEpochMs);
  const gapsMinutes = times.slice(1).map((t, i) => Math.round((t - times[i]) / 60000));
  const sorted = [...gapsMinutes].sort((a, b) => a - b);
  const medianGapMinutes = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  const maxGapMinutes = sorted.length ? sorted[sorted.length - 1] : null;
  const minGap = sorted.length ? sorted[0] : null;
  const nextGapMinutes = gapsMinutes.length ? gapsMinutes[0] : null;
  // "Degrades" means the worst gap is at least half again the best one.
  const degrades = minGap !== null && maxGapMinutes !== null && maxGapMinutes >= minGap * 1.5;

  let summary: string;
  if (departures.length === 0) {
    summary = `No further Route ${q.routeId} departures are scheduled from this stop in the next ${windowMinutes} minutes.`;
  } else if (departures.length === 1) {
    summary = `This is the last scheduled Route ${q.routeId} departure from this stop within ${windowMinutes} minutes.`;
  } else if (degrades) {
    summary = `Route ${q.routeId} runs about every ${minGap} minutes earlier on, but the gaps stretch to ${maxGapMinutes} minutes later in the day. Missing the next one costs ${nextGapMinutes} minutes.`;
  } else {
    summary = `Route ${q.routeId} is running about every ${medianGapMinutes} minutes here, so missing the next one costs roughly ${nextGapMinutes} minutes.`;
  }

  return {
    routeId: q.routeId,
    stopId: q.stopId,
    gapsMinutes,
    nextGapMinutes,
    medianGapMinutes,
    maxGapMinutes,
    degrades,
    summary,
    departures,
  };
}
