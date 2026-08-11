import express from "express";
import { FusionEngine } from "./core/fusion.js";
import { SensorLab } from "./core/sensorLab.js";
import { inBounds } from "./core/geo.js";
import { EmscSource } from "./sources/emsc.js";
import { UsgsSource } from "./sources/usgs.js";

const app = express();
app.disable("x-powered-by");
app.use(express.json({limit:"256kb"}));
app.use(express.static("public", {maxAge:"5m"}));

const PORT = Number(process.env.PORT || 3000);
const bounds = {
  minLat:Number(process.env.PERU_MIN_LAT || -19.5),
  maxLat:Number(process.env.PERU_MAX_LAT || 0.5),
  minLon:Number(process.env.PERU_MIN_LON || -84.5),
  maxLon:Number(process.env.PERU_MAX_LON || -68.0)
};

let targets = [{id:"huancayo",name:"Huancayo",lat:-12.0651,lon:-75.2049}];
try {
  if (process.env.TARGETS_JSON) targets = JSON.parse(process.env.TARGETS_JSON);
} catch (e) {
  console.error("[config] TARGETS_JSON invalido:", e.message);
}

const status = {};
const fusion = new FusionEngine({
  clusterTimeSec:Number(process.env.CLUSTER_TIME_SEC || 120),
  clusterDistanceKm:Number(process.env.CLUSTER_DISTANCE_KM || 120),
  targets
});
const sensorLab = new SensorLab({
  minStations:Number(process.env.SENSOR_MIN_STATIONS || 4),
  windowSec:Number(process.env.SENSOR_WINDOW_SEC || 15),
  maxRmsSec:Number(process.env.SENSOR_MAX_RMS_SEC || 1.5),
  targets
});

const sseClients = new Set();
const sensorCandidates = [];
function publish(type, payload) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(res); }
  }
}

fusion.onEvent(ev => publish("fusion", ev));
sensorLab.onCandidate(c => {
  sensorCandidates.unshift(c);
  sensorCandidates.splice(20);
  publish("sensor_candidate", c);
});

function onStatus(s) {
  status[s.source] = s;
  publish("status", s);
}
function onEvent(e) {
  if (!inBounds(e, bounds)) return;
  fusion.ingest(e);
}

const emsc = new EmscSource({onEvent, onStatus, bounds});
const usgs = new UsgsSource({
  onEvent, onStatus, bounds,
  pollMs:Number(process.env.USGS_POLL_MS || 20000)
});

emsc.start();
usgs.start();

app.get("/health", (_req,res) => {
  res.json({
    ok:true,
    service:"SISMO PERU FUSION ENGINE",
    version:"2.0.0",
    now:new Date().toISOString(),
    sources:status
  });
});

app.get("/api/eew/status", (_req,res) => {
  res.json({
    ok:true,
    warning:"Motor experimental. No sustituye IGP/INDECI ni constituye alerta temprana oficial.",
    bounds,
    targets,
    sources:status,
    eventCount:fusion.list(500).length,
    sensorCandidateCount:sensorCandidates.length
  });
});

app.get("/api/eew/latest", (_req,res) => res.json({ok:true,event:fusion.latest()}));
app.get("/api/eew/events", (req,res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
  res.json({ok:true,events:fusion.list(limit)});
});
app.get("/api/eew/sensor-candidates", (_req,res) => res.json({ok:true,candidates:sensorCandidates}));

app.get("/api/eew/stream", (req,res) => {
  res.set({
    "Content-Type":"text/event-stream",
    "Cache-Control":"no-cache, no-transform",
    "Connection":"keep-alive",
    "X-Accel-Buffering":"no"
  });
  res.flushHeaders?.();
  res.write(`event: hello\ndata: ${JSON.stringify({ok:true,now:new Date().toISOString()})}\n\n`);
  sseClients.add(res);
  const keep = setInterval(() => {
    try { res.write(`: ping ${Date.now()}\n\n`); } catch {}
  }, 20000);
  req.on("close", () => { clearInterval(keep); sseClients.delete(res); });
});

function requireToken(req,res,next) {
  const expected = String(process.env.INGEST_TOKEN || "");
  if (!expected) return res.status(503).json({ok:false,error:"INGEST_TOKEN no configurado"});
  const got = String(req.headers.authorization || "").replace(/^Bearer\s+/i,"");
  if (got !== expected) return res.status(401).json({ok:false,error:"No autorizado"});
  next();
}

// Tu backend actual puede POSTear aquí cada reporte IGP normalizado.
app.post("/api/eew/ingest/igp", requireToken, (req,res) => {
  const b = req.body || {};
  const ev = {
    source:"IGP",
    sourceId:String(b.sourceId || b.id || ""),
    time:b.time,
    lat:Number(b.lat),
    lon:Number(b.lon),
    depthKm:Number(b.depthKm ?? b.depth ?? 0),
    magnitude:b.magnitude == null ? null : Number(b.magnitude),
    region:b.region || b.place || null,
    authority:"IGP/CENSIS",
    receivedAt:new Date().toISOString(),
    url:b.url || null
  };
  if (!ev.sourceId || !ev.time || !Number.isFinite(ev.lat) || !Number.isFinite(ev.lon))
    return res.status(400).json({ok:false,error:"sourceId,time,lat,lon son obligatorios"});
  if (!inBounds(ev,bounds)) return res.status(202).json({ok:true,ignored:"fuera de Peru"});
  const fused = fusion.ingest(ev);
  res.json({ok:true,event:fused});
});

// Gateway de sensores propios / Raspberry Shake local.
// Recibe PICKS P ya detectados; no recibe una supuesta "predicción".
app.post("/api/eew/ingest/sensor-trigger", requireToken, (req,res) => {
  const b=req.body || {};
  const c=sensorLab.ingest({
    stationId:b.stationId,
    lat:Number(b.lat),
    lon:Number(b.lon),
    detectedAt:b.detectedAt || new Date().toISOString(),
    phase:b.phase || "P",
    quality:b.quality
  });
  res.json({ok:true,candidate:c || null});
});

// Solo para laboratorios/control interno. NO se etiqueta como alerta oficial.
app.get("/api/eew/public-signal", (_req,res) => {
  const enabled = String(process.env.ENABLE_EXPERIMENTAL_PUBLIC_SIGNAL || "false").toLowerCase() === "true";
  const ev = fusion.latest();
  if (!enabled) return res.json({ok:true,enabled:false,signal:null});
  if (!ev || ev.confidence < 0.78) return res.json({ok:true,enabled:true,signal:null});
  res.json({
    ok:true,enabled:true,
    signal:{
      ...ev,
      label:"SEÑAL SÍSMICA EXPERIMENTAL",
      disclaimer:"No es alerta oficial ni predicción. Verifique IGP/INDECI."
    }
  });
});

app.listen(PORT, () => {
  console.log(`[SISMO PERU EEW V2] escuchando en :${PORT}`);
  console.log(`[SISMO PERU EEW V2] objetivo(s): ${targets.map(t=>t.name).join(", ")}`);
});
