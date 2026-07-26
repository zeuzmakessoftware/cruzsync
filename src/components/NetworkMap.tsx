'use client';

/**
 * The two-leg network map.
 *
 * Reads at a glance: Route 35 is one long line from Scotts Valley into downtown,
 * and Routes 11/18/19 are three separate loops from downtown up to campus. The
 * three RiverFront areas are drawn as distinct, individually labelled markers so
 * the transfer is visibly a walk between two places, not a single dot.
 *
 * Vehicles with real-time evidence are drawn as solid arrows; scheduled-only
 * trips appear as hollow rings, and both carry a text label in their popup so
 * the distinction never depends on colour alone.
 */
import { useEffect, useMemo } from 'react';
import { MapContainer, TileLayer, Polyline, CircleMarker, Marker, Popup, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { RIVERFRONT, SCOTTS_VALLEY, ROUTE_META } from '@/lib/domain';
import type { NormalisedVehicle } from '@/lib/rt/types';

export interface MapShape {
  routeId: string;
  directionId: number;
  points: [number, number][];
}

const AREA_STYLE: Record<string, { color: string; n: string }> = {
  [RIVERFRONT.AREA_1.stopId]: { color: 'var(--sunrise-500)', n: '1' },
  [RIVERFRONT.AREA_2.stopId]: { color: 'var(--pacific-700)', n: '2' },
  [RIVERFRONT.AREA_3.stopId]: { color: 'var(--redwood-600)', n: '3' },
};

function areaIcon(n: string, color: string) {
  return L.divIcon({
    className: '',
    html: `<div style="
      width:30px;height:30px;border-radius:50%;
      background:${color};color:#fff;border:3px solid #fff;
      box-shadow:0 1px 4px rgba(0,0,0,.45);
      display:flex;align-items:center;justify-content:center;
      font:700 14px/1 ui-sans-serif,system-ui,sans-serif;">${n}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

function FitBounds({ points }: { points: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    if (points.length < 2) return;
    map.fitBounds(L.latLngBounds(points), { padding: [28, 28] });
  }, [map, points]);
  return null;
}

export default function NetworkMap({
  shapes,
  vehicles,
  highlightRouteIds,
  observedTripIds,
}: {
  shapes: MapShape[];
  vehicles: NormalisedVehicle[];
  highlightRouteIds: string[];
  /** Trips with credible real-time evidence, drawn differently from the rest. */
  observedTripIds: string[];
}) {
  const highlighted = useMemo(() => new Set(highlightRouteIds), [highlightRouteIds]);
  const observed = useMemo(() => new Set(observedTripIds), [observedTripIds]);

  const allPoints = useMemo<[number, number][]>(
    () => [
      [SCOTTS_VALLEY.lat, SCOTTS_VALLEY.lon],
      [RIVERFRONT.AREA_2.lat, RIVERFRONT.AREA_2.lon],
      [36.9999, -122.0623],
    ],
    [],
  );

  return (
    <MapContainer
      center={[36.99, -122.04]}
      zoom={12}
      scrollWheelZoom={false}
      style={{ height: '100%', width: '100%' }}
      aria-label="Map of Route 35 between Scotts Valley and downtown Santa Cruz, and Routes 11, 18 and 19 between downtown and UCSC"
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        maxZoom={19}
      />
      <FitBounds points={allPoints} />

      {shapes.map((s) => {
        const meta = ROUTE_META[s.routeId];
        const isHi = highlighted.has(s.routeId);
        return (
          <Polyline
            key={`${s.routeId}-${s.directionId}`}
            positions={s.points}
            pathOptions={{
              color: meta?.color ?? '#666',
              weight: isHi ? 5 : 2.5,
              opacity: isHi ? 0.95 : 0.35,
              // Route 35 solid (the trunk), campus routes dashed (the choice).
              dashArray: s.routeId === '35' ? undefined : '7 6',
            }}
          >
            <Tooltip sticky>
              Route {s.routeId} — {meta?.longName ?? ''}
            </Tooltip>
          </Polyline>
        );
      })}

      {vehicles
        .filter((v) => v.lat !== null && v.lon !== null)
        .map((v, i) => {
          const hasEvidence = v.tripId ? observed.has(v.tripId) : false;
          const color = ROUTE_META[v.routeId ?? '']?.color ?? '#555';
          return (
            <CircleMarker
              key={`${v.vehicleId ?? i}-${v.tripId ?? i}`}
              center={[v.lat!, v.lon!]}
              radius={hasEvidence ? 8 : 6}
              pathOptions={{
                color: '#fff',
                weight: 2,
                fillColor: color,
                // Hollow = we can see it but it is not driving a recommendation.
                fillOpacity: hasEvidence ? 1 : 0.25,
              }}
            >
              <Popup>
                <strong>Route {v.routeId}</strong>
                <br />
                Vehicle {v.vehicleId ?? 'unlabelled'}
                <br />
                {v.ageSeconds !== null ? `Position ${v.ageSeconds}s old` : 'Position age unknown'}
                <br />
                {hasEvidence ? 'Real-time evidence used' : 'Not used for a recommendation'}
                <br />
                {v.occupancyStatus
                  ? `Agency-reported occupancy: ${v.occupancyStatus.replaceAll('_', ' ').toLowerCase()}`
                  : 'Occupancy not reported'}
              </Popup>
            </CircleMarker>
          );
        })}

      <Marker
        position={[SCOTTS_VALLEY.lat, SCOTTS_VALLEY.lon]}
        icon={areaIcon('S', 'var(--pacific-800)')}
      >
        <Popup>
          <strong>{SCOTTS_VALLEY.name}</strong>
          <br />
          Where the Route 35 leg begins.
        </Popup>
      </Marker>

      {[RIVERFRONT.AREA_1, RIVERFRONT.AREA_2, RIVERFRONT.AREA_3].map((area) => {
        const st = AREA_STYLE[area.stopId];
        return (
          <Marker key={area.stopId} position={[area.lat, area.lon]} icon={areaIcon(st.n, st.color)}>
            <Popup>
              <strong>{area.label}</strong>
              <br />
              {area.name}
              <br />
              {area.role}
              <br />
              Stop {area.stopCode}
            </Popup>
          </Marker>
        );
      })}
    </MapContainer>
  );
}
