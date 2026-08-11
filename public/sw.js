const CACHE="aureo-sismo-v2.8-shell-1";
const SHELL=[
  "/",
  "/manifest.webmanifest",
  "/offline.html",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png",
  "/icons/apple-touch-icon.png",
  "/icons/badge-96.png"
];

self.addEventListener("install",event=>{
  event.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));
});

self.addEventListener("activate",event=>{
  event.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener("fetch",event=>{
  const req=event.request;
  if(req.method!=="GET") return;

  const url=new URL(req.url);
  if(url.origin!==location.origin) return;

  if(url.pathname.startsWith("/api/")){
    event.respondWith(fetch(req));
    return;
  }

  if(req.mode==="navigate"){
    event.respondWith(
      fetch(req).catch(()=>caches.match("/offline.html"))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(cached=>cached || fetch(req).then(res=>{
      const clone=res.clone();
      caches.open(CACHE).then(c=>c.put(req,clone)).catch(()=>{});
      return res;
    }))
  );
});

self.addEventListener("push",event=>{
  let p={};
  try{p=event.data?.json()||{}}catch{p={body:event.data?.text()||"Alerta sísmica"}}
  const level=Number(p.level||p?.data?.alert?.level||0);
  const options={
    body:p.body||"Revisa AUREO SISMO PERÚ.",
    icon:p.icon||"/icons/icon-192.png",
    badge:p.badge||"/icons/badge-96.png",
    tag:p.tag||"aureo-sismo-alerta",
    renotify:p.renotify!==false,
    requireInteraction:Boolean(p.requireInteraction || level>=2),
    vibrate:p.vibrate || (level>=2?[350,120,350,120,650]:[180,100,220]),
    data:p.data||{url:"/?from=push"},
    silent:false
  };
  event.waitUntil(self.registration.showNotification(p.title||"AUREO SISMO PERÚ",options));
});

self.addEventListener("notificationclick",event=>{
  event.notification.close();
  const url=event.notification?.data?.url || "/?from=push";
  event.waitUntil((async()=>{
    const wins=await clients.matchAll({type:"window",includeUncontrolled:true});
    for(const w of wins){
      if("focus" in w){
        try{await w.navigate(url)}catch{}
        return w.focus();
      }
    }
    return clients.openWindow(url);
  })());
});
