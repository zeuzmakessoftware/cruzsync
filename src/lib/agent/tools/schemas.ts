/**
 * Tool schemas.
 *
 * Every tool declares a Zod schema for BOTH its arguments and its result, and
 * both are validated at runtime. A model that hallucinates an argument gets a
 * structured validation error back rather than silently corrupting a journey
 * calculation, and a tool that returns the wrong shape fails loudly here rather
 * than deep inside the UI.
 *
 * These Zod schemas are also the single source of the JSON Schema sent to Gemma
 * as `functionDeclarations`, so the model's contract and our validation can
 * never drift apart.
 */
import { z } from 'zod';
import { CAMPUS_ROUTE_IDS } from '@/lib/domain';

const routeId = z.string().min(1).max(8).describe('Santa Cruz METRO route id, e.g. "35", "11".');
const stopId = z.string().min(1).max(16).describe('GTFS stop_id.');
const tripId = z.string().min(1).max(24).describe('GTFS trip_id.');

const campusRouteId = z.enum(CAMPUS_ROUTE_IDS);

export const riderPreferencesSchema = z
  .object({
    preferQuieterRoute11: z
      .boolean()
      .default(true)
      .describe(
        "The rider's own saved note that Route 11 usually feels less crowded. This is a personal preference, NOT live crowding data.",
      ),
    extraTransferBufferSec: z.number().int().min(0).max(1800).default(0),
    reducedMobility: z.boolean().default(false),
    maxSpendUsd: z.number().min(0).max(200).nullable().default(null),
    requireIndoor: z.boolean().default(false),
    requireFree: z.boolean().default(false),
    wantQuiet: z.boolean().default(false),
    wantWifi: z.boolean().default(false),
    wantFood: z.boolean().default(false),
    wantRestroom: z.boolean().default(false),
    requireWheelchairAccess: z.boolean().default(false),
    wantOpenLate: z.boolean().default(false),
    preferLocallyOwned: z.boolean().default(false),
  })
  .partial()
  .describe('Rider preferences. Omit fields the rider has not mentioned.');

export const placeFiltersSchema = z
  .object({
    requireFree: z.boolean().default(false),
    requireIndoor: z.boolean().default(false),
    requireQuiet: z.boolean().default(false),
    requireWifi: z.boolean().default(false),
    requireFood: z.boolean().default(false),
    requireRestroom: z.boolean().default(false),
    requireWheelchairAccess: z.boolean().default(false),
    requireOpenLate: z.boolean().default(false),
    preferLocallyOwned: z.boolean().default(false),
    maxSpendUsd: z.number().min(0).max(200).nullable().default(null),
  })
  .partial();

/* ---------------------------------------------------------------- */
/* Argument schemas                                                   */
/* ---------------------------------------------------------------- */

