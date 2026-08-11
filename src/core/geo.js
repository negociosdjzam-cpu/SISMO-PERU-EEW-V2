const R = 6371.0088;

export function toRad(x) { return x * Math.PI / 180; }

export function haversineKm(aLat, aLon, bLat, bLon) {
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const aa =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) *
    Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(aa));
}

export function hypocentralKm(event, target) {
  const horizontal = haversineKm(event.lat, event.lon, target.lat, target.lon);
  const depth = Math.max(0, Number(event.depthKm || 0));
  return Math.sqrt(horizontal ** 2 + depth ** 2);
}

export function theoreticalArrivals(event, target, nowMs = Date.now()) {
  // Aproximación de laboratorio, NO un modelo oficial de tiempos de viaje.
  const pathKm = hypocentralKm(event, target);
  const vp = 6.0;
  const vs = 3.5;
  const originMs = new Date(event.time).getTime();
  const pMs = originMs + (pathKm / vp) * 1000;
  const sMs = originMs + (pathKm / vs) * 1000;
  return {
    targetId: target.id,
    targetName: target.name,
    distanceKm: Math.round(pathKm * 10) / 10,
    pArrival: new Date(pMs).toISOString(),
    sArrival: new Date(sMs).toISOString(),
    pSecondsRemaining: Math.round((pMs - nowMs) / 100) / 10,
    sSecondsRemaining: Math.round((sMs - nowMs) / 100) / 10,
    model: "straight_path_vp6_vs3.5_experimental"
  };
}

export function inBounds(ev, b) {
  return ev.lat >= b.minLat && ev.lat <= b.maxLat &&
         ev.lon >= b.minLon && ev.lon <= b.maxLon;
}
