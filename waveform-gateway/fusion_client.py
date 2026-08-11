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

    def submit(self,pick):
        try: self.q.put_nowait(pick)
        except queue.Full:
            self.status['post_queue_drops']=self.status.get('post_queue_drops',0)+1

    def _worker(self):
        while True:
            x=self.q.get()
            for attempt in range(3):
                try:
                    r=self.session.post(
                        self.base_url+'/api/eew/ingest/sensor-trigger',
                        json=x,timeout=5,
                        headers={'Authorization':f'Bearer {self.token}','User-Agent':'SISMO-PERU-EEW/2.0'}
                    )
                    if r.ok:
                        self.status['picks_forwarded']=self.status.get('picks_forwarded',0)+1
                        data=r.json()
                        if data.get('candidate'):
                            self.status['last_candidate']=data['candidate']
                        break
                    self.status['last_post_error']=f'HTTP {r.status_code}: {r.text[:200]}'
                except Exception as e:
                    self.status['last_post_error']=str(e)
                time.sleep(0.5*(attempt+1))
            self.q.task_done()
