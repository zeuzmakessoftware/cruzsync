/**
 * Chooses where a real-time snapshot comes from, and is the only place that
 * decision is made.
 *
 * The invariant CruzSync will not break: a snapshot's `origin` always tells the
 * truth. Demo fixtures are never relabelled as live, and a live fetch failure
 * never silently becomes a fixture without `degradedReason` saying so.
 */
import { getScene, DEFAULT_SCENE_ID } from "@fixtures/scenes";
import {
  fetchRealtimeSnapshot,
  getCachedSnapshot,
  RealtimeUnavailableError,
} from "./fetch";
import type { RealtimeSnapshot } from "./types";

export interface SnapshotRequest {
  /** Force demo fixtures regardless of config. */
  demo?: boolean;
  /** Which fixture scene to build, when in demo mode. */
  sceneId?: string;
  /** The clock to evaluate against. Demo scenes run from their own anchor. */
  nowMs?: number;
}

export interface SnapshotResult {
  snapshot: RealtimeSnapshot;
  /** The effective clock. In demo mode this is the scene's simulated time. */
  nowMs: number;
  sceneId?: string;
}

export async function getSnapshot(
  req: SnapshotRequest = {},
): Promise<SnapshotResult> {
  if (req.demo) {
    const scene =
      getScene(req.sceneId ?? DEFAULT_SCENE_ID) ?? getScene(DEFAULT_SCENE_ID)!;
    const nowMs = req.nowMs ?? scene.anchorMs;
    return { snapshot: scene.build(nowMs), nowMs, sceneId: scene.id };
  }

  const nowMs = req.nowMs ?? Date.now();
  try {
    const snapshot = await fetchRealtimeSnapshot({ nowMs });
    return { snapshot, nowMs };
  } catch (err) {
    if (err instanceof RealtimeUnavailableError) {
      const cached = getCachedSnapshot();
      if (cached) {
        return {
          snapshot: {
            ...cached,
            origin: "cache",
            degradedReason: `Live feeds unreachable (${err.message}). Showing the last successful snapshot.`,
          },
          nowMs,
        };
      }
      // No live data and nothing cached. We return an *empty* live-shaped
      // snapshot rather than fixtures, so the UI shows a genuine outage state
      // instead of pretending demo buses are real ones.
      return {
        snapshot: {
          vehicles: [],
          tripUpdates: [],
          alerts: [],
          freshness: {
            fetchedAtMs: nowMs,
            feedTimestampMs: null,
            ageSeconds: 0,
            label: "expired",
          },
          origin: "live",
          degradedReason: `No real-time data available: ${err.message}. Schedule-only information is still shown; nothing here is a live vehicle observation.`,
          sources: [],
        },
        nowMs,
      };
    }
    throw err;
  }
}
