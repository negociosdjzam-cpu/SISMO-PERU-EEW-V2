import { haversineKm, theoreticalArrivals } from "./geo.js";

const SOURCE_WEIGHT = {
  IGP: 1.6,
  EMSC: 1.0,
  USGS: 1.1,
  SENSOR: 0.8
};

function n(v, fallback = null) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function weightedAvg(obs, key) {
  let sum = 0, wsum = 0;
  for (const o of obs) {
    const v = n(o[key]);
    if (v === null) continue;
    const w = SOURCE_WEIGHT[o.source] || 1;
    sum += v * w;
    wsum += w;
  }
  return wsum ? sum / wsum : null;
}

function sourceKey(o) { return `${o.source}:${o.sourceId}`; }

export class FusionEngine {
  constructor({ clusterTimeSec=120, clusterDistanceKm=120, targets=[] } = {}) {
    this.clusterTimeMs = clusterTimeSec * 1000;
    this.clusterDistanceKm = clusterDistanceKm;
    this.targets = targets;
    this.clusters = new Map();
    this.seq = 1;
    this.listeners = new Set();
  }

  onEvent(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(payload) { for (const fn of this.listeners) { try { fn(payload); } catch {} } }

  ingest(obs) {
    if (!obs?.source || !obs?.sourceId || !obs?.time) return null;
    const t = new Date(obs.time).getTime();
    if (!Number.isFinite(t) || !Number.isFinite(Number(obs.lat)) || !Number.isFinite(Number(obs.lon))) return null;

    obs = {
      ...obs,
      lat: Number(obs.lat),
      lon: Number(obs.lon),
      depthKm: n(obs.depthKm, 0),
      magnitude: n(obs.magnitude),
      receivedAt: obs.receivedAt || new Date().toISOString()
    };

    let best = null;
    let bestScore = Infinity;

    for (const c of this.clusters.values()) {
      const dt = Math.abs(new Date(c.time).getTime() - t);
      if (dt > this.clusterTimeMs) continue;
      const km = haversineKm(c.lat, c.lon, obs.lat, obs.lon);
      if (km > this.clusterDistanceKm) continue;
      const magPenalty = (c.magnitude != null && obs.magnitude != null)
        ? Math.abs(c.magnitude - obs.magnitude) * 20 : 0;
      const score = km + dt / 1000 + magPenalty;
      if (score < bestScore) { best = c; bestScore = score; }
    }

    if (!best) {
      best = {
        id: `SPF-${Date.now()}-${this.seq++}`,
        createdAt: new Date().toISOString(),
        observations: []
      };
      this.clusters.set(best.id, best);
    }

    const key = sourceKey(obs);
    const idx = best.observations.findIndex(x => sourceKey(x) === key);
    if (idx >= 0) best.observations[idx] = obs;
    else best.observations.push(obs);

    this.recompute(best);
    this.gc();
    this.emit(best);
    return best;
  }

  recompute(c) {
    const obs = c.observations;
    c.lat = weightedAvg(obs, "lat");
    c.lon = weightedAvg(obs, "lon");
    c.depthKm = weightedAvg(obs, "depthKm");
    c.magnitude = weightedAvg(obs, "magnitude");
    c.time = new Date(Math.min(...obs.map(o => new Date(o.time).getTime()))).toISOString();
    c.updatedAt = new Date().toISOString();
    c.sources = [...new Set(obs.map(o => o.source))];
    c.sourceCount = c.sources.length;
    c.hasOfficialPeru = c.sources.includes("IGP");

    const receivedTimes = obs.map(o => new Date(o.receivedAt).getTime()).filter(Number.isFinite);
    c.firstReceivedAt = new Date(Math.min(...receivedTimes)).toISOString();
    c.latencySec = Math.max(0, (new Date(c.firstReceivedAt).getTime() - new Date(c.time).getTime()) / 1000);

    let confidence = c.sourceCount === 1 ? 0.45 : c.sourceCount === 2 ? 0.78 : 0.92;
    if (c.hasOfficialPeru) confidence = Math.max(confidence, 0.90);
    c.confidence = Math.min(0.99, Math.round(confidence * 100) / 100);

    if (c.hasOfficialPeru) c.classification = "OFFICIAL_CONFIRMED";
    else if (c.sourceCount >= 2) c.classification = "CORROBORATED_EVENT";
    else if (c.sources.includes("EMSC")) c.classification = "FAST_EXTERNAL_SIGNAL";
    else c.classification = "SINGLE_SOURCE_EVENT";

    c.isEarlyWarning = false;
    c.warningLabel = "No es alerta temprana oficial";
    c.arrivals = this.targets.map(t => theoreticalArrivals(c, t));
  }

  list(limit=50) {
    return [...this.clusters.values()]
      .sort((a,b) => new Date(b.time) - new Date(a.time))
      .slice(0, limit);
  }

  latest() { return this.list(1)[0] || null; }

  gc() {
    const cutoff = Date.now() - 6 * 60 * 60 * 1000;
    for (const [id,c] of this.clusters) {
      if (new Date(c.time).getTime() < cutoff) this.clusters.delete(id);
    }
  }
}
