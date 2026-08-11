const URL = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson";

export class UsgsSource {
  constructor({onEvent, onStatus, bounds, pollMs=20000}) {
    this.onEvent = onEvent;
    this.onStatus = onStatus || (()=>{});
    this.bounds = bounds;
    this.pollMs = Math.max(10000, pollMs);
    this.timer = null;
    this.seen = new Map();
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.pollMs);
  }

  stop() { clearInterval(this.timer); }

  async tick() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const r = await fetch(URL, {
        headers: {"user-agent":"SISMO-PERU-FUSION/1.0"},
        signal: controller.signal
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      this.onStatus({source:"USGS", state:"ok", at:new Date().toISOString(), count:data?.features?.length || 0});

      for (const f of data?.features || []) {
        const [lon, lat, depth] = f.geometry?.coordinates || [];
        if (![lat,lon].every(Number.isFinite)) continue;
        if (this.bounds) {
          if (lat < this.bounds.minLat || lat > this.bounds.maxLat ||
              lon < this.bounds.minLon || lon > this.bounds.maxLon) continue;
        }

        const modified = Number(f.properties?.updated || f.properties?.time || 0);
        const prev = this.seen.get(f.id);
        if (prev === modified) continue;
        this.seen.set(f.id, modified);

        this.onEvent({
          source: "USGS",
          sourceId: String(f.id),
          time: new Date(Number(f.properties?.time)).toISOString(),
          lat: Number(lat),
          lon: Number(lon),
          depthKm: Number(depth || 0),
          magnitude: f.properties?.mag == null ? null : Number(f.properties.mag),
          magnitudeType: f.properties?.magType || null,
          region: f.properties?.place || null,
          authority: "USGS",
          receivedAt: new Date().toISOString(),
          url: f.properties?.url || null
        });
      }

      if (this.seen.size > 1000) {
        this.seen = new Map([...this.seen.entries()].slice(-500));
      }
    } catch (err) {
      this.onStatus({source:"USGS", state:"error", error:String(err?.message || err), at:new Date().toISOString()});
    } finally {
      clearTimeout(timeout);
    }
  }
}
