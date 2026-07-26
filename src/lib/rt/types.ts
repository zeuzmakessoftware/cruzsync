/** Normalised GTFS-Realtime types. Nothing protobuf-shaped escapes the server. */

export type FreshnessLabel = "fresh" | "stale" | "expired";

export interface Freshness {
  /** When CruzSync fetched the feed. */
  fetchedAtMs: number;
  /** The timestamp the agency stamped inside the feed header, if present. */
  feedTimestampMs: number | null;
  ageSeconds: number;
  label: FreshnessLabel;
}

export interface NormalisedVehicle {
  vehicleId: string | null;
  label: string | null;
  tripId: string | null;
  routeId: string | null;
  directionId: number | null;
  lat: number | null;
  lon: number | null;
  bearing: number | null;
  /** Metres per second, when the feed supplies it. */
  speedMps: number | null;
  /** GTFS-RT stop the vehicle is currently approaching/at. */
  currentStopId: string | null;
  currentStopSequence: number | null;
  currentStatus: string | null;
  /** Epoch ms of the vehicle's own position timestamp. */
  timestampMs: number | null;
  /** Age of this specific vehicle's position, in seconds, at fetch time. */
  ageSeconds: number | null;
  /**
   * Occupancy as reported by the agency. Null when absent -- CruzSync never
   * invents a crowding value, and no Santa Cruz METRO crowding feed exists today.
   */
  occupancyStatus: string | null;
}

export interface NormalisedStopTimeUpdate {
  stopId: string | null;
  stopSequence: number | null;
  /** Epoch ms, when the feed gives an absolute time. */
  arrivalTimeMs: number | null;
  departureTimeMs: number | null;
  /** Seconds of deviation from schedule; positive means late. */
  arrivalDelaySec: number | null;
  departureDelaySec: number | null;
  scheduleRelationship: string | null;
}

export interface NormalisedTripUpdate {
  tripId: string | null;
  routeId: string | null;
  directionId: number | null;
  startDate: string | null;
  vehicleId: string | null;
  timestampMs: number | null;
  /** Trip-level delay in seconds when supplied. */
  delaySec: number | null;
  scheduleRelationship: string | null;
  stopTimeUpdates: NormalisedStopTimeUpdate[];
}

export interface NormalisedAlert {
  id: string;
  cause: string | null;
  effect: string | null;
  headerText: string | null;
  descriptionText: string | null;
  url: string | null;
  /** Active period windows in epoch ms; null bound means open-ended. */
  activePeriods: { startMs: number | null; endMs: number | null }[];
  informedRouteIds: string[];
  informedStopIds: string[];
  informedTripIds: string[];
}

export interface RealtimeSnapshot {
  vehicles: NormalisedVehicle[];
  tripUpdates: NormalisedTripUpdate[];
  alerts: NormalisedAlert[];
  freshness: Freshness;
  /** 'live' = fetched from METRO now. 'cache' = last good copy. 'fixture' = demo data. */
  origin: "live" | "cache" | "fixture";
  /** Populated when we degraded, so the UI can say exactly what went wrong. */
  degradedReason?: string;
  sources: {
    name: string;
    url: string;
    ok: boolean;
    fetchedAtMs: number | null;
  }[];
}
