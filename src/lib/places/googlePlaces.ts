/**
 * Google Places (New) provider, used only when GOOGLE_PLACES_API_KEY is set.
 *
 * Worth having because current opening hours and `businessStatus` genuinely
 * matter here -- a rider sent to a permanently closed café has been given bad
 * advice. Runs server-side only so the key never reaches the browser.
 *
 * Even with Google's richer data we keep the unknown-unless-sourced rule: Places
 * does not tell us whether somewhere is quiet, has Wi-Fi, or is locally owned,
 * so those stay 'unknown'.
 */
import { agencyDayOfWeek } from '@/lib/gtfs/time';
import type { OpeningHours, PlacesProvider, WaitPlace } from './types';

const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchNearby';

const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.primaryType',
  'places.primaryTypeDisplayName',
  'places.businessStatus',
  'places.websiteUri',
  'places.regularOpeningHours',
  'places.currentOpeningHours',
  'places.priceLevel',
  'places.accessibilityOptions',
].join(',');

const INCLUDED_TYPES = [
  'cafe',
  'coffee_shop',
  'book_store',
  'library',
  'bakery',
  'restaurant',
  'park',
  'market',
];

interface GooglePeriodPoint {
  day: number;
  hour: number;
  minute: number;
}

interface GoogleOpeningHours {
  periods?: { open?: GooglePeriodPoint; close?: GooglePeriodPoint }[];
  weekdayDescriptions?: string[];
}

interface GooglePlace {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude: number; longitude: number };
  primaryType?: string;
  primaryTypeDisplayName?: { text?: string };
  businessStatus?: string;
  websiteUri?: string;
  regularOpeningHours?: GoogleOpeningHours;
  currentOpeningHours?: GoogleOpeningHours;
  priceLevel?: string;
  accessibilityOptions?: { wheelchairAccessibleEntrance?: boolean };
}

const PRICE_LEVELS: Record<string, number> = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

/** Converts Google's structured periods into our day-scoped windows. */
export function mapGoogleHours(
  hours: GoogleOpeningHours | undefined,
  dayOfWeek: number,
  nowMs: number,
): OpeningHours | null {
  if (!hours?.periods?.length) return null;
  const windows: { openMin: number; closeMin: number }[] = [];
  for (const p of hours.periods) {
    if (!p.open) continue;
    if (p.open.day !== dayOfWeek) continue;
    const openMin = p.open.hour * 60 + p.open.minute;
    if (!p.close) {
      // Open with no close = open 24 hours that day.
      windows.push({ openMin, closeMin: 24 * 60 });
      continue;
    }
    let closeMin = p.close.hour * 60 + p.close.minute;
    if (p.close.day !== p.open.day || closeMin <= openMin) closeMin += 24 * 60;
    windows.push({ openMin, closeMin });
  }
  return {
    raw: hours.weekdayDescriptions?.[(dayOfWeek + 6) % 7] ?? null,
    parsed: true,
    todayWindows: windows,
    source: 'google-places',
    fetchedAtMs: nowMs,
  };
}

export function mapGooglePlace(p: GooglePlace, nowMs: number): WaitPlace | null {
  if (!p.location || !p.displayName?.text) return null;
  const category = p.primaryType ?? 'place';
  const outdoor = ['park', 'plaza', 'garden'].includes(category);

  return {
    id: `google:${p.id}`,
    name: p.displayName.text,
    lat: p.location.latitude,
    lon: p.location.longitude,
    category,
    categoryLabel: p.primaryTypeDisplayName?.text ?? category.replaceAll('_', ' '),
    source: 'google-places',
    businessStatus:
      p.businessStatus === 'OPERATIONAL' ||
      p.businessStatus === 'CLOSED_TEMPORARILY' ||
      p.businessStatus === 'CLOSED_PERMANENTLY'
        ? p.businessStatus
        : 'unknown',
    website: p.websiteUri ?? null,
    address: p.formattedAddress ?? null,
    hours:
      mapGoogleHours(p.currentOpeningHours ?? p.regularOpeningHours, agencyDayOfWeek(nowMs), nowMs) ??
      null,

    // Google does not report these, so they remain unknown rather than guessed.
    hasWifi: 'unknown',
    hasRestroom: 'unknown',
    wheelchairAccessible:
      p.accessibilityOptions?.wheelchairAccessibleEntrance === true
        ? true
        : p.accessibilityOptions?.wheelchairAccessibleEntrance === false
          ? false
          : 'unknown',
    isIndoor: outdoor ? false : 'unknown',
    isQuiet: 'unknown',
    servesFood: ['restaurant', 'cafe', 'bakery', 'coffee_shop'].includes(category) ? true : 'unknown',
    freeToEnter: ['library', 'park'].includes(category) ? true : 'unknown',
    locallyOwned: 'unknown',
    priceLevel: p.priceLevel ? (PRICE_LEVELS[p.priceLevel] ?? null) : null,
    sponsored: false,
  };
}

export class GooglePlacesProvider implements PlacesProvider {
  readonly name = 'google-places' as const;

  constructor(
    private readonly apiKey: string,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  async search(args: {
    lat: number;
    lon: number;
    radiusMetres: number;
    limit: number;
  }): Promise<WaitPlace[]> {
    const res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify({
        includedTypes: INCLUDED_TYPES,
        maxResultCount: Math.min(20, args.limit),
        locationRestriction: {
          circle: {
            center: { latitude: args.lat, longitude: args.lon },
            radius: Math.min(50_000, args.radiusMetres),
          },
        },
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      throw new Error(`Google Places returned HTTP ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as { places?: GooglePlace[] };
    const now = this.nowMs();
    return (json.places ?? [])
      .map((p) => mapGooglePlace(p, now))
      .filter((p): p is WaitPlace => p !== null)
      // A permanently closed venue is never a candidate.
      .filter((p) => p.businessStatus !== 'CLOSED_PERMANENTLY');
  }
}
