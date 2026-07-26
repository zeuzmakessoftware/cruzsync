import type { CampusRouteId } from "@/lib/domain";

/**
 * How much we actually know about a specific scheduled trip.
 *
 * `confidence` is an inspectable heuristic in [0,1], NOT a calibrated
 * probability. We have no historical outcome data to calibrate against, so the
 * UI always renders it alongside the signals that produced it and never as a
 * "chance the bus arrives".
 */
export type EvidenceLabel =
  | "observed" // a vehicle position is visible and recent
  | "reported" // no position, but a fresh trip update exists
  | "scheduled-only" // timetable only; nothing real-time
  | "stale" // real-time exists but is too old to lean on
  | "blocked"; // an alert or feed state rules this option out

export interface EvidenceSignal {
  key: string;
  /** Human-readable statement of what was observed. */
  detail: string;
  /** Contribution to the confidence score, positive or negative. */
  weight: number;
  /** Which feed this came from, for the evidence chips. */
  source:
    "vehicle_positions" | "trip_updates" | "service_alerts" | "static_schedule";
  /** Epoch ms of the underlying observation, when there is one. */
  observedAtMs: number | null;
}

export interface RouteEvidence {
  routeId: string;
  tripId: string;
  stopId: string;
  label: EvidenceLabel;
  confidence: number;
  signals: EvidenceSignal[];
  /** Scheduled departure from the stop in question. */
  scheduledDepartureMs: number;
  /** Schedule plus any observed deviation. Equals scheduled when nothing is known. */
  predictedDepartureMs: number;
  /** Plausible range, widened when evidence is weak. */
  departureRangeMs: [number, number];
  /** Seconds late (positive) or early (negative), when the feed says. */
  scheduleDeviationSec: number | null;
  vehicleVisible: boolean;
  vehicleAgeSeconds: number | null;
  tripUpdateAgeSeconds: number | null;
  /** Agency-reported occupancy, when the feed publishes it. Never inferred. */
  occupancyStatus: string | null;
  activeAlerts: { id: string; header: string | null; effect: string | null }[];
  /** Plain-language caveats shown to the rider verbatim. */
  caveats: string[];
}

export interface JourneyLeg {
  kind: "bus" | "walk";
  routeId?: string;
  tripId?: string;
  label: string;
  fromStopId: string;
  fromStopName: string;
  toStopId: string;
  toStopName: string;
  departureMs: number;
  arrivalMs: number;
  evidence?: RouteEvidence;
}

export interface MultilegTrip {
  legs: JourneyLeg[];
  /** [optimistic, conservative] arrival at the final destination. */
  expectedArrivalRangeMs: [number, number];
  /**
   * Slack at the downtown transfer:
   *   predicted UCSC departure - predicted Route 35 arrival - inter-area walk.
   * Negative means the connection does not stand up.
   */
  downtownTransferMarginSec: number | null;
  assumptions: string[];
  blockedReasons: string[];
  engineVersion: string;
}

export interface UcscOption {
  routeId: CampusRouteId;
  /** Undefined when this route simply does not serve the chosen destination. */
  tripId?: string;
  evidence?: RouteEvidence;
  /** Arrival at the rider's actual campus stop. */
  arrivalRangeMs?: [number, number];
  /** Lower is better. Composed of arrival time, transfer risk and preferences. */
  score: number;
  scoreBreakdown: { factor: string; detail: string; penaltySec: number }[];
  transferMarginSec: number | null;
  feasible: boolean;
  blockedReasons: string[];
  /** Ordered, rider-facing reasons this option ranked where it did. */
  rationale: string[];
}

export interface UcscComparison {
  destinationKey: string;
  destinationName: string;
  options: UcscOption[];
  /** The winning routeId, or null when nothing is feasible. */
  bestRouteId: CampusRouteId | null;
  /** Set when no option is safe to recommend. */
  undecidedReason: string | null;
  assumptions: string[];
  engineVersion: string;
}

export interface RiderPreferences {
  /**
   * The creator's own experience that Route 11 tends to be less crowded.
   * This is a SAVED PREFERENCE, not live data. It only ever breaks ties; it can
   * never override a route that actually gets the rider there sooner or safer.
   */
  preferQuieterRoute11: boolean;
  /** Extra seconds of margin the rider wants at the transfer. */
  extraTransferBufferSec: number;
  /** Rider walks more slowly than the default assumption. */
  reducedMobility: boolean;
  maxSpendUsd: number | null;
  requireIndoor: boolean;
  requireFree: boolean;
  wantQuiet: boolean;
  wantWifi: boolean;
  wantFood: boolean;
  wantRestroom: boolean;
  requireWheelchairAccess: boolean;
  wantOpenLate: boolean;
  preferLocallyOwned: boolean;
}

export const DEFAULT_PREFERENCES: RiderPreferences = {
  preferQuieterRoute11: true,
  extraTransferBufferSec: 0,
  reducedMobility: false,
  maxSpendUsd: null,
  requireIndoor: false,
  requireFree: false,
  wantQuiet: false,
  wantWifi: false,
  wantFood: false,
  wantRestroom: false,
  requireWheelchairAccess: false,
  wantOpenLate: false,
  preferLocallyOwned: false,
};
