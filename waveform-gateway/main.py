from __future__ import annotations
import json, os, sys, threading, time, traceback
from obspy.clients.seedlink.easyseedlink import EasySeedLinkClient
from config import load_settings, load_servers, load_manual_selectors
from discovery import discover, StationStream
from fusion_client import FusionClient
from sta_lta_picker import StaLtaPicker
from health import serve

S=load_settings()
STATUS={'started_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'picker_requested':S.picker_mode,'servers':{},'stations':0,'picks_forwarded':0}
if not S.ingest_token:
    print('FATAL: INGEST_TOKEN obligatorio',file=sys.stderr); sys.exit(2)

fusion=FusionClient(S.fusion_url,S.ingest_token,STATUS)

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
for m in manual: manual_by_source.setdefault(m.get('source','MANUAL'),[]).append(m)

class Client(EasySeedLinkClient):
    def __init__(self,server_url,name,metas):
        super().__init__(server_url)
        self.source_name=name
        self.metas={(m.network,m.station):m for m in metas}
    def on_data(self,trace):
        key=(str(trace.stats.network),str(trace.stats.station))
        meta=self.metas.get(key)
        if not meta: return
        STATUS['last_waveform_at']=str(trace.stats.endtime)
        STATUS['packets']=STATUS.get('packets',0)+1
        try: picker.feed(trace,meta)
        except Exception as e: STATUS['last_picker_error']=str(e)
    def on_seedlink_error(self):
        STATUS['servers'].setdefault(self.source_name,{})['state']='seedlink_error'
    def on_terminate(self):
        STATUS['servers'].setdefault(self.source_name,{})['state']='terminated'


def run_server(server):
    name=server['name']
    while True:
        try:
            metas=discover(server,S.bounds,S.max_stations_per_server)
            # Explicit manual selectors may augment discovery.
            for m in manual_by_source.get(name,[]):
                metas.append(StationStream(name,m['network'],m['station'],m.get('location',''),m.get('selector','HH?'),float(m['lat']),float(m['lon'])))
            uniq={ (m.network,m.station):m for m in metas }
            metas=list(uniq.values())
            STATUS['servers'][name]={'state':'discovered','stations':len(metas),'seedlink':server['seedlink']}
            STATUS['stations']=sum(v.get('stations',0) for v in STATUS['servers'].values())
            if not metas: raise RuntimeError('sin estaciones descubiertas dentro de bounds')
            c=Client(server['seedlink'],name,metas)
            for m in metas:
                c.select_stream(m.network,m.station,m.selector)
            STATUS['servers'][name]['state']='streaming'
            print(f"[{name}] streaming {len(metas)} estaciones desde {server['seedlink']}",flush=True)
            c.run()
        except Exception as e:
            STATUS['servers'][name]={'state':'error','error':str(e),'seedlink':server.get('seedlink')}
            print(f"[{name}] ERROR {e}",flush=True)
            traceback.print_exc()
            time.sleep(15)

for srv in load_servers():
    threading.Thread(target=run_server,args=(srv,),name=f"seedlink-{srv['name']}",daemon=True).start()

print(f"SISMO PERU WAVEFORM GATEWAY V2 listo. health :{S.gateway_port}; picker={STATUS['picker_active']}",flush=True)
while True: time.sleep(60)
