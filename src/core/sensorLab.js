import { haversineKm, theoreticalArrivals } from "./geo.js";

const VP = 6.0; // km/s: approximation for experimental P-wave association only.

function mean(a) { return a.reduce((s,x)=>s+x,0)/a.length; }
function rms(a) { return Math.sqrt(mean(a.map(x=>x*x))); }
function clamp(x,a,b){ return Math.max(a,Math.min(b,x)); }

export class SensorLab {
  constructor({minStations=4, windowSec=18, maxRmsSec=1.2, targets=[]}={}) {
    this.minStations = Math.max(4, minStations);
    this.windowMs = windowSec * 1000;
    this.maxRmsSec = maxRmsSec;
    this.targets = targets;
    this.triggers = [];
    this.lastCandidateKey = "";
    this.listeners = new Set();
  }

  onCandidate(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(x) { for (const f of this.listeners) { try{f(x)}catch{} } }

  ingest(t) {
    if (!t?.stationId || !Number.isFinite(Number(t.lat)) || !Number.isFinite(Number(t.lon))) return null;
    const detectedMs = new Date(t.detectedAt).getTime();
    if (!Number.isFinite(detectedMs)) return null;

    const trig = {
      stationId:String(t.stationId),
      network:String(t.network || ""),
      channel:String(t.channel || ""),
      lat:Number(t.lat), lon:Number(t.lon),
      detectedAt:new Date(detectedMs).toISOString(),
      phase:String(t.phase || "P").toUpperCase(),
      quality:Number.isFinite(Number(t.quality)) ? Number(t.quality) : null,
      picker:String(t.picker || "unknown")
    };

    this.triggers.push(trig);
    // Use newest observed pick, not server wall clock, so normal telemetry delay does not destroy association.
    const newest = Math.max(...this.triggers.map(x=>new Date(x.detectedAt).getTime()));
    this.triggers = this.triggers.filter(x => new Date(x.detectedAt).getTime() >= newest - this.windowMs);

    const latestByStation = new Map();
    for (const x of this.triggers) {
      if (x.phase !== "P") continue;
      const prev=latestByStation.get(x.stationId);
      if (!prev || new Date(x.detectedAt) > new Date(prev.detectedAt)) latestByStation.set(x.stationId,x);
    }
    const xs = [...latestByStation.values()];
    if (xs.length < this.minStations) return null;

    const candidate = this.locate(xs);
    if (!candidate || candidate.residualRmsSec > this.maxRmsSec) return null;

    const key = `${Math.round(new Date(candidate.time).getTime()/2500)}:${candidate.stationCount}:${candidate.lat.toFixed(2)}:${candidate.lon.toFixed(2)}`;
    if (key === this.lastCandidateKey) return candidate;
    this.lastCandidateKey = key;

    candidate.arrivals = this.targets.map(t => theoreticalArrivals(candidate, t));
    this.emit(candidate);
    return candidate;
  }

  scoreLocation(xs, lat, lon, depthKm) {
    const origins = xs.map(s => {
      const h = haversineKm(lat,lon,s.lat,s.lon);
      const path = Math.sqrt(h*h + depthKm*depthKm);
      return new Date(s.detectedAt).getTime()/1000 - path/VP;
    });
    const origin = mean(origins);
    const residuals = origins.map(x=>x-origin);
    return {lat,lon,depthKm,origin,residualRmsSec:rms(residuals)};
  }

  grid(xs, center, radiusDeg, stepDeg, depths) {
    let best=null;
    const lat0=center?.lat ?? mean(xs.map(x=>x.lat));
    const lon0=center?.lon ?? mean(xs.map(x=>x.lon));
    for(let lat=lat0-radiusDeg;lat<=lat0+radiusDeg+1e-9;lat+=stepDeg){
      if(lat < -25 || lat > 6) continue;
      for(let lon=lon0-radiusDeg;lon<=lon0+radiusDeg+1e-9;lon+=stepDeg){
        if(lon < -90 || lon > -60) continue;
        for(const depthKm of depths){
          const s=this.scoreLocation(xs,lat,lon,depthKm);
          if(!best || s.residualRmsSec<best.residualRmsSec) best=s;
        }
      }
    }
    return best;
  }

  locate(xs) {
    // 3-stage coarse-to-fine search. This is still a lab locator, not SeisComP/NonLinLoc.
    let best=this.grid(xs,null,5.0,0.5,[5,15,30,60,100,160]);
    if(!best) return null;
    best=this.grid(xs,best,0.75,0.1,[Math.max(3,best.depthKm-30),best.depthKm,Math.min(250,best.depthKm+30)]);
    best=this.grid(xs,best,0.16,0.025,[Math.max(3,best.depthKm-15),best.depthKm,Math.min(250,best.depthKm+15)]);

    const qualities=xs.map(x=>x.quality).filter(Number.isFinite);
    const avgQuality=qualities.length?mean(qualities):0.5;
    const stationFactor=clamp((xs.length-this.minStations+1)/4,0.25,1);
    const residualFactor=clamp(1-best.residualRmsSec/Math.max(this.maxRmsSec,0.1),0,1);
    const confidence=clamp(0.25 + 0.35*stationFactor + 0.25*residualFactor + 0.15*avgQuality,0,0.97);

    return {
      id:`SENSOR-${Date.now()}`,
      classification: confidence>=0.80 ? "SENSOR_CANDIDATE_HIGH" : "SENSOR_CANDIDATE",
      isEarlyWarning:false,
      warningLabel:"Candidato experimental por picks P; requiere corroboración",
      source:"SENSOR",
      time:new Date(best.origin*1000).toISOString(),
      lat:Math.round(best.lat*1000)/1000,
      lon:Math.round(best.lon*1000)/1000,
      depthKm:Math.round(best.depthKm*10)/10,
      magnitude:null,
      stationCount:xs.length,
      stations:xs.map(x=>({id:x.stationId,network:x.network,channel:x.channel,picker:x.picker,quality:x.quality})),
      avgPickQuality:Math.round(avgQuality*100)/100,
      confidence:Math.round(confidence*100)/100,
      residualRmsSec:Math.round(best.residualRmsSec*1000)/1000,
      algorithm:"multistage_grid_p_arrival_vp6_experimental"
    };
  }
}
