import { NextResponse } from "next/server";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { runAgent } from "@/lib/agent/orchestrator";
import { getSnapshot } from "@/lib/rt/provider";
import { DEFAULT_PREFERENCES } from "@/lib/engine/types";
import { DEMO_SCENES, getScene } from "@fixtures/scenes";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const bodySchema = z.object({
  message: z.string().min(1).max(1000),
  direction: z.enum(["to-campus", "to-home"]),
  destinationKey: z.string().max(64).optional(),
  sceneId: z.string().max(64).optional(),
  demo: z.boolean().optional(),
  elapsedMs: z
    .number()
    .min(0)
    .max(6 * 3600_000)
    .optional(),
  preferences: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(request: Request) {
  const cfg = getConfig();
  let parsed;
  try {
    parsed = bodySchema.safeParse(await request.json());
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      },
      { status: 400 },
    );
  }
  const body = parsed.data;
  const demo = body.demo ?? cfg.demoMode;
  const scene = demo ? (getScene(body.sceneId ?? "") ?? DEMO_SCENES[0]) : null;
  const nowMs = scene ? scene.anchorMs + (body.elapsedMs ?? 0) : Date.now();

  try {
    const { snapshot, nowMs: effectiveNow } = await getSnapshot({
      demo,
      sceneId: scene?.id,
      nowMs,
    });

    const result = await runAgent({
      message: body.message,
      direction: body.direction,
      destinationKey: body.destinationKey,
      snapshot,
      nowMs: effectiveNow,
      demo,
      preferences: { ...DEFAULT_PREFERENCES, ...(body.preferences ?? {}) },
    });

    return NextResponse.json({
      ...result,
      nowMs: effectiveNow,
      snapshotOrigin: snapshot.origin,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Agent failed" },
      { status: 500 },
    );
  }
}
