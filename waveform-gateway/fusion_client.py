from __future__ import annotations
import json, queue, threading, time, requests

class FusionClient:
    def __init__(self,base_url,token,status):
        self.base_url=base_url.rstrip('/')
        self.token=token
        self.status=status
        self.q=queue.Queue(maxsize=500)
        self.session=requests.Session()
        threading.Thread(target=self._worker,name='fusion-post',daemon=True).start()

    def _headers(self):
        return {
            'Authorization':f'Bearer {self.token}',
            'User-Agent':'SISMO-PERU-EEW/2.3'
        }

    def submit(self,pick):
        try:
            self.q.put_nowait(pick)
        except queue.Full:
            self.status['post_queue_drops']=self.status.get('post_queue_drops',0)+1

    def _worker(self):
        while True:
            x=self.q.get()
            for attempt in range(3):
                try:
                    r=self.session.post(
                        self.base_url+'/api/eew/ingest/sensor-trigger',
                        json=x,timeout=5,headers=self._headers()
                    )
                    if r.ok:
                        self.status['picks_forwarded']=self.status.get('picks_forwarded',0)+1
                        self.status['last_pick_forwarded_at']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
                        data=r.json()
                        corr=data.get('correlation')
                        if corr:
                            self.status['fusion_correlation']=corr
                        if data.get('candidate'):
                            self.status['last_candidate']=data['candidate']
                        break
                    self.status['last_post_error']=f'HTTP {r.status_code}: {r.text[:200]}'
                except Exception as e:
                    self.status['last_post_error']=str(e)
                time.sleep(0.5*(attempt+1))
            self.q.task_done()

    def start_telemetry(self,interval_sec=2.0):
        interval=max(1.0,float(interval_sec))
        threading.Thread(
            target=self._telemetry_worker,
            args=(interval,),
            name='fusion-telemetry',
            daemon=True
        ).start()

    def _snapshot_status(self):
        # JSON round-trip creates a safe snapshot while the streaming threads mutate STATUS.
        try:
            return json.loads(json.dumps(self.status,default=str))
        except Exception:
            return {
                'version':self.status.get('version'),
                'stations':self.status.get('stations',0),
                'packets':self.status.get('packets',0),
                'picks_forwarded':self.status.get('picks_forwarded',0),
                'last_waveform_at':self.status.get('last_waveform_at'),
                'last_pick_at':self.status.get('last_pick_at'),
                'servers':dict(self.status.get('servers',{})),
            }

    def _telemetry_worker(self,interval):
        while True:
            try:
                payload={
                    'sentAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),
                    'status':self._snapshot_status()
                }
                r=self.session.post(
                    self.base_url+'/api/eew/ingest/waveform-telemetry',
                    json=payload,timeout=5,headers=self._headers()
                )
                if r.ok:
                    self.status['telemetry_posts']=self.status.get('telemetry_posts',0)+1
                    self.status['last_telemetry_post_at']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
                    self.status.pop('last_telemetry_error',None)
                else:
                    self.status['last_telemetry_error']=f'HTTP {r.status_code}: {r.text[:160]}'
            except Exception as e:
                self.status['last_telemetry_error']=str(e)
            time.sleep(interval)
