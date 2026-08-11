import assert from "node:assert/strict";
import { FusionEngine } from "../src/core/fusion.js";
import { haversineKm } from "../src/core/geo.js";

assert(haversineKm(-12.0651,-75.2049,-12.0651,-75.2049) < 0.001);

const f = new FusionEngine({
  targets:[{id:"huancayo",name:"Huancayo",lat:-12.0651,lon:-75.2049}]
});
const time = new Date(Date.now()-5000).toISOString();
f.ingest({source:"EMSC",sourceId:"a",time,lat:-12,lon:-75,depthKm:20,magnitude:5.2,receivedAt:new Date().toISOString()});
const x = f.ingest({source:"USGS",sourceId:"b",time,lat:-12.05,lon:-75.02,depthKm:22,magnitude:5.1,receivedAt:new Date().toISOString()});
assert.equal(x.sourceCount,2);
assert.equal(x.classification,"CORROBORATED_EVENT");
assert(x.arrivals.length===1);
console.log("OK smoke test");
