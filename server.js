const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const url = require('url');
const PORT = process.env.PORT || 3000;
const lobbies = new Map();

function genCode(){const c='ABCDEFGHJKMNPQRSTUVWXYZ23456789';let r='';for(let i=0;i<5;i++)r+=c[Math.floor(Math.random()*c.length)];return r;}

// ── WIKI HELPERS ──
function wikiReq(opts,maxR=5){
  return new Promise((res,rej)=>{
    if(maxR<=0)return rej(new Error('Too many redirects'));
    const r=https.request(opts,resp=>{
      if([301,302,303,307,308].includes(resp.statusCode)&&resp.headers.location){
        const u=new URL(resp.headers.location,`https://${opts.hostname}`);resp.resume();
        return wikiReq({...opts,hostname:u.hostname,path:u.pathname+(u.search||'')},maxR-1).then(res).catch(rej);
      }
      res(resp);
    });
    r.on('error',rej);r.setTimeout(15000,()=>{r.destroy();rej(new Error('Timeout'));});r.end();
  });
}

function wikiAPI(host,apiPath){
  return new Promise((res,rej)=>{
    wikiReq({hostname:host,path:apiPath,method:'GET',headers:{'User-Agent':'WikiRaceGame/4.0',Accept:'application/json'}})
    .then(r=>{let b='';r.setEncoding('utf8');r.on('data',c=>b+=c);r.on('end',()=>{try{res(JSON.parse(b))}catch(e){rej(e)}});})
    .catch(rej);
  });
}

function wikiHost(lang){return `${lang||'fr'}.wikipedia.org`;}

async function resolveTitle(title,lang){
  const h=wikiHost(lang);
  const d=await wikiAPI(h,`/w/api.php?action=query&titles=${encodeURIComponent(title)}&redirects=1&format=json`);
  const p=d.query.pages,pid=Object.keys(p)[0];
  return pid==='-1'?{found:false,title}:{found:true,title:p[pid].title,pageId:pid};
}

async function searchTitles(query,lang){
  const h=wikiHost(lang);
  const d=await wikiAPI(h,`/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=8&namespace=0&format=json`);
  return d[1]||[];
}

async function randomArticle(lang){
  const h=wikiHost(lang);
  const d=await wikiAPI(h,`/w/api.php?action=query&list=random&rnnamespace=0&rnlimit=1&format=json`);
  return d.query.random[0].title;
}

// Anti-cheat
const linkCache=new Map();
async function verifyLink(from,to,lang){
  const k=`${lang}|${from}|${to}`;if(linkCache.has(k))return linkCache.get(k);
  try{
    const d=await wikiAPI(wikiHost(lang),`/w/api.php?action=query&titles=${encodeURIComponent(from)}&prop=links&pllimit=500&pltitles=${encodeURIComponent(to)}&format=json`);
    const p=d.query.pages,pid=Object.keys(p)[0];
    const v=!!(p[pid]&&p[pid].links&&p[pid].links.length>0);
    linkCache.set(k,v);if(linkCache.size>5000)linkCache.delete(linkCache.keys().next().value);
    return v;
  }catch{return true;}
}

// ── LOBBY SERIALIZATION ──
function lobbyJSON(L){
  const players={};
  L.players.forEach((p,pid)=>{players[pid]={pid:p.pid,name:p.name,colorIdx:p.colorIdx,path:p.path,clicks:p.clicks,finished:p.finished,finishTime:p.finishTime,score:p.score||0};});
  return{code:L.code,host:L.host,phase:L.phase,gameStart:L.gameStart,gameEnd:L.gameEnd,startTime:L.startTime,players,mode:L.mode,ctrlF:L.ctrlF,lang:L.lang,timeLimit:L.timeLimit,history:L.history||[],spectatorCount:L.spectators?L.spectators.size:0};
}

