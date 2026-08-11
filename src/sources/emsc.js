import WebSocket from "ws";

const URL = "wss://www.seismicportal.eu/standing_order/websocket";

export class EmscSource {
  constructor({onEvent, onStatus, bounds}) {
    this.onEvent = onEvent;
    this.onStatus = onStatus || (()=>{});
    this.bounds = bounds;
    this.ws = null;
    this.stopped = false;
    this.backoff = 1000;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    try { this.ws?.close(); } catch {}
  }

  connect() {
    if (this.stopped) return;
    this.onStatus({source:"EMSC", state:"connecting"});
    const ws = new WebSocket(URL, { handshakeTimeout: 10000 });
    this.ws = ws;

    ws.on("open", () => {
      this.backoff = 1000;
      this.onStatus({source:"EMSC", state:"connected", at:new Date().toISOString()});
    });

    ws.on("message", raw => {
      try {
        const msg = JSON.parse(raw.toString());
        const f = msg?.data;
        const p = f?.properties || {};
        const coords = f?.geometry?.coordinates || [];
        const lon = Number(p.lon ?? coords[0]);
        const lat = Number(p.lat ?? coords[1]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

        if (this.bounds) {
          if (lat < this.bounds.minLat || lat > this.bounds.maxLat ||
              lon < this.bounds.minLon || lon > this.bounds.maxLon) return;
        }

        this.onEvent({
          source: "EMSC",
          sourceId: String(p.unid || f.id || p.source_id || `${p.time}-${lat}-${lon}`),
          action: msg.action || "create",
          time: p.time,
          lat, lon,
          depthKm: Number(p.depth ?? Math.abs(Number(coords[2] || 0))),
          magnitude: p.mag == null ? null : Number(p.mag),
          magnitudeType: p.magtype || null,
          region: p.flynn_region || null,
          authority: p.auth || null,
          sourceCatalog: p.source_catalog || null,
          receivedAt: new Date().toISOString(),
          raw: { action: msg.action, id: f?.id }
        });
      } catch (err) {
        this.onStatus({source:"EMSC", state:"parse_error", error:String(err?.message || err)});
      }
    });

    ws.on("error", err => {
      this.onStatus({source:"EMSC", state:"error", error:String(err?.message || err)});
    });

    ws.on("close", () => {
      this.onStatus({source:"EMSC", state:"disconnected", at:new Date().toISOString()});
      if (!this.stopped) {
        const delay = this.backoff;
        this.backoff = Math.min(this.backoff * 2, 30000);
        setTimeout(() => this.connect(), delay);
      }
    });
  }
}
