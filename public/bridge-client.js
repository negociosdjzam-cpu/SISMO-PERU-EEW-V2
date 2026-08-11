/*
  Pega este archivo en tu frontend SISMO PERU y cambia FUSION_BASE_URL.
  Emite:
    window "sismo-fusion-event"
    window "sismo-sensor-candidate"
*/
(() => {
  const FUSION_BASE_URL = window.SISMO_FUSION_URL || location.origin;
  const es = new EventSource(`${FUSION_BASE_URL}/api/eew/stream`);

  es.addEventListener("fusion", e => {
    const data = JSON.parse(e.data);
    window.dispatchEvent(new CustomEvent("sismo-fusion-event", {detail:data}));
  });

  es.addEventListener("sensor_candidate", e => {
    const data = JSON.parse(e.data);
    window.dispatchEvent(new CustomEvent("sismo-sensor-candidate", {detail:data}));
  });

  es.onerror = () => console.warn("[SISMO FUSION] stream reconectando...");
})();
