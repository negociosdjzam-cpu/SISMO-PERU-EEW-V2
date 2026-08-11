import argparse, math, time, requests
from datetime import datetime, timezone, timedelta

P=argparse.ArgumentParser(); P.add_argument('--fusion',default='http://127.0.0.1:3000'); P.add_argument('--token',required=True); a=P.parse_args()
# Synthetic MISSING-magnitude event near central Peru. Test only.
ev=(-12.35,-75.45,25)
stations=[('TEST-A',-11.95,-75.25),('TEST-B',-12.15,-74.95),('TEST-C',-12.70,-75.15),('TEST-D',-12.55,-75.85),('TEST-E',-11.95,-75.80)]
R=6371.0088
def hav(lat1,lon1,lat2,lon2):
  p1,p2=map(math.radians,[lat1,lat2]); dp=math.radians(lat2-lat1); dl=math.radians(lon2-lon1)
  q=math.sin(dp/2)**2+math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
  return 2*R*math.asin(math.sqrt(q))
origin=datetime.now(timezone.utc)-timedelta(seconds=20)
for i,(sid,lat,lon) in enumerate(stations):
  h=hav(ev[0],ev[1],lat,lon); path=math.sqrt(h*h+ev[2]*ev[2]); arr=origin+timedelta(seconds=path/6.0)
  payload={'stationId':sid,'network':'ZZ','channel':'BHZ','lat':lat,'lon':lon,'detectedAt':arr.isoformat(),'phase':'P','quality':0.94,'picker':'simulator'}
  r=requests.post(a.fusion.rstrip('/')+'/api/eew/ingest/sensor-trigger',json=payload,headers={'Authorization':'Bearer '+a.token},timeout=5)
  print(sid,r.status_code,r.text[:500]); time.sleep(.1)
