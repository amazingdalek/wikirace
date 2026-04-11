const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const url = require('url');

const PORT = process.env.PORT || 3000;
const lobbies = new Map();

function genCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let c = ''; for (let i = 0; i < 5; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function lobbyToJSON(lobby) {
  const players = {};
  lobby.players.forEach((p, pid) => {
    players[pid] = { pid: p.pid, name: p.name, colorIdx: p.colorIdx, path: p.path, clicks: p.clicks, finished: p.finished, finishTime: p.finishTime, score: p.score || 0 };
  });
  return { code: lobby.code, host: lobby.host, phase: lobby.phase, gameStart: lobby.gameStart, gameEnd: lobby.gameEnd, startTime: lobby.startTime, players, mode: lobby.mode, ctrlF: lobby.ctrlF, history: lobby.history || [], spectatorCount: lobby.spectators ? lobby.spectators.size : 0 };
}

function broadcastTo(targets, msg) {
  const data = JSON.stringify(msg);
  targets.forEach(p => { if (p.ws && p.ws.readyState === 1) p.ws.send(data); });
}
function broadcast(lobby, msg, excl) {
  const data = JSON.stringify(msg);
  lobby.players.forEach(p => { if (p.pid !== excl && p.ws && p.ws.readyState === 1) p.ws.send(data); });
  if (lobby.spectators) lobby.spectators.forEach(s => { if (s.ws && s.ws.readyState === 1) s.ws.send(data); });
}
function broadcastAll(lobby, msg) { broadcast(lobby, msg, null); }

// ── WIKI HELPERS ──
function wikiRequest(options, maxRedir = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedir <= 0) return reject(new Error('Too many redirects'));
    const req = https.request(options, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        const loc = new URL(res.headers.location, `https://${options.hostname}`);
        res.resume();
        return wikiRequest({ ...options, hostname: loc.hostname, path: loc.pathname + (loc.search || '') }, maxRedir-1).then(resolve).catch(reject);
      }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function wikiAPI(apiPath) {
  return new Promise((resolve, reject) => {
    wikiRequest({ hostname: 'fr.wikipedia.org', path: apiPath, method: 'GET', headers: { 'User-Agent': 'WikiRaceGame/3.0', Accept: 'application/json' } })
      .then(res => { let b=''; res.setEncoding('utf8'); res.on('data',c=>b+=c); res.on('end',()=>{ try{resolve(JSON.parse(b))}catch(e){reject(e)} }); })
      .catch(reject);
  });
}

async function resolveWikiTitle(title) {
  const data = await wikiAPI(`/w/api.php?action=query&titles=${encodeURIComponent(title)}&redirects=1&format=json`);
  const pages = data.query.pages; const pid = Object.keys(pages)[0];
  return pid === '-1' ? { found: false, title } : { found: true, title: pages[pid].title, pageId: pid };
}

async function getRandomArticle() {
  const data = await wikiAPI(`/w/api.php?action=query&list=random&rnnamespace=0&rnlimit=1&format=json`);
  return data.query.random[0].title;
}

// ── ANTI-CHEAT: verify link exists ──
const linkCache = new Map();
async function verifyWikiLink(from, to) {
  const key = `${from}|${to}`;
  if (linkCache.has(key)) return linkCache.get(key);
  try {
    const data = await wikiAPI(`/w/api.php?action=query&titles=${encodeURIComponent(from)}&prop=links&pllimit=500&pltitles=${encodeURIComponent(to)}&format=json`);
    const pages = data.query.pages; const pid = Object.keys(pages)[0];
    const valid = !!(pages[pid] && pages[pid].links && pages[pid].links.length > 0);
    linkCache.set(key, valid);
    if (linkCache.size > 5000) linkCache.delete(linkCache.keys().next().value);
    return valid;
  } catch { return true; } // fail open
}

function buildResults(lobby) {
  return [...lobby.players.values()]
    .map(p => ({ pid:p.pid, name:p.name, colorIdx:p.colorIdx, path:[...p.path], clicks:p.clicks, finished:p.finished, finishTime:p.finishTime, score:p.score||0, cheating:!!p.cheating }))
    .sort((a,b) => { if(a.finished&&!b.finished)return-1; if(!a.finished&&b.finished)return 1; if(a.finished&&b.finished)return a.finishTime-b.finishTime; return 0; });
}

// ── HTTP ──
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true); const pathname = parsed.pathname;
  res.setHeader('Access-Control-Allow-Origin','*'); res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS'); res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method==='OPTIONS'){res.writeHead(204);res.end();return;}

  if (pathname==='/api/resolve') {
    const t=parsed.query.title; if(!t){res.writeHead(400);res.end('{}');return;}
    try{const r=await resolveWikiTitle(t);res.setHeader('Content-Type','application/json');res.writeHead(200);res.end(JSON.stringify(r));}
    catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}
    return;
  }
  if (pathname==='/api/random') {
    try{const t=await getRandomArticle();res.setHeader('Content-Type','application/json');res.writeHead(200);res.end(JSON.stringify({title:t}));}
    catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}
    return;
  }

  if (pathname.startsWith('/wiki-proxy/')) {
    const wikiPath=pathname.replace('/wiki-proxy',''); const qs=parsed.search||'';
    const opts={hostname:'fr.wikipedia.org',path:wikiPath+qs,method:'GET',headers:{'User-Agent':'WikiRaceGame/3.0','Accept':req.headers['accept']||'*/*','Accept-Encoding':'identity','Accept-Language':'fr'}};
    try {
      const wr = await wikiRequest(opts);
      let ct=wr.headers['content-type']||'';
      if(wr.statusCode===404&&wikiPath.startsWith('/wiki/')){
        const raw=decodeURIComponent(wikiPath.replace('/wiki/',''));
        try{const r=await resolveWikiTitle(raw);if(r.found){res.writeHead(302,{Location:'/wiki-proxy/wiki/'+encodeURIComponent(r.title.replace(/ /g,'_'))});res.end();return;}}catch(_){}
        res.setHeader('Content-Type','text/html;charset=utf-8');res.writeHead(200);
        res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:80vh;background:#fafafa;color:#333}.box{text-align:center;padding:2rem}h2{color:#c33}.btn{margin-top:1rem;padding:10px 24px;background:#0645ad;color:#fff;border:none;border-radius:6px;font-size:15px;cursor:pointer}</style></head><body><div class="box"><h2>Page introuvable</h2><p>« ${raw.replace(/_/g,' ')} » n'existe pas.</p><button class="btn" onclick="window.parent.postMessage({type:'wiki_retry'},'*')">↩ Retour</button></div></body></html>`);
        return;
      }
      res.setHeader('Cache-Control','public,max-age=300');
      if(ct.includes('text/html')){
        let body='';wr.setEncoding('utf8');wr.on('data',c=>body+=c);wr.on('end',()=>{
          body=body.replace(/href="\/wiki\//g,'href="/wiki-proxy/wiki/').replace(/href="\/w\//g,'href="/wiki-proxy/w/').replace(/src="\/\/upload\.wikimedia\.org/g,'src="https://upload.wikimedia.org').replace(/src="\/static\//g,'src="https://fr.wikipedia.org/static/').replace(/href="\/static\//g,'href="https://fr.wikipedia.org/static/').replace(/<link[^>]+rel="canonical"[^>]*>/gi,'');
          const script=`<script>(function(){function getTitle(){var h=document.querySelector('#firstHeading .mw-page-title-main')||document.querySelector('#firstHeading');return h?h.textContent.trim():document.title.replace(/\\s*[-—].*$/,'').trim();}document.addEventListener('click',function(e){var a=e.target.closest('a');if(!a)return;var href=a.getAttribute('href');if(!href)return;if(href.startsWith('/wiki-proxy/wiki/')){var aw=href.replace('/wiki-proxy/wiki/','');var dec=decodeURIComponent(aw.split('#')[0]);if(dec.includes(':')){e.preventDefault();return;}if(aw.startsWith('#'))return;e.preventDefault();window.parent.postMessage({type:'wiki_navigate',title:dec.replace(/_/g,' '),href:href},'*');}else if(!href.startsWith('#')&&!href.startsWith('javascript')){e.preventDefault();}});window.addEventListener('message',function(e){if(e.data&&e.data.type==='set_ctrlf')window._ctrlf=e.data.allowed;});document.addEventListener('keydown',function(e){if((e.ctrlKey||e.metaKey)&&e.key==='f'&&!window._ctrlf){e.preventDefault();window.parent.postMessage({type:'ctrlf_blocked'},'*');}});window.parent.postMessage({type:'wiki_loaded',title:getTitle()},'*');})();<\/script>`;
          body=body.replace('</body>',script+'</body>');
          res.setHeader('Content-Type',ct);res.writeHead(200);res.end(body);
        });
      } else { res.setHeader('Content-Type',ct);res.writeHead(wr.statusCode);wr.pipe(res); }
    } catch(e){
      res.setHeader('Content-Type','text/html;charset=utf-8');res.writeHead(200);
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:80vh;background:#fafafa;color:#333}.box{text-align:center;padding:2rem}.btn{margin-top:1rem;padding:10px 24px;background:#0645ad;color:#fff;border:none;border-radius:6px;font-size:15px;cursor:pointer}</style></head><body><div class="box"><h2>Erreur</h2><p>Chargement impossible.</p><button class="btn" onclick="location.reload()">Réessayer</button><button class="btn" style="background:#666" onclick="window.parent.postMessage({type:'wiki_retry'},'*')">↩ Retour</button></div></body></html>`);
    }
    return;
  }

  if(pathname==='/'||pathname==='/index.html'){
    fs.readFile(path.join(__dirname,'public','index.html'),(err,data)=>{
      if(err){res.writeHead(404);res.end('Not found');return;}
      res.setHeader('Content-Type','text/html');res.writeHead(200);res.end(data);
    });return;
  }
  res.writeHead(404);res.end('Not found');
});

