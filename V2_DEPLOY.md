# SISMO PERÚ EEW V2 — despliegue recomendado

## Objetivo
Agregar detección de ondas sin romper SISMO PERÚ actual.

## Flujo

EarthScope SeedLink ─┐
                     ├─> Waveform Gateway -> P picks -> Fusion Node -> SSE -> SISMO PERÚ
GEOFON SeedLink ─────┘                                  ↑
                                                       EMSC / USGS / IGP

## Orden
1. Despliega primero el Fusion Node V2.
2. Define un `INGEST_TOKEN` largo.
3. Verifica `/health` y `/api/eew/status`.
4. Despliega `waveform-gateway` como segundo servicio.
5. Verifica `/health`: deben aparecer estaciones y `last_waveform_at` cuando entren paquetes.
6. Mantén `PICKER_MODE=sta_lta` al principio.
7. Observa picks y falsos positivos sin activar señal pública.
8. Luego prueba PhaseNet con `Dockerfile.ai`.
9. Solo después conecta el SSE al frontend público.

## Reglas congeladas de seguridad
- `ENABLE_EXPERIMENTAL_PUBLIC_SIGNAL=false` durante calibración.
- 4 estaciones distintas mínimo para un candidato.
- El candidato de sensor nunca se llama “IGP”, “SASPe” ni “alerta oficial”.
- Solo una ingestión IGP normalizada puede marcar `OFFICIAL_CONFIRMED`.
- EMSC/USGS corroboran, pero no convierten el motor en sistema oficial.