function broadcastAll(L,msg){const d=JSON.stringify(msg);L.players.forEach(p=>{if(p.ws&&p.ws.readyState===1)p.ws.send(d);});if(L.spectators)L.spectators.forEach(s=>{if(s.ws&&s.ws.readyState===1)s.ws.send(d);});}
function broadcast(L,msg,excl){const d=JSON.stringify(msg);L.players.forEach(p=>{if(p.pid!==excl&&p.ws&&p.ws.readyState===1)p.ws.send(d);});if(L.spectators)L.spectators.forEach(s=>{if(s.ws&&s.ws.readyState===1)s.ws.send(d);});}

function buildResults(L){
  return[...L.players.values()].map(p=>({pid:p.pid,name:p.name,colorIdx:p.colorIdx,path:[...p.path],clicks:p.clicks,finished:p.finished,finishTime:p.finishTime,score:p.score||0,cheating:!!p.cheating}))
  .sort((a,b)=>{if(a.finished&&!b.finished)return-1;if(!a.finished&&b.finished)return 1;if(a.finished&&b.finished)return a.finishTime-b.finishTime;return 0;});
}

function endGame(L, winnerPid){
  L.phase='results';
  const winner=L.players.get(winnerPid);
  if(winner){
    winner.score=(winner.score||0)+1;
    L.history.push({start:L.gameStart,end:L.gameEnd,winner:winner.name,winPid:winnerPid,time:winner.finishTime,clicks:winner.clicks,ts:Date.now(),lang:L.lang});
  }else{
    L.history.push({start:L.gameStart,end:L.gameEnd,winner:null,winPid:null,time:0,clicks:0,ts:Date.now(),lang:L.lang});
  }
  if(L._timer){clearTimeout(L._timer);L._timer=null;}
  const res=buildResults(L);
  broadcastAll(L,{type:'game_end',results:res,winnerPid:winnerPid||null,history:L.history});
}

