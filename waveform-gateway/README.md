# Waveform Gateway V2

Recibe **formas de onda en tiempo real por SeedLink**, detecta picks P y los manda al `Fusion Engine`.

## Redes por defecto
- EarthScope: `rtserve.iris.washington.edu:18000`
- GEOFON: `geofon.gfz.de:18000`

El gateway consulta los FDSN Station Services por estaciones activas dentro del rectángulo de Perú y se suscribe solo a ellas. Esto evita abrir un stream mundial innecesario.

## Pickers

### 1. STA/LTA causal (default)
No usa GPU ni modelo. Aplica bandpass causal, Recursive STA/LTA, SNR mínimo, frescura y cooldown por estación. Es el modo recomendado para empezar y calibrar falsos positivos.

### 2. PhaseNet opcional
Usa SeisBench + PyTorch y `PhaseNet.from_pretrained("geofon")`. Cambia `PICKER_MODE=phasenet` y despliega con `Dockerfile.ai`.
Si el modelo no puede cargar, el gateway vuelve automáticamente a STA/LTA y lo registra en `/health`.

## Railway: dos servicios

### Servicio A — Fusion Engine Node
Usa el `Dockerfile` de la raíz. Variables principales:
- `INGEST_TOKEN`
- `TARGETS_JSON`

### Servicio B — Waveform Gateway
Configura Root Directory `waveform-gateway` y Dockerfile `Dockerfile`.
Variables:
- `FUSION_URL=https://<servicio-A>.up.railway.app`
- `INGEST_TOKEN=<mismo secreto>`
- `PICKER_MODE=sta_lta`

Health: `/health`. No definas `GATEWAY_PORT` en Railway: el código usa automáticamente el `PORT` inyectado por Railway.

## PhaseNet
Cuando STA/LTA esté calibrado con tráfico real, puedes crear un tercer servicio o cambiar el gateway a `Dockerfile.ai`. La imagen será bastante más pesada por PyTorch. La primera carga descarga pesos y después quedan en cache de la instancia/volumen si configuras persistencia.

## Advertencia de seguridad
Los picks son candidatos instrumentales. Ningún pick individual ni candidato interno debe mostrarse como **alerta oficial**. Se debe mantener corroboración, auditoría, controles de latencia y pruebas con eventos históricos/reales antes de cualquier aviso público.
