from __future__ import annotations
import threading, time
from obspy import Stream, UTCDateTime

class PhaseNetPicker:
    def __init__(self,settings,on_pick,status):
        import seisbench.models as sbm
        self.s=settings; self.on_pick=on_pick; self.status=status
        self.model=sbm.PhaseNet.from_pretrained(settings.phasenet_weights)
        self.model.eval()
        self.streams={}; self.last_run={}; self.last_pick={}; self.lock=threading.Lock()
        status['phasenet_weights']=settings.phasenet_weights

    def feed(self,trace,meta):
        station=f"{trace.stats.network}.{trace.stats.station}"
        with self.lock:
            st=self.streams.setdefault(station,Stream())
            st += trace.copy()
            try:
                st.merge(method=1,fill_value='interpolate')
                newest=max(t.stats.endtime for t in st)
                st.trim(newest-45,newest,pad=False)
            except Exception: return
            if time.time()-self.last_run.get(station,0)<1.5: return
            self.last_run[station]=time.time()
            work=st.copy()
        threading.Thread(target=self._infer,args=(station,work,meta),daemon=True).start()

    def _infer(self,station,st,meta):
        try:
            out=self.model.classify(st,P_threshold=self.s.phasenet_threshold,S_threshold=0.5)
            picks=getattr(out,'picks',out)
            newest=max(t.stats.endtime for t in st)
            for p in picks:
                phase=str(getattr(p,'phase','')).upper()
                if phase!='P': continue
                pt=getattr(p,'peak_time',getattr(p,'time',None))
                if pt is None: continue
                pt=UTCDateTime(pt)
                if newest-pt>self.s.fresh_pick_sec: continue
                key=f"{station}:P"
                if float(pt.timestamp)-self.last_pick.get(key,-1e30)<self.s.cooldown_sec: continue
                q=float(getattr(p,'peak_value',getattr(p,'probability',0.5)) or 0.5)
                self.last_pick[key]=float(pt.timestamp)
                tr=st[0]
                self.status['last_pick_at']=pt.isoformat()
                self.on_pick({
                    'stationId':station,'network':str(tr.stats.network),'channel':'3C',
                    'lat':meta.latitude,'lon':meta.longitude,'detectedAt':pt.isoformat(),
                    'phase':'P','quality':round(max(0,min(q,0.999)),3),
                    'picker':f'phasenet:{self.s.phasenet_weights}'
                })
        except Exception as e:
            self.status['last_ai_error']=str(e)
