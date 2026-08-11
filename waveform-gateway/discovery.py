from __future__ import annotations
import socket
import requests
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from urllib.parse import urlsplit

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

@dataclass(frozen=True)
class ResolvedProvider:
    name: str
    seedlink: str
    station_url: str
    station_final_url: str
    bounds_used: tuple
    expand_deg: float
    stations: tuple


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


def expand_bounds(bounds, deg):
    minlat,maxlat,minlon,maxlon=bounds
    return (
        max(-90.0,minlat-deg), min(90.0,maxlat+deg),
        max(-180.0,minlon-deg), min(180.0,maxlon+deg)
    )


def _station_rows(url,bounds,session,timeout):
    minlat,maxlat,minlon,maxlon=bounds
    now=datetime.now(timezone.utc)
    params={
        'format':'text','level':'channel',
        'minlatitude':minlat,'maxlatitude':maxlat,
        'minlongitude':minlon,'maxlongitude':maxlon,
        'starttime':(now-timedelta(days=2)).strftime('%Y-%m-%dT%H:%M:%S'),
        'endtime':now.strftime('%Y-%m-%dT%H:%M:%S'),
        'channel':'HH?,BH?,EH?,SH?','nodata':404
    }
    r=session.get(url,params=params,timeout=timeout,allow_redirects=True,
                  headers={'User-Agent':'SISMO-PERU-EEW/2.1-autoheal'})
    if r.status_code==404:
        return [], r.url
    r.raise_for_status()
    return _parse_channel_text(r.text), r.url


def _rows_to_streams(source,rows,max_stations):
    groups={}
    for x in rows:
        cha=x['cha']
        if len(cha)<3: continue
        band=cha[:2]
        k=(x['net'],x['sta'],x['loc'],band,x['lat'],x['lon'])
        groups.setdefault(k,set()).add(cha[-1])

    priority={'HH':0,'BH':1,'EH':2,'SH':3}
    by_station={}
    for (net,sta,loc,band,lat,lon),comps in groups.items():
        score=(0 if 'Z' in comps else 10) + (0 if len(comps & {'N','E','1','2'})>=2 else 2) + priority.get(band,9)
        item=(score,net,sta,loc,band,lat,lon,comps)
        key=(net,sta)
        if key not in by_station or item[0] < by_station[key][0]: by_station[key]=item

    candidates=[]
    for item in sorted(by_station.values(),key=lambda x:x[0]):
        score,net,sta,loc,band,lat,lon,comps=item
        if 'Z' not in comps: continue
        selector=f"{band}?" if len(comps & {'N','E','1','2'})>=2 else f"{band}Z"
        candidates.append(StationStream(source,net,sta,loc,selector,lat,lon))
        if len(candidates)>=max_stations: break
    return candidates


def tcp_probe_seedlink(endpoint,timeout=20.0):
    host,sep,port=endpoint.rpartition(':')
    if not sep: host,port=endpoint,'18000'
    port=int(port)
    with socket.create_connection((host,port),timeout=timeout):
        return True


def resolve_provider(server:dict,base_bounds,max_stations=80,expand_steps=(0,3,6,10),timeout=6.0,session=None):
    """Resolve working metadata + SeedLink endpoints.

    HTTP redirects are followed and the final station URL is recorded. Bounds are
    expanded progressively only when the endpoint is healthy but has no matching
    stations. SeedLink candidates are TCP-probed before use.
    """
    sess=session or requests.Session()
    errors=[]
    station_result=None

    for station_url in server.get('station_candidates',[]):
        for deg in expand_steps:
            b=expand_bounds(base_bounds,float(deg))
            try:
                rows,final_url=_station_rows(station_url,b,sess,timeout)
                metas=_rows_to_streams(server['name'],rows,max_stations)
                if metas:
                    station_result=(station_url,final_url,b,float(deg),metas)
                    break
            except Exception as e:
                errors.append(f"station {station_url}: {e}")
                break
        if station_result: break

    if not station_result:
        raise RuntimeError('sin estaciones tras auto-discovery; ' + ' | '.join(errors[-3:]))

    seedlink=None
    seed_errors=[]
    for endpoint in server.get('seedlink_candidates',[]):
        try:
            tcp_probe_seedlink(endpoint,timeout=timeout)
            seedlink=endpoint
            break
        except Exception as e:
            seed_errors.append(f"{endpoint}: {e}")
    if not seedlink:
        raise RuntimeError('sin SeedLink accesible; ' + ' | '.join(seed_errors[-3:]))

    station_url,final_url,bounds_used,deg,metas=station_result
    return ResolvedProvider(
        name=server['name'], seedlink=seedlink, station_url=station_url,
        station_final_url=final_url, bounds_used=bounds_used,
        expand_deg=deg, stations=tuple(metas)
    )

# Backwards-compatible helper.
def discover(server:dict,bounds,max_stations=80,session=None):
    station_url=server.get('station_url') or (server.get('station_candidates') or [None])[0]
    if not station_url: return []
    sess=session or requests.Session()
    rows,_=_station_rows(station_url,bounds,sess,15)
    return _rows_to_streams(server['name'],rows,max_stations)


def resolve_seedlink_only(server:dict, timeout=20.0):
    """Resolve only the SeedLink TCP endpoint.

    Used when FDSN station metadata is unavailable but we have a trusted
    station bootstrap inventory. This lets waveform streaming continue even
    during an HTTP metadata outage.
    """
    errors=[]
    for endpoint in server.get('seedlink_candidates', []):
        try:
            tcp_probe_seedlink(endpoint, timeout=timeout)
            return endpoint
        except Exception as e:
            errors.append(f"{endpoint}: {e}")
    raise RuntimeError("sin SeedLink accesible para fallback; " + " | ".join(errors[-3:]))