// ── HTTP SERVER ──
const server=http.createServer(async(req,res)=>{
  const parsed=url.parse(req.url,true),pn=parsed.pathname;
  res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}

  // API: resolve
  if(pn==='/api/resolve'){
    const t=parsed.query.title,lang=parsed.query.lang||'fr';
    if(!t){res.writeHead(400);res.end('{}');return;}
    try{const r=await resolveTitle(t,lang);res.setHeader('Content-Type','application/json');res.writeHead(200);res.end(JSON.stringify(r));}
    catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}
    return;
  }
  // API: search (autocomplete)
  if(pn==='/api/search'){
    const q=parsed.query.q,lang=parsed.query.lang||'fr';
    if(!q){res.setHeader('Content-Type','application/json');res.writeHead(200);res.end('[]');return;}
    try{const r=await searchTitles(q,lang);res.setHeader('Content-Type','application/json');res.writeHead(200);res.end(JSON.stringify(r));}
    catch(e){res.writeHead(500);res.end('[]');}
    return;
  }
  // API: random
  if(pn==='/api/random'){
    const lang=parsed.query.lang||'fr';
    try{const t=await randomArticle(lang);res.setHeader('Content-Type','application/json');res.writeHead(200);res.end(JSON.stringify({title:t}));}
    catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}
    return;
  }

  // Wiki proxy
  if(pn.startsWith('/wiki-proxy/')){
    const lang=parsed.query._lang||'fr';
    const wikiPath=pn.replace('/wiki-proxy','');const qs_obj={...parsed.query};delete qs_obj._lang;
    const qs_str=Object.keys(qs_obj).length?'?'+new URLSearchParams(qs_obj).toString():'';
    const opts={hostname:wikiHost(lang),path:wikiPath+qs_str,method:'GET',headers:{'User-Agent':'WikiRaceGame/4.0','Accept':req.headers['accept']||'*/*','Accept-Encoding':'identity','Accept-Language':lang}};
    try{
      const wr=await wikiReq(opts);let ct=wr.headers['content-type']||'';
      if(wr.statusCode===404&&wikiPath.startsWith('/wiki/')){
        const raw=decodeURIComponent(wikiPath.replace('/wiki/',''));
        try{const r=await resolveTitle(raw,lang);if(r.found){res.writeHead(302,{Location:'/wiki-proxy/wiki/'+encodeURIComponent(r.title.replace(/ /g,'_'))+'?_lang='+lang});res.end();return;}}catch(_){}
        res.setHeader('Content-Type','text/html;charset=utf-8');res.writeHead(200);
        res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:80vh;background:#fafafa;color:#333}.box{text-align:center;padding:2rem}h2{color:#c33}.btn{margin-top:1rem;padding:10px 24px;background:#0645ad;color:#fff;border:none;border-radius:6px;font-size:15px;cursor:pointer}</style></head><body><div class="box"><h2>Page introuvable</h2><p>« ${raw.replace(/_/g,' ')} »</p><button class="btn" onclick="window.parent.postMessage({type:'wiki_retry'},'*')">↩ Retour</button></div></body></html>`);
        return;
      }
      res.setHeader('Cache-Control','public,max-age=300');
      if(ct.includes('text/html')){
        let body='';wr.setEncoding('utf8');wr.on('data',c=>body+=c);wr.on('end',()=>{
          body=body.replace(/href="\/wiki\//g,'href="/wiki-proxy/wiki/').replace(/href="\/w\//g,'href="/wiki-proxy/w/').replace(/src="\/\/upload\.wikimedia\.org/g,'src="https://upload.wikimedia.org').replace(/src="\/static\//g,`src="https://${wikiHost(lang)}/static/`).replace(/href="\/static\//g,`href="https://${wikiHost(lang)}/static/`).replace(/<link[^>]+rel="canonical"[^>]*>/gi,'');
          const script=`<script>(function(){function getTitle(){var h=document.querySelector('#firstHeading .mw-page-title-main')||document.querySelector('#firstHeading');return h?h.textContent.trim():document.title.replace(/\\s*[-—].*$/,'').trim();}document.querySelectorAll('a[href*="/wiki-proxy/wiki/"]').forEach(function(a){var h=a.getAttribute('href');if(h){a.setAttribute('href',h+(h.includes('?')?'&':'?')+'_lang=${lang}');}});document.addEventListener('click',function(e){var a=e.target.closest('a');if(!a)return;var href=a.getAttribute('href');if(!href)return;if(href.startsWith('/wiki-proxy/wiki/')){var aw=href.replace('/wiki-proxy/wiki/','').split('?')[0];var dec=decodeURIComponent(aw.split('#')[0]);if(dec.includes(':')){e.preventDefault();return;}if(aw.startsWith('#'))return;e.preventDefault();window.parent.postMessage({type:'wiki_navigate',title:dec.replace(/_/g,' '),href:href},'*');}else if(!href.startsWith('#')&&!href.startsWith('javascript')){e.preventDefault();}});window.addEventListener('message',function(e){if(e.data&&e.data.type==='set_ctrlf')window._ctrlf=e.data.allowed;});document.addEventListener('keydown',function(e){if((e.ctrlKey||e.metaKey)&&e.key==='f'&&!window._ctrlf){e.preventDefault();window.parent.postMessage({type:'ctrlf_blocked'},'*');}});window.parent.postMessage({type:'wiki_loaded',title:getTitle()},'*');})();<\/script>`;
          body=body.replace('</body>',script+'</body>');
          res.setHeader('Content-Type',ct);res.writeHead(200);res.end(body);
        });
      }else{res.setHeader('Content-Type',ct);res.writeHead(wr.statusCode);wr.pipe(res);}
    }catch(e){
      res.setHeader('Content-Type','text/html;charset=utf-8');res.writeHead(200);
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:80vh;background:#fafafa;color:#333}.box{text-align:center;padding:2rem}.btn{margin-top:1rem;padding:10px 24px;background:#0645ad;color:#fff;border:none;border-radius:6px;font-size:15px;cursor:pointer}</style></head><body><div class="box"><h2>Erreur</h2><button class="btn" onclick="location.reload()">Réessayer</button><button class="btn" style="background:#666" onclick="window.parent.postMessage({type:'wiki_retry'},'*')">↩ Retour</button></div></body></html>`);
    }
    return;
  }

  // Serve HTML
  if(pn==='/'||pn==='/index.html'){
    fs.readFile(path.join(__dirname,'public','index.html'),(err,data)=>{
      if(err){res.writeHead(404);res.end('Not found');return;}
      res.setHeader('Content-Type','text/html');res.writeHead(200);res.end(data);
    });return;
  }
  res.writeHead(404);res.end('Not found');
});