export const toolArgSchemas = {
  get_vehicle_positions: z.object({
    routeId: routeId.optional(),
    tripId: tripId.optional(),
    vehicleId: z.string().max(24).optional(),
  }),

  get_trip_updates: z.object({
    routeId: routeId.optional(),
    tripId: tripId.optional(),
    stopId: stopId.optional(),
  }),

  get_service_alerts: z.object({
    routeId: routeId.optional(),
    stopId: stopId.optional(),
  }),

  get_stop_schedule: z.object({
    stopId,
    serviceDate: z
      .string()
      .regex(/^\d{8}$/)
      .optional()
      .describe('YYYYMMDD. Defaults to the current service day.'),
    timeWindowMinutes: z.number().int().min(5).max(720).default(90),
    routeIds: z.array(routeId).max(8).optional(),
    directionId: z
      .number()
      .int()
      .min(0)
      .max(1)
      .optional()
      .describe(
        'Required for Route 35 at RiverFront Area 2, where inbound and outbound trips share one stop. 0 = outbound toward Scotts Valley, 1 = inbound to downtown. Omitting it mixes both directions and produces a meaningless headway.',
      ),
  }),

  build_multileg_trip: z.object({
    originStopId: stopId.optional().describe('Where the rider boards Route 35. Defaults to Scotts Valley.'),
    destinationKey: z
      .string()
      .describe('Campus destination key, e.g. "science-hill", "crown-merrill", "kerr-hall".'),
    departureTime: z.string().datetime().optional().describe('ISO 8601. Defaults to now.'),
    route35TripId: tripId.optional().describe('The Route 35 trip the rider is already on, if known.'),
    preferences: riderPreferencesSchema.optional(),
  }),

  analyze_route_evidence: z.object({
    routeId,
    stopId,
    scheduledTripId: tripId,
    currentTime: z.string().datetime().optional(),
  }),

  compare_ucsc_options: z.object({
    downtownStopId: stopId
      .optional()
      .describe('Defaults to RiverFront Area 1, where Routes 11/18/19 depart.'),
    campusDestination: z.string().describe('Campus destination key.'),
    candidateRouteIds: z.array(campusRouteId).min(1).max(3).default(['11', '18', '19']),
    earliestAtArea1: z.string().datetime().optional(),
    preferences: riderPreferencesSchema.optional(),
  }),

  get_nearby_wait_places: z.object({
    boardingStopId: stopId,
    availableMinutes: z.number().int().min(0).max(300),
    filters: placeFiltersSchema.optional(),
    radiusMetres: z.number().int().min(100).max(2000).default(600),
  }),

  get_place_details: z.object({
    placeId: z.string().min(1),
    fields: z.array(z.string()).max(20).optional(),
  }),

  get_walking_time: z.object({
    originPlaceId: z.string().min(1),
    destinationStopId: stopId,
  }),

  calculate_safe_wait: z.object({
    predictedDeparture: z.string().datetime(),
    walkSeconds: z.number().int().min(0).max(7200),
    boardingBufferSeconds: z.number().int().min(0).max(3600).optional(),
    uncertaintyBufferSeconds: z.number().int().min(0).max(3600).optional(),
    minimumUsefulVisitSeconds: z.number().int().min(0).max(7200).optional(),
  }),

  recommend_next_action: z.object({
    direction: z.enum(['to-campus', 'to-home']),
    destinationKey: z.string().optional(),
    preferences: riderPreferencesSchema.optional(),
    considerWaitPlaces: z.boolean().default(true),
  }),
} as const;

export type ToolName = keyof typeof toolArgSchemas;

export const TOOL_NAMES = Object.keys(toolArgSchemas) as ToolName[];

/* ---------------------------------------------------------------- */
/* Result schemas                                                     */
/* ---------------------------------------------------------------- */

const freshnessSchema = z.object({
  fetchedAtMs: z.number(),
  feedTimestampMs: z.number().nullable(),
  ageSeconds: z.number(),
  label: z.enum(['fresh', 'stale', 'expired']),
});

/** Present on every tool result so the model can cite its sources honestly. */
const waitPlaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  categoryLabel: z.string(),
  address: z.string().nullable(),
  hoursKnown: z.boolean(),
  hoursRaw: z.string().nullable(),
  walkSeconds: z.number(),
  walkIsEstimated: z.boolean(),
  usableWaitSeconds: z.number(),
  leaveByIso: z.string(),
  feasible: z.boolean(),
  summary: z.string(),
  reasons: z.array(z.string()),
  blockedReasons: z.array(z.string()),
  amenities: z.record(z.string(), z.union([z.boolean(), z.literal('unknown')])),
  sponsored: z.boolean(),
});

const provenanceSchema = z.object({
  source: z.string(),
  origin: z.enum(['live', 'cache', 'fixture']),
  observedAtIso: z.string().nullable(),
  freshness: freshnessSchema.nullable(),
  engineVersion: z.string().optional(),
});

const evidenceSchema = z.object({
  routeId: z.string(),
  tripId: z.string(),
  stopId: z.string(),
  label: z.enum(['observed', 'reported', 'scheduled-only', 'stale', 'blocked']),
  confidence: z.number(),
  confidenceIsCalibrated: z
    .literal(false)
    .describe('Always false. This is an inspectable heuristic, not a probability.'),
  vehicleVisible: z.boolean(),
  vehicleAgeSeconds: z.number().nullable(),
  scheduleDeviationSec: z.number().nullable(),
  occupancyStatus: z.string().nullable(),
  scheduledDepartureIso: z.string(),
  predictedDepartureIso: z.string(),
  signals: z.array(
    z.object({ key: z.string(), detail: z.string(), weight: z.number(), source: z.string() }),
  ),
  caveats: z.array(z.string()),
  activeAlerts: z.array(z.object({ id: z.string(), header: z.string().nullable(), effect: z.string().nullable() })),
});

