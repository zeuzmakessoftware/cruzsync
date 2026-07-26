export interface GtfsMeta {
  feedVersion: string;
  feedStartDate: string;
  feedEndDate: string;
  publisher: string;
  builtAt: string;
  source: string;
  keptRoutes: string[];
  counts: Record<string, number>;
}

export interface GtfsRoute {
  route_id: string;
  route_short_name: string;
  route_long_name: string;
  route_color: string;
  route_url: string;
}

export interface GtfsTrip {
  trip_id: string;
  route_id: string;
  service_id: string;
  trip_headsign: string;
  direction_id: number;
  shape_id: string;
  wheelchair_accessible: string;
}

export interface GtfsStop {
  stop_id: string;
  stop_code: string;
  stop_name: string;
  stop_lat: number;
  stop_lon: number;
  wheelchair_boarding: string;
}

export interface GtfsStopTime {
  trip_id: string;
  /** Seconds after midnight of the service day. May exceed 86400 (e.g. 24:03:00). */
  arrivalSec: number;
  departureSec: number;
  stop_id: string;
  stop_sequence: number;
  /** GTFS pickup_type; '1' means no pickup available at this stop. */
  pickup_type: string;
  drop_off_type: string;
}

export interface GtfsCalendar {
  service_id: string;
  monday: string;
  tuesday: string;
  wednesday: string;
  thursday: string;
  friday: string;
  saturday: string;
  sunday: string;
  start_date: string;
  end_date: string;
}

export interface GtfsCalendarDate {
  service_id: string;
  date: string;
  /** '1' = service added on this date, '2' = removed. */
  exception_type: string;
}

export interface GtfsShape {
  routeId: string;
  directionId: number;
  shapeId: string;
  points: [number, number][];
}

/** A scheduled stop event resolved onto a concrete calendar date. */
export interface ScheduledDeparture {
  tripId: string;
  routeId: string;
  serviceId: string;
  directionId: number;
  headsign: string;
  stopId: string;
  stopSequence: number;
  /** Absolute epoch ms for the scheduled departure, service-day aware. */
  departureEpochMs: number;
  arrivalEpochMs: number;
  /** The service date this trip belongs to, as YYYYMMDD. */
  serviceDate: string;
}
