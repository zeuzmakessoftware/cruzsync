/**
 * Waiting-place types.
 *
 * The central design rule: amenity facts are `Tristate`, not `boolean`.
 *
 * A café is not automatically quiet. A bookshop does not automatically have a
 * restroom. A restaurant does not automatically have step-free access. Inferring
 * any of those from a category would produce confident, plausible, wrong advice
 * -- and a wheelchair user acting on an invented accessibility claim is a real
 * person having a bad evening. So anything we have not actually sourced is
 * `'unknown'`, and the UI renders that as "unknown", never as a quiet absence.
 */
export type Tristate = true | false | "unknown";

export type PlaceSource =
  "openstreetmap" | "google-places" | "verified-fixture";

export interface OpeningHours {
  /** Raw upstream value, kept verbatim for auditing. */
  raw: string | null;
  /** Whether we could actually parse it into usable windows. */
  parsed: boolean;
  /**
   * Windows for the specific day being asked about, as minutes after midnight.
   * Empty with parsed=true means "closed today".
   */
  todayWindows: { openMin: number; closeMin: number }[];
  /** Where the hours came from, and when we read them. */
  source: PlaceSource;
  fetchedAtMs: number;
}

export interface WaitPlace {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** e.g. 'cafe', 'books', 'marketplace', 'library', 'park'. */
  category: string;
  /** Human-readable category for display. */
  categoryLabel: string;
  source: PlaceSource;
  /** Present when the upstream provider reports it. */
  businessStatus:
    "OPERATIONAL" | "CLOSED_TEMPORARILY" | "CLOSED_PERMANENTLY" | "unknown";
  website: string | null;
  address: string | null;
  hours: OpeningHours | null;

  /* --- amenity facts: sourced or 'unknown', never inferred from category --- */
  hasWifi: Tristate;
  hasRestroom: Tristate;
  wheelchairAccessible: Tristate;
  isIndoor: Tristate;
  isQuiet: Tristate;
  servesFood: Tristate;
  /** Can you sit here without buying anything? */
  freeToEnter: Tristate;
  locallyOwned: Tristate;
  /** Rough price level when a provider supplies one. */
  priceLevel: number | null;

  /** True only when a partner relationship exists AND is disclosed in the UI. */
  sponsored: boolean;
}

export interface WalkEstimate {
  seconds: number;
  metres: number;
  /** False only when a real walking-route provider produced this. */
  estimated: boolean;
  provider: "haversine-estimate" | "google-routes";
}

/** A place that has passed the deterministic feasibility check. */
export interface WaitCandidate {
  place: WaitPlace;
  walk: WalkEstimate;
  /** Usable minutes at the place after all buffers. */
  usableWaitSeconds: number;
  leaveByMs: number;
  wrapUpAtMs: number;
  /** All of these must hold for `feasible` to be true. */
  checks: {
    openThroughLeaveBy: Tristate;
    enoughUsableTime: boolean;
    matchesFilters: boolean;
  };
  feasible: boolean;
  /** Why it is or is not recommendable, in rider-facing language. */
  reasons: string[];
  blockedReasons: string[];
  /** Concrete ranking explanation, e.g. "4-min walk, open until 9 PM, 18 usable minutes". */
  summary: string;
  score: number;
}

export interface PlaceFilters {
  requireFree: boolean;
  requireIndoor: boolean;
  requireQuiet: boolean;
  requireWifi: boolean;
  requireFood: boolean;
  requireRestroom: boolean;
  requireWheelchairAccess: boolean;
  requireOpenLate: boolean;
  preferLocallyOwned: boolean;
  maxSpendUsd: number | null;
}

export const NO_FILTERS: PlaceFilters = {
  requireFree: false,
  requireIndoor: false,
  requireQuiet: false,
  requireWifi: false,
  requireFood: false,
  requireRestroom: false,
  requireWheelchairAccess: false,
  requireOpenLate: false,
  preferLocallyOwned: false,
  maxSpendUsd: null,
};

export interface PlacesProvider {
  readonly name: PlaceSource;
  /** Places near a point, within `radiusMetres`. */
  search(args: {
    lat: number;
    lon: number;
    radiusMetres: number;
    limit: number;
  }): Promise<WaitPlace[]>;
  /** Richer detail for one place, when the provider supports it. */
  details?(id: string): Promise<WaitPlace | null>;
}