export const toolResultSchemas = {
  get_vehicle_positions: z.object({
    provenance: provenanceSchema,
    count: z.number(),
    vehicles: z.array(
      z.object({
        vehicleId: z.string().nullable(),
        routeId: z.string().nullable(),
        tripId: z.string().nullable(),
        lat: z.number().nullable(),
        lon: z.number().nullable(),
        speedMps: z.number().nullable(),
        ageSeconds: z.number().nullable(),
        occupancyStatus: z.string().nullable(),
      }),
    ),
  }),

  get_trip_updates: z.object({
    provenance: provenanceSchema,
    count: z.number(),
    tripUpdates: z.array(
      z.object({
        tripId: z.string().nullable(),
        routeId: z.string().nullable(),
        delaySec: z.number().nullable(),
        scheduleRelationship: z.string().nullable(),
        ageSeconds: z.number().nullable(),
        stopCount: z.number(),
      }),
    ),
  }),

  get_service_alerts: z.object({
    provenance: provenanceSchema,
    count: z.number(),
    alerts: z.array(
      z.object({
        id: z.string(),
        effect: z.string().nullable(),
        header: z.string().nullable(),
        description: z.string().nullable(),
        informedRouteIds: z.array(z.string()),
        active: z.boolean(),
      }),
    ),
  }),

  get_stop_schedule: z.object({
    provenance: provenanceSchema,
    stopId: z.string(),
    stopName: z.string(),
    serviceDate: z.string(),
    departures: z.array(
      z.object({
        routeId: z.string(),
        tripId: z.string(),
        headsign: z.string(),
        scheduledDepartureIso: z.string(),
        directionId: z.number(),
      }),
    ),
    headway: z
      .object({
        nextGapMinutes: z.number().nullable(),
        medianGapMinutes: z.number().nullable(),
        maxGapMinutes: z.number().nullable(),
        degrades: z.boolean(),
        summary: z.string(),
      })
      .nullable(),
  }),

  build_multileg_trip: z.object({
    provenance: provenanceSchema,
    legs: z.array(
      z.object({
        kind: z.enum(['bus', 'walk']),
        routeId: z.string().optional(),
        label: z.string(),
        fromStopName: z.string(),
        toStopName: z.string(),
        departureIso: z.string(),
        arrivalIso: z.string(),
      }),
    ),
    expectedArrivalRange: z.tuple([z.string(), z.string()]).nullable(),
    downtownTransferMarginSec: z.number().nullable(),
    /** Feed this into compare_ucsc_options so both agree on the transfer time. */
    earliestAtArea1Iso: z.string(),
    assumptions: z.array(z.string()),
    blockedReasons: z.array(z.string()),
  }),

  analyze_route_evidence: z.object({
    provenance: provenanceSchema,
    evidence: evidenceSchema,
  }),

  compare_ucsc_options: z.object({
    provenance: provenanceSchema,
    destinationKey: z.string(),
    destinationName: z.string(),
    bestRouteId: z.string().nullable(),
    undecidedReason: z.string().nullable(),
    assumptions: z.array(z.string()),
    options: z.array(
      z.object({
        routeId: z.string(),
        tripId: z.string().optional(),
        feasible: z.boolean(),
        score: z.number(),
        transferMarginSec: z.number().nullable(),
        arrivalRange: z.tuple([z.string(), z.string()]).optional(),
        scoreBreakdown: z.array(
          z.object({ factor: z.string(), detail: z.string(), penaltySec: z.number() }),
        ),
        blockedReasons: z.array(z.string()),
        evidence: evidenceSchema.optional(),
      }),
    ),
  }),

  get_nearby_wait_places: z.object({
    provenance: provenanceSchema,
    boardingStopId: z.string(),
    boardingStopName: z.string(),
    placesProvider: z.string(),
    count: z.number(),
    places: z.array(waitPlaceSchema),
    fallbackAdvice: z.string().nullable(),
  }),

  get_place_details: z.object({
    provenance: provenanceSchema,
    found: z.boolean(),
    place: z
      .object({
        id: z.string(),
        name: z.string(),
        categoryLabel: z.string(),
        address: z.string().nullable(),
        website: z.string().nullable(),
        businessStatus: z.string(),
        hoursKnown: z.boolean(),
        hoursRaw: z.string().nullable(),
        todayWindows: z.array(z.object({ opens: z.string(), closes: z.string() })),
        amenities: z.record(z.string(), z.union([z.boolean(), z.literal('unknown')])),
      })
      .nullable(),
  }),

  get_walking_time: z.object({
    provenance: provenanceSchema,
    seconds: z.number(),
    metres: z.number(),
    estimated: z.boolean(),
    provider: z.string(),
  }),

  calculate_safe_wait: z.object({
    provenance: provenanceSchema,
    leaveByIso: z.string(),
    wrapUpAtIso: z.string(),
    usableWaitSeconds: z.number(),
    hasUsefulTime: z.boolean(),
    breakdown: z.array(z.object({ label: z.string(), seconds: z.number() })),
  }),

  recommend_next_action: z.object({
    provenance: provenanceSchema,
    action: z.enum([
      'CATCH ROUTE 35',
      'TRANSFER TO 11',
      'TRANSFER TO 18',
      'TRANSFER TO 19',
      'WAIT AT STOP',
      'WAIT AT A PLACE',
      'DATA TOO UNCERTAIN',
    ]),
    headline: z.string(),
    subhead: z.string(),
    boardingStopId: z.string().nullable(),
    boardingStopLabel: z.string().nullable(),
    departureIso: z.string().nullable(),
    leaveByIso: z.string().nullable(),
    reevaluateAtIso: z.string().nullable(),
    backupPlan: z.string(),
    blockedReasons: z.array(z.string()),
    evidenceRefs: z.array(z.string()),
    /**
     * The wait-place ranking this recommendation was actually built from,
     * computed with the same buffers as `leaveByIso`. The UI renders this rather
     * than a separately-computed list so the two can never disagree by a minute.
     */
    waitPlaces: z.array(waitPlaceSchema).nullable(),
    fallbackAdvice: z.string().nullable(),
  }),
} as const;

