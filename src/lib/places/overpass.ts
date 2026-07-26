/**
 * OpenStreetMap / Overpass provider. Keyless, so CruzSync works for anyone who
 * clones the repo with no billing account.
 *
 * OSM's coverage of opening hours in downtown Santa Cruz is partial -- at the
 * time of writing roughly 40% of nearby venues publish `opening_hours`. That is
 * not a defect we hide; it is surfaced as "hours unknown", and the safe-wait
 * engine refuses to green-light a visit it cannot verify.
 */
import { agencyDayOfWeek } from "@/lib/gtfs/time";
import { parseOpeningHours } from "./hours";
import type { PlacesProvider, Tristate, WaitPlace } from "./types";

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const CATEGORY_LABELS: Record<string, string> = {
  cafe: "Café",
  restaurant: "Restaurant",
  fast_food: "Quick food",
  bar: "Bar",
  pub: "Pub",
  library: "Public library",
  books: "Bookshop",
  coffee: "Coffee shop",
  marketplace: "Market hall",
  deli: "Deli",
  bakery: "Bakery",
  supermarket: "Market",
  community_centre: "Community centre",
  park: "Public park",
  garden: "Public garden",
  square: "Public square",
  arts_centre: "Arts centre",
  museum: "Museum",
};

/** OSM tag -> Tristate, with absence meaning unknown rather than false. */
function tri(
  value: string | undefined,
  truthy: string[],
  falsy: string[],
): Tristate {
  if (value === undefined) return "unknown";
  const v = value.toLowerCase();
  if (truthy.includes(v)) return true;
  if (falsy.includes(v)) return false;
  return "unknown";
}

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export function mapOverpassElement(
  el: OverpassElement,
  nowMs: number,
): WaitPlace | null {
  const tags = el.tags ?? {};
  const name = tags.name;
  if (!name) return null;
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (lat === undefined || lon === undefined) return null;

  const category =
    tags.amenity ?? tags.shop ?? tags.leisure ?? tags.tourism ?? "place";
  const outdoorCategories = ["park", "garden", "square"];

  const address =
    tags["addr:housenumber"] && tags["addr:street"]
      ? `${tags["addr:housenumber"]} ${tags["addr:street"]}`
      : (tags["addr:street"] ?? null);

  return {
    id: `osm:${el.type}/${el.id}`,
    name,
    lat,
    lon,
    category,
    categoryLabel: CATEGORY_LABELS[category] ?? category.replaceAll("_", " "),
    source: "openstreetmap",
    // OSM has no business_status equivalent we can rely on.
    businessStatus: "unknown",
    website: tags.website ?? tags["contact:website"] ?? null,
    address,
    hours: parseOpeningHours(
      tags.opening_hours,
      agencyDayOfWeek(nowMs),
      "openstreetmap",
      nowMs,
    ),

    // Each of these comes from an explicit tag or stays unknown. There is
    // deliberately no `category === 'cafe' -> hasWifi = true` shortcut here.
    hasWifi: tri(tags.internet_access, ["wlan", "yes", "wifi"], ["no"]),
    hasRestroom: tri(
      tags.toilets ?? tags["toilets:access"],
      ["yes", "customers", "public"],
      ["no"],
    ),
    wheelchairAccessible: tri(tags.wheelchair, ["yes"], ["no"]),
    // Indoor-ness is the one thing an OSM *category* genuinely determines: a
    // park is not indoors. We still only assert it for unambiguous categories.
    isIndoor: outdoorCategories.includes(category)
      ? false
      : [
            "cafe",
            "restaurant",
            "library",
            "books",
            "marketplace",
            "bakery",
            "deli",
            "museum",
          ].includes(category)
        ? true
        : "unknown",
    // Quietness is subjective and untagged. Never guessed.
    isQuiet: "unknown",
    servesFood: tri(tags.food, ["yes"], ["no"]),
    // A library or park generally requires no purchase; anything else is unknown.
    freeToEnter: [
      "library",
      "park",
      "garden",
      "square",
      "community_centre",
    ].includes(category)
      ? true
      : "unknown",
    locallyOwned: tags.brand || tags["brand:wikidata"] ? false : "unknown",
    priceLevel: null,
    sponsored: false,
  };
}

/**
 * Kept deliberately lean. Overpass is a shared free service and a broad query
 * with many regex clauses gets throttled (429) or times out (504) in practice,
 * which for a rider means no suggestions at all. Three tight clauses return the
 * same useful venues far more reliably.
 */
function buildQuery(lat: number, lon: number, radius: number): string {
  const r = Math.round(radius);
  return `[out:json][timeout:25];
(
  nwr["amenity"~"^(cafe|restaurant|library|bakery|marketplace)$"](around:${r},${lat},${lon});
  nwr["shop"~"^(books|coffee|deli)$"](around:${r},${lat},${lon});
  nwr["leisure"="park"](around:${r},${lat},${lon});
);
out center tags 50;`;
}

export class OverpassProvider implements PlacesProvider {
  readonly name = "openstreetmap" as const;

  constructor(private readonly nowMs: () => number = () => Date.now()) {}

  async search(args: {
    lat: number;
    lon: number;
    radiusMetres: number;
    limit: number;
  }): Promise<WaitPlace[]> {
    const body = buildQuery(args.lat, args.lon, args.radiusMetres);
    let lastError: unknown = null;

    // Overpass is a free, shared, heavily rate-limited service. 429 and 504 are
    // routine rather than exceptional, so we rotate endpoints and back off
    // instead of failing the rider's request on the first refusal.
    for (const endpoint of OVERPASS_ENDPOINTS) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ data: body }).toString(),
            signal: AbortSignal.timeout(40_000),
          });
          if (res.status === 429 || res.status === 504) {
            lastError = new Error(`Overpass returned HTTP ${res.status}`);
            await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
            continue;
          }
          if (!res.ok) throw new Error(`Overpass returned HTTP ${res.status}`);

          const json = (await res.json()) as { elements?: OverpassElement[] };
          const now = this.nowMs();
          const places = (json.elements ?? [])
            .map((el) => mapOverpassElement(el, now))
            .filter((p): p is WaitPlace => p !== null);
          // Deduplicate by name+rounded position; OSM often has both a node and a way.
          const seen = new Set<string>();
          return places
            .filter((p) => {
              const key = `${p.name}@${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            })
            .slice(0, args.limit);
        } catch (err) {
          lastError = err;
          // A hard error is not worth retrying against the same endpoint.
          break;
        }
      }
    }
    throw new Error(
      `All Overpass endpoints failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }
}
