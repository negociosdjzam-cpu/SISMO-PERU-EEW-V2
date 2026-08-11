# Arquitectura

EMSC WebSocket ─┐
                ├─> Normalización ─> FusionEngine ─> REST + SSE ─> SISMO PERÚ PWA
USGS GeoJSON ───┤
IGP actual ─────┘

Sensores propios / Raspberry Shake local
        └─> picker P externo ─> /ingest/sensor-trigger ─> SensorLab
                                              └─> SENSOR_CANDIDATE

Reglas de seguridad:
- una fuente nunca se convierte en “oficial”;
- solo IGP marca OFFICIAL_CONFIRMED;
- EMSC+USGS => CORROBORATED_EVENT;
- candidatos de sensores quedan separados;
- señal pública experimental apagada por defecto.