// ── WS ──
const wss = new WebSocketServer({ server });
setInterval(()=>{lobbies.forEach((l,c)=>{if(l.players.size===0&&(!l.spectators||l.spectators.size===0))lobbies.delete(c);});},60000);

wss.on('connection', ws => {
  let myPid=null,myCode=null,isSpec=false;
  ws.isAlive=true; ws.on('pong',()=>{ws.isAlive=true;});

  ws.on('message', raw => {
    let msg; try{msg=JSON.parse(raw);}catch{return;}

    switch(msg.type){
      case 'create_lobby':{
        const code=genCode();myPid=msg.pid;myCode=code;
        const lobby={code,host:myPid,phase:'lobby',gameStart:'',gameEnd:'',startTime:0,mode:'first_finish',ctrlF:false,players:new Map(),spectators:new Map(),history:[]};
        lobby.players.set(myPid,{pid:myPid,name:msg.name,colorIdx:0,ws,path:[],clicks:0,finished:false,finishTime:0,score:0});
        lobbies.set(code,lobby);
        ws.send(JSON.stringify({type:'lobby_created',code,lobby:lobbyToJSON(lobby)}));
        break;
      }
      case 'join_lobby':{
        const code=(msg.code||'').toUpperCase();const lobby=lobbies.get(code);
        if(!lobby){ws.send(JSON.stringify({type:'error',msg:'Lobby introuvable.'}));return;}
        if(lobby.players.size>=10){ws.send(JSON.stringify({type:'error',msg:'Lobby plein (10 max).'}));return;}
        if(lobby.phase==='playing'){
          myPid=msg.pid;myCode=code;isSpec=true;
          lobby.spectators.set(myPid,{pid:myPid,name:msg.name,ws});
          ws.send(JSON.stringify({type:'spectator_joined',code,lobby:lobbyToJSON(lobby)}));
          return;
        }
        myPid=msg.pid;myCode=code;
        const ci=lobby.players.size;
        lobby.players.set(myPid,{pid:myPid,name:msg.name,colorIdx:ci,ws,path:[],clicks:0,finished:false,finishTime:0,score:0});
        ws.send(JSON.stringify({type:'lobby_joined',code,lobby:lobbyToJSON(lobby)}));
        broadcast(lobby,{type:'player_joined',lobby:lobbyToJSON(lobby)},myPid);
        break;
      }
      case 'update_config':{
        const lobby=lobbies.get(myCode);if(!lobby||lobby.host!==myPid)return;
        if(msg.mode)lobby.mode=msg.mode;
        if(msg.ctrlF!==undefined)lobby.ctrlF=msg.ctrlF;
        broadcastAll(lobby,{type:'config_updated',mode:lobby.mode,ctrlF:lobby.ctrlF});
        break;
      }
      case 'start_game':{
        const lobby=lobbies.get(myCode);if(!lobby||lobby.host!==myPid)return;
        lobby.phase='playing';lobby.gameStart=msg.start;lobby.gameEnd=msg.end;lobby.startTime=Date.now()+4000;
        if(msg.mode)lobby.mode=msg.mode;if(msg.ctrlF!==undefined)lobby.ctrlF=msg.ctrlF;
        lobby.players.forEach(p=>{p.path=[];p.clicks=0;p.finished=false;p.finishTime=0;p.cheating=false;});
        broadcastAll(lobby,{type:'game_start',start:msg.start,end:msg.end,mode:lobby.mode,ctrlF:lobby.ctrlF,serverStart:lobby.startTime});
        break;
      }
      case 'player_update':{
        const lobby=lobbies.get(myCode);if(!lobby||isSpec)return;
        const player=lobby.players.get(myPid);if(!player)return;
        player.path=msg.path||[];player.clicks=msg.clicks||0;player.finished=!!msg.finished;player.finishTime=msg.finishTime||0;
        broadcast(lobby,{type:'player_update',pid:myPid,path:player.path,clicks:player.clicks,finished:player.finished,finishTime:player.finishTime},myPid);

        if(player.finished&&lobby.phase==='playing'){
          if(lobby.mode==='first_finish'){
            lobby.phase='results';player.score=(player.score||0)+1;
            lobby.history.push({start:lobby.gameStart,end:lobby.gameEnd,winner:player.name,winPid:myPid,time:player.finishTime,clicks:player.clicks,ts:Date.now()});
            const res=buildResults(lobby);
            setTimeout(()=>broadcastAll(lobby,{type:'game_end',results:res,winnerPid:myPid,history:lobby.history}),2000);
          } else {
            const all=[...lobby.players.values()],done=all.filter(p=>p.finished);
            if(done.length===all.length){
              lobby.phase='results';
              const sorted=[...done].sort((a,b)=>a.finishTime-b.finishTime);
              sorted[0].score=(sorted[0].score||0)+1;
              lobby.history.push({start:lobby.gameStart,end:lobby.gameEnd,winner:sorted[0].name,winPid:sorted[0].pid,time:sorted[0].finishTime,clicks:sorted[0].clicks,ts:Date.now()});
              const res=buildResults(lobby);
              setTimeout(()=>broadcastAll(lobby,{type:'game_end',results:res,winnerPid:sorted[0].pid,history:lobby.history}),1500);
            }
          }
        }
        break;
      }
      case 'verify_link':{
        const lobby=lobbies.get(myCode);if(!lobby)return;
        verifyWikiLink(msg.from,msg.to).then(valid=>{
          ws.send(JSON.stringify({type:'link_verified',from:msg.from,to:msg.to,valid,reqId:msg.reqId}));
          if(!valid){const p=lobby.players.get(myPid);if(p){p.cheating=true;broadcastAll(lobby,{type:'cheat_detected',pid:myPid,name:p.name});}}
        });
        break;
      }
      case 'force_end':{
        const lobby=lobbies.get(myCode);if(!lobby||lobby.host!==myPid)return;
        lobby.phase='results';
        const fin=[...lobby.players.values()].filter(p=>p.finished).sort((a,b)=>a.finishTime-b.finishTime);
        if(fin.length>0){fin[0].score=(fin[0].score||0)+1;lobby.history.push({start:lobby.gameStart,end:lobby.gameEnd,winner:fin[0].name,winPid:fin[0].pid,time:fin[0].finishTime,clicks:fin[0].clicks,ts:Date.now()});}
        else lobby.history.push({start:lobby.gameStart,end:lobby.gameEnd,winner:null,winPid:null,time:0,clicks:0,ts:Date.now()});
        broadcastAll(lobby,{type:'game_end',results:buildResults(lobby),winnerPid:fin[0]?.pid||null,history:lobby.history});
        break;
      }
      case 'back_to_lobby':{
        const lobby=lobbies.get(myCode);if(!lobby||lobby.host!==myPid)return;
        lobby.phase='lobby';
        lobby.players.forEach(p=>{p.path=[];p.clicks=0;p.finished=false;p.finishTime=0;p.cheating=false;});
        lobby.spectators.forEach((s,sid)=>{if(lobby.players.size<10)lobby.players.set(sid,{pid:sid,name:s.name,colorIdx:lobby.players.size,ws:s.ws,path:[],clicks:0,finished:false,finishTime:0,score:0});});
        lobby.spectators.clear();
        broadcastAll(lobby,{type:'back_to_lobby',lobby:lobbyToJSON(lobby)});
        break;
      }
      case 'ping':{ws.send(JSON.stringify({type:'pong'}));break;}
    }
  });

  ws.on('close',()=>{
    if(!myCode||!myPid)return;const lobby=lobbies.get(myCode);if(!lobby)return;
    if(isSpec){lobby.spectators.delete(myPid);return;}
    lobby.players.delete(myPid);
    if(lobby.players.size===0){lobbies.delete(myCode);return;}
    if(lobby.host===myPid)lobby.host=lobby.players.keys().next().value;
    broadcastAll(lobby,{type:'player_left',pid:myPid,lobby:lobbyToJSON(lobby)});
  });
});

setInterval(()=>{wss.clients.forEach(ws=>{if(!ws.isAlive)return ws.terminate();ws.isAlive=false;ws.ping();});},30000);
server.listen(PORT,()=>console.log(`\n  WikiRace v3.0 → http://localhost:${PORT}\n`));
