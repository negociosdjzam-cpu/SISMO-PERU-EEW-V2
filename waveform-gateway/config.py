import json, os
from dataclasses import dataclass

@dataclass
class Settings:
    fusion_url: str
    ingest_token: str
    bounds: tuple
    picker_mode: str
    gateway_port: int
    sta_sec: float
    lta_sec: float
    trigger_on: float
    trigger_off: float
    min_snr: float
    cooldown_sec: float
    fresh_pick_sec: float
    max_stations_per_server: int
    phasenet_weights: str
    phasenet_threshold: float
    auto_discovery: bool
    discovery_expand_deg: tuple
    endpoint_probe_timeout_sec: float


def _bool_env(name, default=True):
    raw=os.getenv(name, "true" if default else "false").strip().lower()
    return raw in {"1","true","yes","on","si","sí"}


def _bounds():
    raw=os.getenv("SEEDLINK_BOUNDS","-19.5,0.5,-84.5,-68.0")
    vals=[float(x.strip()) for x in raw.split(",")]
    if len(vals)!=4: raise ValueError("SEEDLINK_BOUNDS=minLat,maxLat,minLon,maxLon")
    return tuple(vals)


def _expand_steps():
    raw=os.getenv("DISCOVERY_EXPAND_DEG","0,3,6,10")
    vals=[]
    for x in raw.split(','):
        x=x.strip()
        if not x: continue
        v=max(0.0,float(x))
        if v not in vals: vals.append(v)
    return tuple(vals or [0.0])


def load_settings():
    return Settings(
        fusion_url=os.getenv("FUSION_URL","http://127.0.0.1:3000").rstrip("/"),
        ingest_token=os.getenv("INGEST_TOKEN", ""),
        bounds=_bounds(),
        picker_mode=os.getenv("PICKER_MODE","sta_lta").lower(),
        gateway_port=int(os.getenv("GATEWAY_PORT", os.getenv("PORT","8081"))),
        sta_sec=float(os.getenv("STA_SEC","0.6")),
        lta_sec=float(os.getenv("LTA_SEC","10.0")),
        trigger_on=float(os.getenv("TRIGGER_ON","4.2")),
        trigger_off=float(os.getenv("TRIGGER_OFF","1.5")),
        min_snr=float(os.getenv("MIN_SNR","4.0")),
        cooldown_sec=float(os.getenv("STATION_COOLDOWN_SEC","18")),
        fresh_pick_sec=float(os.getenv("FRESH_PICK_SEC","4")),
        max_stations_per_server=int(os.getenv("MAX_STATIONS_PER_SERVER","80")),
        phasenet_weights=os.getenv("PHASENET_WEIGHTS","geofon"),
        phasenet_threshold=float(os.getenv("PHASENET_P_THRESHOLD","0.35")),
        auto_discovery=_bool_env("AUTO_DISCOVERY", True),
        discovery_expand_deg=_expand_steps(),
        endpoint_probe_timeout_sec=float(os.getenv("ENDPOINT_PROBE_TIMEOUT_SEC","6")),
    )

# Candidate pools: canonical first, legacy aliases afterwards.
# The resolver probes them at runtime and follows HTTP redirects.
DEFAULT_SERVERS=[
  {
    "name":"EARTHSCOPE",
    "seedlink_candidates":[
      "rtserve.earthscope.org:18000",
      "rtserve.iris.washington.edu:18000"
    ],
    "station_candidates":[
      "https://service.earthscope.org/fdsnws/station/1/query",
      "https://service.iris.edu/fdsnws/station/1/query"
    ]
  },
  {
    "name":"GEOFON",
    "seedlink_candidates":[
      "geofon.gfz.de:18000",
      "geofon.gfz-potsdam.de:18000"
    ],
    "station_candidates":[
      "https://geofon.gfz.de/fdsnws/station/1/query",
      "https://geofon.gfz-potsdam.de/fdsnws/station/1/query"
    ]
  }
]


def _normalize_server(x):
    x=dict(x)
    if 'seedlink_candidates' not in x:
        s=x.get('seedlink')
        x['seedlink_candidates']=[s] if s else []
    if 'station_candidates' not in x:
        s=x.get('station_url')
        x['station_candidates']=[s] if s else []
    x['seedlink_candidates']=[str(v).strip() for v in x['seedlink_candidates'] if str(v).strip()]
    x['station_candidates']=[str(v).strip() for v in x['station_candidates'] if str(v).strip()]
    if not x.get('name'): raise ValueError('cada servidor necesita name')
    return x


def load_servers():
    raw=os.getenv("SEEDLINK_SERVERS_JSON","").strip()
    if not raw: return [_normalize_server(x) for x in DEFAULT_SERVERS]
    x=json.loads(raw)
    if not isinstance(x,list): raise ValueError("SEEDLINK_SERVERS_JSON debe ser una lista")
    return [_normalize_server(v) for v in x]


def load_manual_selectors():
    raw=os.getenv("SEEDLINK_SELECTORS_JSON","").strip()
    return json.loads(raw) if raw else []
