from __future__ import annotations
import requests
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta

@dataclass(frozen=True)
class StationStream:
    source: str
    network: str
    station: str
    location: str
    selector: str
    latitude: float
    longitude: float
    sample_rate: float | None = None

    @property
    def station_id(self):
        return f"{self.network}.{self.station}"


def _parse_channel_text(text:str):
    rows=[]
    for line in text.splitlines():
        if not line or line.startswith('#'): continue
        p=line.split('|')
        if len(p)<6: continue
        try:
            rows.append({
                'net':p[0].strip(),'sta':p[1].strip(),'loc':p[2].strip(),
                'cha':p[3].strip(),'lat':float(p[4]),'lon':float(p[5]),
                'sr': float(p[15]) if len(p)>15 and p[15].strip() else None,
            })
        except Exception:
            continue
    return rows


def discover(server:dict,bounds,max_stations=80,session=None):
    sess=session or requests.Session()
    minlat,maxlat,minlon,maxlon=bounds
    now=datetime.now(timezone.utc)
    params={
        'format':'text','level':'channel',
        'minlatitude':minlat,'maxlatitude':maxlat,
        'minlongitude':minlon,'maxlongitude':maxlon,
        'starttime':(now-timedelta(days=1)).strftime('%Y-%m-%dT%H:%M:%S'),
        'endtime':now.strftime('%Y-%m-%dT%H:%M:%S'),
        'channel':'HH?,BH?,EH?,SH?','nodata':404
    }
    r=sess.get(server['station_url'],params=params,timeout=15,headers={'User-Agent':'SISMO-PERU-EEW/2.0'})
    r.raise_for_status()
    rows=_parse_channel_text(r.text)

    # Group by station/location/band; prefer 3-component HH/BH/EH, otherwise vertical only.
    groups={}
    for x in rows:
        cha=x['cha']
        if len(cha)<3: continue
        band=cha[:2]
        k=(x['net'],x['sta'],x['loc'],band,x['lat'],x['lon'])
        groups.setdefault(k,set()).add(cha[-1])

    priority={'HH':0,'BH':1,'EH':2,'SH':3}
    candidates=[]
    by_station={}
    for (net,sta,loc,band,lat,lon),comps in groups.items():
        score=(0 if 'Z' in comps else 10) + (0 if len(comps & {'N','E','1','2'})>=2 else 2) + priority.get(band,9)
        item=(score,net,sta,loc,band,lat,lon,comps)
        key=(net,sta)
        if key not in by_station or item[0] < by_station[key][0]: by_station[key]=item

    for item in sorted(by_station.values(),key=lambda x:x[0]):
        score,net,sta,loc,band,lat,lon,comps=item
        if 'Z' not in comps: continue
        selector=f"{band}?" if len(comps & {'N','E','1','2'})>=2 else f"{band}Z"
        candidates.append(StationStream(server['name'],net,sta,loc,selector,lat,lon))
        if len(candidates)>=max_stations: break
    return candidates
