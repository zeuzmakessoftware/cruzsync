import CruzSyncApp from "@/components/CruzSyncApp";
import { getShapesForRoute } from "@/lib/gtfs/feed";
import { CAMPUS_ROUTE_IDS, TRUNK_ROUTE_ID } from "@/lib/domain";

/**
 * Route geometry is read from the committed GTFS on the server and passed down,
 * so the browser never parses the feed and the map has something to draw on the
 * first paint.
 */
export default function Page() {
  const shapes = [TRUNK_ROUTE_ID, ...CAMPUS_ROUTE_IDS].flatMap((routeId) =>
    getShapesForRoute(routeId).map((s) => ({
      routeId: s.routeId,
      directionId: s.directionId,
      points: s.points,
    })),
  );

  return <CruzSyncApp shapes={shapes} />;
}
