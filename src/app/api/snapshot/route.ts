import { NextResponse } from 'next/server';
import { getSnapshot } from '@/lib/rt/provider';
import { publicRuntimeInfo, getConfig } from '@/lib/config';
import { gtfsMeta } from '@/lib/gtfs/feed';
import { FIXTURE_METADATA } from '@/lib/places/provider';
import { DEMO_SCENES, getScene } from '@fixtures/scenes';

export const dynamic = 'force-dynamic';

/** Current real-time snapshot plus everything the UI needs to label its sources. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const cfg = getConfig();
  const demo = url.searchParams.get('demo') === null ? cfg.demoMode : url.searchParams.get('demo') === 'true';
  const sceneId = url.searchParams.get('scene') ?? undefined;
  const elapsedMs = Number(url.searchParams.get('elapsedMs') ?? '0');

  // In demo mode the clock runs forward from the scene anchor, so countdowns
  // are genuinely live while the starting state stays reproducible.
  const scene = demo ? (getScene(sceneId ?? '') ?? DEMO_SCENES[0]) : null;
  const nowMs = scene ? scene.anchorMs + Math.max(0, elapsedMs) : Date.now();

  try {
    const { snapshot, nowMs: effectiveNow, sceneId: resolvedScene } = await getSnapshot({
      demo,
      sceneId: scene?.id,
      nowMs,
    });
    return NextResponse.json({
      snapshot,
      nowMs: effectiveNow,
      sceneId: resolvedScene ?? null,
      scenes: DEMO_SCENES.map((s) => ({
        id: s.id,
        title: s.title,
        narrative: s.narrative,
        anchorMs: s.anchorMs,
        direction: s.direction,
        campusDestinationKey: s.campusDestinationKey,
      })),
      runtime: publicRuntimeInfo(cfg),
      gtfs: {
        feedVersion: gtfsMeta.feedVersion,
        builtAt: gtfsMeta.builtAt,
        publisher: gtfsMeta.publisher,
        validFrom: gtfsMeta.feedStartDate,
        validTo: gtfsMeta.feedEndDate,
      },
      placesFixture: FIXTURE_METADATA,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Snapshot failed' },
      { status: 503 },
    );
  }
}