/** The JSON Schema handed to Gemma. Generated from the same Zod definitions. */
export function toolJsonSchema(name: ToolName): Record<string, unknown> {
  return z.toJSONSchema(toolArgSchemas[name], { io: 'input', target: 'draft-7' }) as Record<
    string,
    unknown
  >;
}

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  get_vehicle_positions:
    'Current GTFS-Realtime vehicle positions from Santa Cruz METRO. Absence of a vehicle means no position is being published; it does NOT mean the trip is cancelled.',
  get_trip_updates:
    'GTFS-Realtime trip updates including delay and schedule relationship. Only this feed can tell you a trip is genuinely cancelled.',
  get_service_alerts: 'Active GTFS-Realtime service alerts affecting a route or stop.',
  get_stop_schedule:
    'Scheduled departures from a stop for the active service day, plus the computed headway. Use this rather than guessing frequencies.',
  build_multileg_trip:
    'Builds the full journey: Route 35 into RiverFront Area 2, the walk to Area 1, then a campus route to the destination. Returns transfer margin and arrival range.',
  analyze_route_evidence:
    'Scores how much is actually known about one scheduled trip at one stop, returning the contributing signals.',
  compare_ucsc_options:
    'Ranks Routes 11, 18 and 19 for the downtown-to-campus leg only. Route 35 is never a candidate here — it is the other leg of the journey.',
  get_nearby_wait_places:
    'Finds places near a boarding stop where the rider could usefully spend a wait, with feasibility already computed. Only feasible places should be recommended.',
  get_place_details: 'Detailed record for one place, including opening hours and what is unknown.',
  get_walking_time: 'Walking time from a place back to a boarding stop.',
  calculate_safe_wait:
    'Computes leave-by time and usable wait from a predicted departure and a walking time. Always use this instead of doing the arithmetic yourself.',
  recommend_next_action:
    'Produces the final structured recommendation. Call this last, after gathering evidence.',
};
