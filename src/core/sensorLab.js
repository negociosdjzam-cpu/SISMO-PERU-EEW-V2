import { haversineKm, theoreticalArrivals } from "./geo.js";

const VP = 6.0; // km/s: experimental P-wave association only.

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
    this.history = [];
    this.totalPicks = 0;
    this.lastCandidateKey = "";
    this.lastCandidate = null;
    this.lastAssociationAttempt = null;
    this.listeners = new Set();
    this.triggerListeners = new Set();
  }

  onCandidate(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  onTrigger(fn) { this.triggerListeners.add(fn); return () => this.triggerListeners.delete(fn); }
  emit(x) { for (const f of this.listeners) { try{f(x)}catch{} } }
  emitTrigger(x) { for (const f of this.triggerListeners) { try{f(x)}catch{} } }

  ingest(t) {
    if (!t?.stationId || !Number.isFinite(Number(t.lat)) || !Number.isFinite(Number(t.lon))) return null;
    const detectedMs = new Date(t.detectedAt).getTime();
    if (!Number.isFinite(detectedMs)) return null;

    const trig = {
      stationId:String(t.stationId),
      network:String(t.network || ""),
      channel:String(t.channel || ""),
      lat:Number(t.lat),
      lon:Number(t.lon),
      detectedAt:new Date(detectedMs).toISOString(),
      receivedAt:new Date().toISOString(),
      phase:String(t.phase || "P").toUpperCase(),
      quality:Number.isFinite(Number(t.quality)) ? Number(t.quality) : null,
      picker:String(t.picker || "unknown"),
      snr:Number.isFinite(Number(t.snr)) ? Number(t.snr) : null,
      triggerPeak:Number.isFinite(Number(t.triggerPeak)) ? Number(t.triggerPeak) : null
    };

    this.totalPicks += 1;
    this.history.push(trig);
    if (this.history.length > 250) this.history.splice(0, this.history.length - 250);

    this.triggers.push(trig);
    // Associate relative to newest observed pick so normal network delay does not destroy a cluster.
    const newest = Math.max(...this.triggers.map(x=>new Date(x.detectedAt).getTime()));
    this.triggers = this.triggers.filter(x => new Date(x.detectedAt).getTime() >= newest - this.windowMs);

    const latestByStation = new Map();
    for (const x of this.triggers) {
      if (x.phase !== "P") continue;
      const prev=latestByStation.get(x.stationId);
      if (!prev || new Date(x.detectedAt) > new Date(prev.detectedAt)) latestByStation.set(x.stationId,x);
    }
    const xs = [...latestByStation.values()];

    this.emitTrigger({
      trigger:trig,
      telemetry:this.getTelemetry(),
      activeForAssociation:xs.length
    });

    if (xs.length < this.minStations) {
      this.lastAssociationAttempt = {
        at:new Date().toISOString(),
        status:"WAITING_STATIONS",
        stationCount:xs.length,
        minStations:this.minStations,
        stations:xs.map(x=>x.stationId)
      };
      return null;
    }

    const candidate = this.locate(xs);
    if (!candidate) {
      this.lastAssociationAttempt = {
        at:new Date().toISOString(),
        status:"LOCATOR_FAILED",
        stationCount:xs.length
      };
      return null;
    }

    if (candidate.residualRmsSec > this.maxRmsSec) {
      this.lastAssociationAttempt = {
        at:new Date().toISOString(),
        status:"REJECTED_RMS",
        stationCount:xs.length,
        residualRmsSec:candidate.residualRmsSec,
        maxRmsSec:this.maxRmsSec,
        stations:xs.map(x=>x.stationId)
      };
      return null;
    }

    const key = `${Math.round(new Date(candidate.time).getTime()/2500)}:${candidate.stationCount}:${candidate.lat.toFixed(2)}:${candidate.lon.toFixed(2)}`;
    this.lastAssociationAttempt = {
      at:new Date().toISOString(),
      status:"CANDIDATE_ACCEPTED",
      stationCount:xs.length,
      residualRmsSec:candidate.residualRmsSec,
      maxRmsSec:this.maxRmsSec
    };

    if (key === this.lastCandidateKey) return candidate;
    this.lastCandidateKey = key;

    candidate.arrivals = this.targets.map(t => theoreticalArrivals(candidate, t));
    this.lastCandidate = candidate;
    this.emit(candidate);
    return candidate;
  }

  getTelemetry(nowMs=Date.now()) {
    const cutoff = nowMs - this.windowMs;
    const active = this.history.filter(x => {
      const t=new Date(x.detectedAt).getTime();
      return x.phase==="P" && Number.isFinite(t) && t >= cutoff && t <= nowMs + 5000;
    });

    const latestByStation = new Map();
    for (const x of active) {
      const prev=latestByStation.get(x.stationId);
      if (!prev || new Date(x.detectedAt) > new Date(prev.detectedAt)) latestByStation.set(x.stationId,x);
    }
    const stationPicks=[...latestByStation.values()]
      .sort((a,b)=>new Date(b.detectedAt)-new Date(a.detectedAt));
    const count=stationPicks.length;

    let state="QUIET";
    if (count===1) state="PICK_OBSERVED";
    else if (count>1 && count<this.minStations) state="CORRELATING";
    else if (count>=this.minStations) state="EVALUATING";

    const recentPicks=this.history.slice(-30).reverse().map(x=>({
      ...x,
      ageSec:Math.max(0,Math.round((nowMs-new Date(x.detectedAt).getTime())/100)/10)
    }));

    return {
      state,
      minStations:this.minStations,
      windowSec:Math.round(this.windowMs/1000),
      maxRmsSec:this.maxRmsSec,
      activeStationCount:count,
      stationsNeeded:Math.max(0,this.minStations-count),
      progress:Math.min(1,Math.round((count/this.minStations)*100)/100),
      activeStations:stationPicks.map(x=>({
        stationId:x.stationId,
        network:x.network,
        channel:x.channel,
        detectedAt:x.detectedAt,
        snr:x.snr,
        quality:x.quality,
        picker:x.picker
      })),
      totalPicks:this.totalPicks,
      lastPick:this.history.length ? this.history[this.history.length-1] : null,
      recentPicks,
      lastAssociationAttempt:this.lastAssociationAttempt,
      lastCandidate:this.lastCandidate
    };
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
      createdAt:new Date().toISOString(),
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
      stations:xs.map(x=>({
        id:x.stationId,network:x.network,channel:x.channel,picker:x.picker,
        quality:x.quality,snr:x.snr,detectedAt:x.detectedAt
      })),
      avgPickQuality:Math.round(avgQuality*100)/100,
      confidence:Math.round(confidence*100)/100,
      residualRmsSec:Math.round(best.residualRmsSec*1000)/1000,
      algorithm:"multistage_grid_p_arrival_vp6_experimental"
    };
  }
}