// ── WEBSOCKET ──
const wss=new WebSocketServer({server});
setInterval(()=>{lobbies.forEach((l,c)=>{if(l.players.size===0&&(!l.spectators||l.spectators.size===0))lobbies.delete(c);});},60000);

wss.on('connection',ws=>{
  let myPid=null,myCode=null,isSpec=false;
  ws.isAlive=true;ws.on('pong',()=>{ws.isAlive=true;});

  ws.on('message',raw=>{
    let msg;try{msg=JSON.parse(raw);}catch{return;}
    switch(msg.type){

    case'create_lobby':{
      const code=genCode();myPid=msg.pid;myCode=code;
      const L={code,host:myPid,phase:'lobby',gameStart:'',gameEnd:'',startTime:0,mode:'first_finish',ctrlF:false,lang:'fr',timeLimit:0,players:new Map(),spectators:new Map(),history:[],_timer:null};
      L.players.set(myPid,{pid:myPid,name:msg.name,colorIdx:0,ws,path:[],clicks:0,finished:false,finishTime:0,score:0});
      lobbies.set(code,L);
      ws.send(JSON.stringify({type:'lobby_created',code,lobby:lobbyJSON(L)}));
      break;
    }

    case'join_lobby':{
      const code=(msg.code||'').toUpperCase();const L=lobbies.get(code);
      if(!L){ws.send(JSON.stringify({type:'error',msg:'Lobby introuvable.'}));return;}
      if(L.players.size>=10){ws.send(JSON.stringify({type:'error',msg:'Lobby plein (10 max).'}));return;}
      if(L.phase==='playing'){myPid=msg.pid;myCode=code;isSpec=true;L.spectators.set(myPid,{pid:myPid,name:msg.name,ws});ws.send(JSON.stringify({type:'spectator_joined',code,lobby:lobbyJSON(L)}));return;}
      myPid=msg.pid;myCode=code;
      L.players.set(myPid,{pid:myPid,name:msg.name,colorIdx:L.players.size,ws,path:[],clicks:0,finished:false,finishTime:0,score:0});
      ws.send(JSON.stringify({type:'lobby_joined',code,lobby:lobbyJSON(L)}));
      broadcast(L,{type:'player_joined',lobby:lobbyJSON(L)},myPid);
      break;
    }

    case'update_config':{
      const L=lobbies.get(myCode);if(!L||L.host!==myPid)return;
      if(msg.mode!==undefined)L.mode=msg.mode;
      if(msg.ctrlF!==undefined)L.ctrlF=msg.ctrlF;
      if(msg.lang!==undefined)L.lang=msg.lang;
      if(msg.timeLimit!==undefined)L.timeLimit=msg.timeLimit;
      if(msg.gameStart!==undefined)L.gameStart=msg.gameStart;
      if(msg.gameEnd!==undefined)L.gameEnd=msg.gameEnd;
      broadcastAll(L,{type:'config_updated',mode:L.mode,ctrlF:L.ctrlF,lang:L.lang,timeLimit:L.timeLimit,gameStart:L.gameStart,gameEnd:L.gameEnd});
      break;
    }

    case'start_game':{
      const L=lobbies.get(myCode);if(!L||L.host!==myPid)return;
      L.phase='playing';L.gameStart=msg.start;L.gameEnd=msg.end;L.startTime=Date.now()+4000;
      if(msg.mode)L.mode=msg.mode;if(msg.ctrlF!==undefined)L.ctrlF=msg.ctrlF;if(msg.lang)L.lang=msg.lang;if(msg.timeLimit!==undefined)L.timeLimit=msg.timeLimit;
      L.players.forEach(p=>{p.path=[];p.clicks=0;p.finished=false;p.finishTime=0;p.cheating=false;});
      broadcastAll(L,{type:'game_start',start:msg.start,end:msg.end,mode:L.mode,ctrlF:L.ctrlF,lang:L.lang,timeLimit:L.timeLimit,serverStart:L.startTime});
      // Timer limit
      if(L.timeLimit>0){
        L._timer=setTimeout(()=>{
          if(L.phase!=='playing')return;
          // Find fastest finished or null
          const fin=[...L.players.values()].filter(p=>p.finished).sort((a,b)=>a.finishTime-b.finishTime);
          endGame(L,fin[0]?.pid||null);
        },(L.timeLimit*60*1000)+4000); // +4s for countdown
      }
      break;
    }

    case'player_update':{
      const L=lobbies.get(myCode);if(!L||isSpec)return;
      const player=L.players.get(myPid);if(!player)return;
      player.path=msg.path||[];player.clicks=msg.clicks||0;player.finished=!!msg.finished;player.finishTime=msg.finishTime||0;
      broadcast(L,{type:'player_update',pid:myPid,path:player.path,clicks:player.clicks,finished:player.finished,finishTime:player.finishTime},myPid);
      if(player.finished&&L.phase==='playing'){
        if(L.mode==='first_finish'){
          endGame(L,myPid);
        }else{
          const all=[...L.players.values()];
          if(all.every(p=>p.finished)){
            const fastest=[...all].sort((a,b)=>a.finishTime-b.finishTime)[0];
            endGame(L,fastest.pid);
          }
        }
      }
      break;
    }

    case'verify_link':{
      const L=lobbies.get(myCode);if(!L)return;
      verifyLink(msg.from,msg.to,L.lang||'fr').then(valid=>{
        ws.send(JSON.stringify({type:'link_verified',from:msg.from,to:msg.to,valid,reqId:msg.reqId}));
        if(!valid){const p=L.players.get(myPid);if(p){p.cheating=true;broadcastAll(L,{type:'cheat_detected',pid:myPid,name:p.name});}}
      });
      break;
    }

    case'force_end':{
      const L=lobbies.get(myCode);if(!L||L.host!==myPid)return;
      const fin=[...L.players.values()].filter(p=>p.finished).sort((a,b)=>a.finishTime-b.finishTime);
      endGame(L,fin[0]?.pid||null);
      break;
    }

    case'back_to_lobby':{
      const L=lobbies.get(myCode);if(!L||L.host!==myPid)return;
      L.phase='lobby';
      L.players.forEach(p=>{p.path=[];p.clicks=0;p.finished=false;p.finishTime=0;p.cheating=false;});
      L.spectators.forEach((s,sid)=>{if(L.players.size<10)L.players.set(sid,{pid:sid,name:s.name,colorIdx:L.players.size,ws:s.ws,path:[],clicks:0,finished:false,finishTime:0,score:0});});
      L.spectators.clear();
      broadcastAll(L,{type:'back_to_lobby',lobby:lobbyJSON(L)});
      break;
    }

    case'ping':{ws.send(JSON.stringify({type:'pong'}));break;}
    }
  });

  ws.on('close',()=>{
    if(!myCode||!myPid)return;const L=lobbies.get(myCode);if(!L)return;
    if(isSpec){L.spectators.delete(myPid);return;}
    L.players.delete(myPid);
    if(L.players.size===0){if(L._timer)clearTimeout(L._timer);lobbies.delete(myCode);return;}
    if(L.host===myPid)L.host=L.players.keys().next().value;
    broadcastAll(L,{type:'player_left',pid:myPid,lobby:lobbyJSON(L)});
  });
});

setInterval(()=>{wss.clients.forEach(ws=>{if(!ws.isAlive)return ws.terminate();ws.isAlive=false;ws.ping();});},30000);
server.listen(PORT,()=>console.log(`\n  WikiRace v4.0 → http://localhost:${PORT}\n`));
