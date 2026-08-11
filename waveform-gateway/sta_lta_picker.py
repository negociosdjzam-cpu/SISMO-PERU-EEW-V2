from __future__ import annotations
import math, threading
from collections import deque
import numpy as np
from obspy import Trace, UTCDateTime
from obspy.signal.trigger import recursive_sta_lta, trigger_onset

class StaLtaPicker:
    def __init__(self,settings,on_pick,status):
        self.s=settings; self.on_pick=on_pick; self.status=status
        self.buffers={}; self.last_pick={}; self.lock=threading.Lock()

    def _append(self,key,trace):
        data=np.asarray(trace.data,dtype=np.float64)
        sr=float(trace.stats.sampling_rate)
        start=float(trace.stats.starttime.timestamp)
        end=start+(len(data)-1)/sr if len(data) else start
        b=self.buffers.get(key)
        if not b or abs(sr-b['sr'])>1e-6 or start > b['end']+max(0.25,3/sr) or start < b['start']-1:
            b={'data':data.copy(),'start':start,'end':end,'sr':sr}
        else:
            expected=b['end']+1/sr
            gap_samples=round((start-expected)*sr)
            if gap_samples>0: b['data']=np.concatenate([b['data'],np.full(gap_samples,np.nan),data])
            elif gap_samples<0:
                skip=min(len(data),-gap_samples)
                if skip<len(data): b['data']=np.concatenate([b['data'],data[skip:]])
            else: b['data']=np.concatenate([b['data'],data])
            b['end']=end
        maxn=int(max(30,self.s.lta_sec*2.5)*sr)
        if len(b['data'])>maxn:
            cut=len(b['data'])-maxn
            b['data']=b['data'][cut:]
            b['start'] += cut/sr
        self.buffers[key]=b
        return b

    def feed(self,trace,meta):
        if not str(trace.stats.channel).endswith('Z'): return
        key=f"{trace.stats.network}.{trace.stats.station}.{trace.stats.location}.{trace.stats.channel}"
        with self.lock:
            b=self._append(key,trace)
            sr=b['sr']; data=b['data']
            min_n=int((self.s.lta_sec+2)*sr)
            if len(data)<min_n or np.isnan(data).any(): return
            tr=Trace(data=data.copy())
            tr.stats.sampling_rate=sr
            tr.detrend('demean'); tr.detrend('linear')
            fmax=min(15.0,0.42*sr)
            if fmax<=1.2: return
            try: tr.filter('bandpass',freqmin=1.0,freqmax=fmax,corners=2,zerophase=False)
            except Exception: return
            nsta=max(2,int(self.s.sta_sec*sr)); nlta=max(nsta+2,int(self.s.lta_sec*sr))
            cft=recursive_sta_lta(tr.data,nsta,nlta)
            ons=trigger_onset(cft,self.s.trigger_on,self.s.trigger_off,max_len=int(8*sr))
            if len(ons)==0: return
            now_end=b['start']+(len(data)-1)/sr
            for on,off in ons[-3:]:
                pick_ts=b['start']+on/sr
                if now_end-pick_ts>self.s.fresh_pick_sec: continue
                if pick_ts-self.last_pick.get(key,-1e30)<self.s.cooldown_sec: continue
                noise0=max(0,on-int(4*sr)); noise1=max(0,on-int(0.6*sr))
                sig1=min(len(tr.data),on+int(1.2*sr))
                if noise1-noise0<int(sr) or sig1-on<int(0.2*sr): continue
                noise=float(np.sqrt(np.mean(tr.data[noise0:noise1]**2))+1e-12)
                signal=float(np.sqrt(np.mean(tr.data[on:sig1]**2))+1e-12)
                snr=signal/noise
                peak=float(np.max(cft[on:min(len(cft),max(off,on+1))]))
                if snr<self.s.min_snr: continue
                quality=min(0.99,max(0.05,0.45*(peak/self.s.trigger_on/2)+0.55*(min(snr,12)/12)))
                self.last_pick[key]=pick_ts
                self.status['last_pick_at']=UTCDateTime(pick_ts).isoformat()
                self.status['last_pick_snr']=round(snr,2)
                self.on_pick({
                    'stationId':f"{trace.stats.network}.{trace.stats.station}",
                    'network':str(trace.stats.network),'channel':str(trace.stats.channel),
                    'lat':meta.latitude,'lon':meta.longitude,
                    'detectedAt':UTCDateTime(pick_ts).isoformat(),
                    'phase':'P','quality':round(quality,3),'picker':'recursive_sta_lta_causal',
                    'snr':round(snr,2),'triggerPeak':round(peak,2)
                })
