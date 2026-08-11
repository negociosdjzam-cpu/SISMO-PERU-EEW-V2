import fs from "node:fs";
import path from "node:path";
import webpush from "web-push";

function cleanSubscription(x) {
  if (!x?.endpoint || !x?.keys?.p256dh || !x?.keys?.auth) return null;
  return {
    endpoint:String(x.endpoint),
    expirationTime:x.expirationTime ?? null,
    keys:{p256dh:String(x.keys.p256dh),auth:String(x.keys.auth)}
  };
}

function subKey(s) { return s?.endpoint || ""; }

export class PushManager {
  constructor({
    publicKey=process.env.VAPID_PUBLIC_KEY,
    privateKey=process.env.VAPID_PRIVATE_KEY,
    subject=process.env.VAPID_SUBJECT || "https://sismo-peru-eew-v2-production.up.railway.app",
    storeFile=process.env.PUSH_STORE_FILE || ""
  }={}) {
    this.publicKey=String(publicKey||"").trim();
    this.privateKey=String(privateKey||"").trim();
    this.subject=String(subject||"").trim();
    this.storeFile=String(storeFile||"").trim();
    this.subscriptions=new Map();
    this.configured=Boolean(this.publicKey && this.privateKey && this.subject);

    if(this.configured){
      webpush.setVapidDetails(this.subject,this.publicKey,this.privateKey);
    }
    this.load();
  }

  load(){
    if(!this.storeFile) return;
    try{
      const rows=JSON.parse(fs.readFileSync(this.storeFile,"utf8"));
      if(!Array.isArray(rows)) return;
      for(const row of rows){
        const subscription=cleanSubscription(row.subscription);
        if(!subscription) continue;
        this.subscriptions.set(subKey(subscription),{
          subscription,
          prefs:{experimentalPrealerts:Boolean(row?.prefs?.experimentalPrealerts)},
          updatedAt:row.updatedAt || new Date().toISOString()
        });
      }
    }catch{}
  }

  persist(){
    if(!this.storeFile) return;
    try{
      fs.mkdirSync(path.dirname(this.storeFile),{recursive:true});
      fs.writeFileSync(
        this.storeFile,
        JSON.stringify([...this.subscriptions.values()],null,2),
        "utf8"
      );
    }catch(e){
      console.warn("[PUSH] No se pudo persistir subscriptions:",e.message);
    }
  }

  upsert(subscription,prefs={}){
    const clean=cleanSubscription(subscription);
    if(!clean) throw new Error("Suscripción push inválida");
    this.subscriptions.set(subKey(clean),{
      subscription:clean,
      prefs:{experimentalPrealerts:Boolean(prefs.experimentalPrealerts)},
      updatedAt:new Date().toISOString()
    });
    this.persist();
    return this.status();
  }

  remove(subscriptionOrEndpoint){
    const endpoint=typeof subscriptionOrEndpoint==="string"
      ? subscriptionOrEndpoint
      : subscriptionOrEndpoint?.endpoint;
    if(endpoint) this.subscriptions.delete(String(endpoint));
    this.persist();
    return this.status();
  }

  status(){
    return {
      configured:this.configured,
      subscribers:this.subscriptions.size,
      persistence:this.storeFile ? "file" : "memory",
      publicKey:this.configured ? this.publicKey : null
    };
  }

  payloadFor(alert){
    const level=Number(alert?.level||0);
    const urgent=level>=2;
    const title="AUREO SISMO PERÚ";
    let body=alert?.title || "Alerta sísmica";
    if(alert?.action) body += ` · ${alert.action}`;

    return {
      title,
      body,
      icon:"/icons/icon-192.png",
      badge:"/icons/badge-96.png",
      tag:`aureo-sismo-${alert?.eventId||alert?.code||Date.now()}`,
      renotify:true,
      requireInteraction:urgent,
      vibrate:urgent ? [350,120,350,120,650] : [180,100,220],
      data:{
        url:"/?from=push",
        alert
      },
      level,
      experimental:Boolean(alert?.experimental)
    };
  }

  async sendToSubscription(subscription,alert){
    if(!this.configured) return {ok:false,error:"VAPID no configurado"};
    const clean=cleanSubscription(subscription);
    if(!clean) return {ok:false,error:"Suscripción inválida"};
    const payload=JSON.stringify(this.payloadFor(alert));
    try{
      await webpush.sendNotification(clean,payload,{TTL:60,urgency:Number(alert?.level)>=2?"high":"normal"});
      return {ok:true};
    }catch(e){
      return {ok:false,statusCode:e?.statusCode||null,error:e?.message||String(e)};
    }
  }

  async broadcast(alert){
    if(!this.configured) return {ok:false,configured:false,sent:0,failed:0};
    const level=Number(alert?.level||0);
    if(level<=0) return {ok:true,configured:true,sent:0,failed:0};

    let sent=0,failed=0,skipped=0;
    const stale=[];

    for(const row of this.subscriptions.values()){
      if(level===1 && !row.prefs.experimentalPrealerts){
        skipped++;
        continue;
      }
      const result=await this.sendToSubscription(row.subscription,alert);
      if(result.ok) sent++;
      else{
        failed++;
        if(result.statusCode===404 || result.statusCode===410) stale.push(row.subscription.endpoint);
      }
    }

    for(const endpoint of stale) this.subscriptions.delete(endpoint);
    if(stale.length) this.persist();

    console.log(`[PUSH] ${alert.code} level=${level} sent=${sent} failed=${failed} skipped=${skipped}`);
    return {ok:true,configured:true,sent,failed,skipped,subscribers:this.subscriptions.size};
  }
}
