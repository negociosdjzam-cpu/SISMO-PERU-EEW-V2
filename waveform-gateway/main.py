from __future__ import annotations
import json, os, sys, threading, time, traceback
from obspy.clients.seedlink.easyseedlink import EasySeedLinkClient
from config import (
    load_settings, load_servers, load_manual_selectors, load_static_fallback
)
from discovery import resolve_provider, resolve_seedlink_only, StationStream
from fusion_client import FusionClient
from sta_lta_picker import StaLtaPicker
from health import serve

S=load_settings()
STATUS={
    'version':'2.3-telemetry-autoheal-static-fallback',
    'started_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),
    'picker_requested':S.picker_mode,
    'servers':{},
    'stations':0,
    'picks_forwarded':0,
    'auto_discovery':S.auto_discovery,
    'static_fallback':S.static_fallback,
    'discovery_expand_deg':list(S.discovery_expand_deg),
    'endpoint_probe_timeout_sec':S.endpoint_probe_timeout_sec,
}
if not S.ingest_token:
    print('FATAL: INGEST_TOKEN obligatorio',file=sys.stderr)
    sys.exit(2)

fusion=FusionClient(S.fusion_url,S.ingest_token,STATUS)
fusion.start_telemetry(float(os.getenv('TELEMETRY_INTERVAL_SEC','2')))

def forward_pick(p):
    print('[PICK]',json.dumps(p,ensure_ascii=False),flush=True)
    fusion.submit(p)

picker=None
if S.picker_mode=='phasenet':
    try:
        from phasenet_picker import PhaseNetPicker
        picker=PhaseNetPicker(S,forward_pick,STATUS)
        STATUS['picker_active']='phasenet'
    except Exception as e:
        STATUS['picker_fallback_reason']=str(e)
        print('[WARN] PhaseNet no disponible; fallback STA/LTA:',e,flush=True)

if picker is None:
    picker=StaLtaPicker(S,forward_pick,STATUS)
    STATUS['picker_active']='sta_lta'

serve(S.gateway_port,STATUS)

manual=load_manual_selectors()
manual_by_source={}
for m in manual:
    manual_by_source.setdefault(m.get('source','MANUAL'),[]).append(m)


class Client(EasySeedLinkClient):
    def __init__(self,server_url,name,metas):
        super().__init__(server_url)
        self.source_name=name
        self.metas={(m.network,m.station):m for m in metas}

    def on_data(self,trace):
        key=(str(trace.stats.network),str(trace.stats.station))
        meta=self.metas.get(key)
        if not meta:
            return
        STATUS['last_waveform_at']=str(trace.stats.endtime)
        STATUS['packets']=STATUS.get('packets',0)+1
        s=STATUS['servers'].setdefault(self.source_name,{})
        s['last_waveform_at']=str(trace.stats.endtime)
        s['packets']=s.get('packets',0)+1
        try:
            picker.feed(trace,meta)
        except Exception as e:
            STATUS['last_picker_error']=str(e)

    def on_seedlink_error(self):
        STATUS['servers'].setdefault(self.source_name,{})['state']='seedlink_error'

    def on_terminate(self):
        STATUS['servers'].setdefault(self.source_name,{})['state']='terminated'


def _dicts_to_metas(name, rows):
    out=[]
    for m in rows:
        out.append(StationStream(
            name,
            str(m['network']),
            str(m['station']),
            str(m.get('location','')),
            str(m.get('selector','HH?')),
            float(m['lat']),
            float(m['lon'])
        ))
    return out


def _manual_metas(name):
    return _dicts_to_metas(name, manual_by_source.get(name,[]))


def _static_metas(name):
    return _dicts_to_metas(name, load_static_fallback(name))


def _dedupe(metas):
    # Prefer earlier entries: live discovery, then manual, then static.
    out={}
    for m in metas:
        out.setdefault((m.network,m.station),m)
    return list(out.values())


def _live_resolution(server):
    rp=resolve_provider(
        server,
        S.bounds,
        S.max_stations_per_server,
        S.discovery_expand_deg if S.auto_discovery else (0,),
        S.endpoint_probe_timeout_sec
    )
    metas=_dedupe(list(rp.stations)+_manual_metas(server['name']))
    return {
        'metas':metas,
        'seedlink':rp.seedlink,
        'station_url':rp.station_final_url,
        'expand_deg':rp.expand_deg,
        'bounds_used':list(rp.bounds_used),
        'metadata_mode':'live_fdsn'
    }


def _fallback_resolution(server, live_error):
    name=server['name']
    fallback=_dedupe(_manual_metas(name)+_static_metas(name))
    if not S.static_fallback or not fallback:
        raise live_error

    seedlink=resolve_seedlink_only(server,S.endpoint_probe_timeout_sec)
    # Respect max stations also for fallback.
    fallback=fallback[:S.max_stations_per_server]
    print(
        f"[{name}] LIVE metadata fallo; usando STATIC FALLBACK con "
        f"{len(fallback)} estaciones; causa={live_error}",
        flush=True
    )
    return {
        'metas':fallback,
        'seedlink':seedlink,
        'station_url':None,
        'expand_deg':None,
        'bounds_used':list(S.bounds),
        'metadata_mode':'static_fallback',
        'live_discovery_error':str(live_error),
    }


def run_server(server):
    name=server['name']
    retry=5

    while True:
        try:
            STATUS['servers'][name]={'state':'resolving'}

            try:
                resolved=_live_resolution(server)
            except Exception as live_error:
                resolved=_fallback_resolution(server,live_error)

            metas=resolved['metas']
            seedlink=resolved['seedlink']
            if not metas:
                raise RuntimeError('sin estaciones para streaming')

            STATUS['servers'][name]={
                'state':'discovered',
                'stations':len(metas),
                'seedlink':seedlink,
                'station_url':resolved.get('station_url'),
                'metadata_mode':resolved.get('metadata_mode'),
                'expand_deg':resolved.get('expand_deg'),
                'bounds_used':resolved.get('bounds_used'),
                'live_discovery_error':resolved.get('live_discovery_error'),
                'last_resolved_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
            }
            STATUS['stations']=sum(v.get('stations',0) for v in STATUS['servers'].values())

            c=Client(seedlink,name,metas)
            for m in metas:
                c.select_stream(m.network,m.station,m.selector)

            STATUS['servers'][name]['state']='streaming'
            print(
                f"[{name}] AUTOHEAL streaming {len(metas)} estaciones "
                f"desde {seedlink}; metadata_mode={resolved.get('metadata_mode')}",
                flush=True
            )

            retry=5
            c.run()
            raise RuntimeError('SeedLink terminó; forzando re-resolución')

        except Exception as e:
            prev=STATUS['servers'].get(name,{})
            STATUS['servers'][name]={
                **prev,
                'state':'error',
                'error':str(e),
                'retry_in_sec':retry,
                'last_error_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
            }
            print(f"[{name}] AUTOHEAL ERROR {e}; reintentando en {retry}s",flush=True)
            traceback.print_exc()
            time.sleep(retry)
            retry=min(60,retry*2)


for srv in load_servers():
    threading.Thread(
        target=run_server,
        args=(srv,),
        name=f"seedlink-{srv['name']}",
        daemon=True
    ).start()

print(
    f"SISMO PERU WAVEFORM GATEWAY V2.3 TELEMETRY + AUTOHEAL listo. "
    f"health :{S.gateway_port}; picker={STATUS['picker_active']}; "
    f"static_fallback={S.static_fallback}",
    flush=True
)

while True:
    time.sleep(60)
