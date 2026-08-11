import express from "express";
import { FusionEngine } from "./core/fusion.js";
import { SensorLab } from "./core/sensorLab.js";
import { inBounds } from "./core/geo.js";
import { EmscSource } from "./sources/emsc.js";
import { UsgsSource } from "./sources/usgs.js";

const app = express();
app.disable("x-powered-by");
app.use(express.json({limit:"512kb"}));
app.use(express.static("public", {maxAge:"30s"}));

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
let waveformTelemetry = {
  receivedAt:null,
  sentAt:null,
  status:{state:"WAITING_FOR_WAVEFORM_GATEWAY"}
};

const fusion = new FusionEngine({
  clusterTimeSec:Number(process.env.CLUSTER_TIME_SEC || 120),
  clusterDistanceKm:Number(process.env.CLUSTER_DISTANCE_KM || 120),
  targets
});
const sensorLab = new SensorLab({
  minStations:Number(process.env.SENSOR_MIN_STATIONS || 4),
  windowSec:Number(process.env.SENSOR_WINDOW_SEC || 18),
  maxRmsSec:Number(process.env.SENSOR_MAX_RMS_SEC || 1.2),
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
sensorLab.onTrigger(x => publish("sensor_trigger", x));
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

function _ageSec(iso) {
  if (!iso) return Infinity;
  const ms = Date.now() - new Date(iso).getTime();
  return Number.isFinite(ms) ? Math.max(0, ms / 1000) : Infinity;
}

function buildAlertState() {
  const detection = sensorLab.getTelemetry();
  const candidate = sensorCandidates[0] || detection.lastCandidate || null;
  const event = fusion.latest();

  const targetArrival = (x) => {
    if (!x?.arrivals?.length) return null;
    return x.arrivals.find(a => a.targetId === targets[0]?.id) || x.arrivals[0] || null;
  };

  // Nivel 3: fuente oficial peruana. No se expresa como "100%" porque ninguna
  // medición sísmica debe presentarse como certeza matemática absoluta.
  if (event?.hasOfficialPeru && _ageSec(event.time) <= 300) {
    return {
      level:3,
      code:"OFFICIAL_CONFIRMED",
      severity:"danger",
      title:"SISMO CONFIRMADO POR FUENTE OFICIAL",
      message:"El evento coincide con una entrada oficial del IGP. Protégete ahora y sigue las indicaciones de las autoridades.",
      action:"AGÁCHATE · CÚBRETE · SUJÉTATE",
      source:"IGP",
      eventId:event.id,
      confidence:event.confidence,
      arrival:targetArrival(event),
      experimental:false,
      at:new Date().toISOString()
    };
  }

  // Nivel 2: dos o más fuentes externas independientes coinciden y el evento
  // es reciente. Es una corroboración fuerte, aunque no equivale a un boletín IGP.
  if (event?.sourceCount >= 2 && _ageSec(event.time) <= 180) {
    return {
      level:2,
      code:"CORROBORATED_EVENT",
      severity:"danger",
      title:"SISMO CORROBORADO · PROTÉGETE",
      message:`Coinciden ${event.sourceCount} fuentes independientes (${(event.sources||[]).join(", ")}).`,
      action:"AGÁCHATE · CÚBRETE · SUJÉTATE",
      source:(event.sources||[]).join(" + "),
      eventId:event.id,
      confidence:event.confidence,
      arrival:targetArrival(event),
      experimental:false,
      at:new Date().toISOString()
    };
  }

  // Nivel 1: solo nuestra red de formas de onda. Requiere 4+ estaciones,
  // buena coherencia temporal y alta confianza antes de mostrar PREALERTA.
  if (
    candidate &&
    _ageSec(candidate.createdAt || candidate.time) <= 60 &&
    Number(candidate.stationCount) >= Math.max(4, sensorLab.minStations) &&
    Number(candidate.confidence) >= 0.82 &&
    Number(candidate.residualRmsSec) <= 1.0
  ) {
    return {
      level:1,
      code:"EXPERIMENTAL_PREALERT",
      severity:"warning",
      title:"POSIBLE SISMO · PREPÁRATE",
      message:`${candidate.stationCount} estaciones presentan señales compatibles. La detección aún es experimental y espera corroboración externa.`,
      action:"PREPÁRATE PARA PROTEGERTE",
      source:"Red sísmica experimental",
      eventId:candidate.id,
      confidence:candidate.confidence,
      arrival:targetArrival(candidate),
      experimental:true,
      at:new Date().toISOString()
    };
  }

  return {
    level:0,
    code:"NORMAL",
    severity:"normal",
    title:"MONITOREO NORMAL",
    message:"No hay un evento sísmico que cumpla los criterios de alerta.",
    action:null,
    source:null,
    eventId:null,
    confidence:null,
    arrival:null,
    experimental:false,
    at:new Date().toISOString()
  };
}

function telemetryPayload() {
  return {
    ok:true,
    service:"SISMO PERU EEW TELEMETRY",
    version:"2.6.0",
    now:new Date().toISOString(),
    warning:"Telemetría experimental. Un PICK no equivale a terremoto ni a alerta oficial.",
    targets,
    sources:status,
    waveform:waveformTelemetry,
    detection:sensorLab.getTelemetry(),
    candidates:{
      count:sensorCandidates.length,
      latest:sensorCandidates[0] || null
    },
    alert:buildAlertState(),
    events:{
      count:fusion.list(500).length,
      latest:fusion.latest()
    }
  };
}

app.get("/health", (_req,res) => {
  res.json({
    ok:true,
    service:"SISMO PERU FUSION ENGINE",
    version:"2.6.0",
    now:new Date().toISOString(),
    sources:status,
    waveformTelemetryAt:waveformTelemetry.receivedAt
  });
});

app.get("/api/eew/status", (_req,res) => {
  res.json({
    ok:true,
    warning:"Motor experimental. No sustituye IGP/INDECI ni constituye alerta temprana oficial.",
    bounds,
    targets,
    sources:status,
    waveform:waveformTelemetry,
    detection:sensorLab.getTelemetry(),
    eventCount:fusion.list(500).length,
    sensorCandidateCount:sensorCandidates.length
  });
});

app.get("/api/eew/telemetry", (_req,res) => res.json(telemetryPayload()));
app.get("/api/eew/alert-state", (_req,res) => res.json({ok:true,alert:buildAlertState()}));
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
  res.write(`event: hello\ndata: ${JSON.stringify({ok:true,version:"2.6.0",now:new Date().toISOString()})}\n\n`);
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

app.post("/api/eew/ingest/sensor-trigger", requireToken, (req,res) => {
  const b=req.body || {};
  const c=sensorLab.ingest({
    stationId:b.stationId,
    network:b.network,
    channel:b.channel,
    lat:Number(b.lat),
    lon:Number(b.lon),
    detectedAt:b.detectedAt || new Date().toISOString(),
    phase:b.phase || "P",
    quality:b.quality,
    picker:b.picker,
    snr:b.snr,
    triggerPeak:b.triggerPeak
  });
  res.json({
    ok:true,
    candidate:c || null,
    correlation:sensorLab.getTelemetry()
  });
});

app.post("/api/eew/ingest/waveform-telemetry", requireToken, (req,res) => {
  const b=req.body || {};
  waveformTelemetry = {
    sentAt:b.sentAt || null,
    receivedAt:new Date().toISOString(),
    status:b.status || b
  };
  publish("waveform_telemetry", waveformTelemetry);
  res.json({ok:true,receivedAt:waveformTelemetry.receivedAt});
});

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
  console.log(`[SISMO PERU EEW V2.6] escuchando en :${PORT}`);
  console.log(`[SISMO PERU EEW V2.6] objetivo(s): ${targets.map(t=>t.name).join(", ")}`);
});
