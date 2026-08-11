# SISMO PERÚ · EEW FUSION V2

Esta versión añade el **Waveform Gateway**: SeedLink abierto (EarthScope + GEOFON), detección P causal y PhaseNet opcional. Mantiene la V1 de fusión EMSC/USGS/IGP.

Lee `V2_DEPLOY.md` y `waveform-gateway/README.md`.

---

# SISMO PERÚ · FUSION ENGINE V1

Motor paralelo para reducir la latencia de **SISMO PERÚ** sin sustituir el sistema actual.

## Qué integra ahora

1. **EMSC / SeismicPortal WebSocket**: recepción push de eventos nuevos/actualizados.
2. **USGS Real-Time GeoJSON**: corroboración global por polling.
3. **IGP/CENSIS**: endpoint de entrada para que el backend actual de SISMO PERÚ envíe sus eventos ya normalizados.
4. **Sensor Lab**: endpoint para picks P de sensores propios o un gateway local Raspberry Shake. Con 4+ estaciones busca un candidato por tiempos de llegada.
5. **Fusión**: deduplicación por tiempo/distancia, procedencia, latencia y confianza.
6. **SSE**: stream en tiempo real para que la PWA actual reciba actualizaciones sin recargar.

## Muy importante

- EMSC y USGS son **reportes/eventos rápidos**, no una predicción.
- `isEarlyWarning` se mantiene en `false`.
- Los tiempos P/S que devuelve el motor son una **aproximación física de laboratorio**, no un producto oficial.
- El Sensor Lab genera `SENSOR_CANDIDATE`, nunca `ALERTA OFICIAL`.
- `ENABLE_EXPERIMENTAL_PUBLIC_SIGNAL=false` por defecto.
- Para emergencias y decisiones de seguridad, mantén IGP/INDECI como referencia oficial.

## Railway

1. Sube esta carpeta a un repositorio GitHub nuevo.
2. Railway → New Project → Deploy from GitHub.
3. Variables:
   - `INGEST_TOKEN`: secreto largo.
   - `TARGETS_JSON`: opcional.
4. Espera el healthcheck `/health`.
5. Prueba `/api/eew/status`.

Railway usa el `Dockerfile` incluido.

## Conectar tu SISMO PERÚ actual

### A) Enviar eventos IGP al motor

Cada vez que tu backend actual reciba/normalice un evento IGP:

```js
await fetch(`${process.env.FUSION_URL}/api/eew/ingest/igp`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "authorization": `Bearer ${process.env.FUSION_INGEST_TOKEN}`
  },
  body: JSON.stringify({
    sourceId: evento.id,
    time: evento.time,
    lat: evento.lat,
    lon: evento.lon,
    depthKm: evento.depth,
    magnitude: evento.mag,
    region: evento.place,
    url: evento.url
  })
});
```

### B) Escuchar el motor desde el frontend

Copia `public/bridge-client.js` a tu web actual o usa:

```js
const fusion = new EventSource("https://TU-FUSION.up.railway.app/api/eew/stream");
fusion.addEventListener("fusion", e => {
  const event = JSON.parse(e.data);
  console.log("SISMO FUSION:", event);
});
```

## Endpoints

- `GET /health`
- `GET /api/eew/status`
- `GET /api/eew/latest`
- `GET /api/eew/events?limit=50`
- `GET /api/eew/stream`
- `POST /api/eew/ingest/igp`
- `POST /api/eew/ingest/sensor-trigger`
- `GET /api/eew/sensor-candidates`
- `GET /api/eew/public-signal`

## Gateway de sensores

El motor **no inventa picks P**. Un sensor/gateway debe detectar la llegada P y enviar:

```json
{
  "stationId": "HUANCAYO-01",
  "lat": -12.06,
  "lon": -75.20,
  "detectedAt": "2026-08-10T22:45:03.120-05:00",
  "phase": "P",
  "quality": 0.93
}
```

al endpoint:

`POST /api/eew/ingest/sensor-trigger`

con:

`Authorization: Bearer <INGEST_TOKEN>`

## Raspberry Shake

Hay dos vías válidas:

- **Sensor propio/local**: extraer datos del Shake en tu red, detectar P en tu gateway y enviar picks al endpoint anterior.
- **Streaming de red Raspberry Shake**: conectar SeedLink/CAPS cuando tengas acceso/credenciales del servicio correspondiente.

No se incluye scraping ni bypass de servicios privados.

## Próxima capa técnica

V2 puede incorporar:
- gateway ObsPy/SeedLink;
- picker PhaseNet/EQTransformer/FisH;
- localización más precisa (TauP/velocity model);
- PGA/PGV y estimación de intensidad;
- persistencia Redis/Postgres;
- Web Push con reglas conservadoras y auditoría de falsos positivos.
