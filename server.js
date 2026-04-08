const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const url = require('url');

const PORT = process.env.PORT || 3000;

// ── LOBBIES STATE ──
const lobbies = new Map();
// lobby: { code, host, phase:'lobby'|'playing'|'results', gameStart, gameEnd, startTime, players: Map<pid, player> }
// player: { pid, name, colorIdx, ws, path[], clicks, finished, finishTime }

function genCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function lobbyToJSON(lobby) {
  const players = {};
  lobby.players.forEach((p, pid) => {
    players[pid] = { pid: p.pid, name: p.name, colorIdx: p.colorIdx, path: p.path, clicks: p.clicks, finished: p.finished, finishTime: p.finishTime };
  });
  return { code: lobby.code, host: lobby.host, phase: lobby.phase, gameStart: lobby.gameStart, gameEnd: lobby.gameEnd, startTime: lobby.startTime, players };
}

function broadcast(lobby, msg, excludePid = null) {
  const data = JSON.stringify(msg);
  lobby.players.forEach((p) => {
    if (p.pid !== excludePid && p.ws && p.ws.readyState === 1) {
      p.ws.send(data);
    }
  });
}

function broadcastAll(lobby, msg) {
  const data = JSON.stringify(msg);
  lobby.players.forEach((p) => {
    if (p.ws && p.ws.readyState === 1) p.ws.send(data);
  });
}

// ── GAME SCRIPT injected into every Wikipedia page ──
const INJECTED_SCRIPT = `
<style>
#mw-navigation,#mw-head,#mw-panel,.mw-editsection,
.vector-header,.vector-page-toolbar,.vector-column-end,
#siteNotice,.mw-footer,#catlinks,.noprint,
.navbox,.sidebar,.infobox-navbar{display:none!important}
body{padding-top:0!important;margin-top:0!important}
#content,#bodyContent,.mw-body{margin:0!important;padding:1rem 1.5rem!important;max-width:860px}
a[href^="/wiki-proxy/wiki/"]:not([href*=":"]):not([href*="#"]){
  color:#1a7fd4!important;cursor:pointer!important;text-decoration:underline}
</style>
<script>
(function(){
  function getTitle(){
    var h=document.querySelector('.mw-page-title-main')||document.querySelector('#firstHeading');
    if(h)return h.textContent.trim();
    return document.title.replace(/\\s*[\\u2014\\-].*$/,'').trim();
  }
  function sendLoaded(){
    window.parent.postMessage({type:'wiki_loaded',title:getTitle()},'*');
  }
  document.addEventListener('click',function(e){
    var a=e.target.closest('a');
    if(!a)return;
    var href=a.getAttribute('href')||'';
    if(href.startsWith('/wiki-proxy/wiki/')&&!href.includes(':')&&!href.includes('#')){
      e.preventDefault();e.stopPropagation();
      var raw=decodeURIComponent(href.replace('/wiki-proxy/wiki/','')).replace(/_/g,' ');
      window.parent.postMessage({type:'wiki_navigate',title:raw,href:href},'*');
    } else if(href.startsWith('#')||href===''){
      /* anchor scroll OK */
    } else if(!href.startsWith('javascript')){
      e.preventDefault();
    }
  },true);
  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',sendLoaded);}
  else{sendLoaded();}
})();
<\/script>`;

const ERROR_PAGE = (title, msg) => `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>body{font-family:sans-serif;background:#0a0a0a;color:#f0ede6;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:16px;text-align:center;padding:2rem}
h2{color:#d4ff00;font-size:22px}p{color:#888;font-size:14px}strong{color:#aaa}
button{padding:11px 22px;background:#d4ff00;color:#000;border:none;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;margin-top:4px}
button.sec{background:transparent;color:#666;border:1px solid #333;margin-top:0}
button:hover{opacity:.85}</style></head><body>
<h2>Page introuvable</h2><p>${msg}</p>
<p><strong>${title.replace(/</g,'&lt;')}</strong></p>
<button onclick="window.parent.postMessage({type:'wiki_retry',title:${JSON.stringify(title)}},'*')">Recharger</button>
<button class="sec" onclick="window.parent.postMessage({type:'wiki_back'},'*')">Page precedente</button>
</body></html>`;

function fetchWiki(wikiPath, qs, res, attempt) {
  const options = {
    hostname: 'fr.wikipedia.org',
    path: wikiPath + qs,
    method: 'GET',
    timeout: 10000,
    headers: {
      'User-Agent': 'WikiRaceGame/1.0 (educational multiplayer game)',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Encoding': 'identity',
      'Accept-Language': 'fr-FR,fr;q=0.9',
      'Connection': 'keep-alive',
    }
  };

  const proxyReq = https.request(options, (wikiRes) => {
    const status = wikiRes.statusCode;

    // Follow redirects
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = wikiRes.headers['location'] || '';
      wikiRes.resume();
      if (attempt >= 5) { res.writeHead(502); res.end('Too many redirects'); return; }
      let newPath = location
        .replace('https://fr.wikipedia.org', '')
        .replace('//fr.wikipedia.org', '');
      if (newPath.startsWith('/wiki/') || newPath.startsWith('/w/')) {
        return fetchWiki(newPath, '', res, attempt + 1);
      }
      res.writeHead(302, { Location: '/wiki-proxy' + newPath });
      res.end();
      return;
    }

    const ct = wikiRes.headers['content-type'] || '';
    if (!res.headersSent) {
      res.setHeader('Content-Type', ct.includes('text/html') ? 'text/html; charset=utf-8' : ct);
      res.setHeader('Cache-Control', 'public, max-age=180');
    }

    if (ct.includes('text/html')) {
      let body = '';
      wikiRes.setEncoding('utf8');
      wikiRes.on('data', c => body += c);
      wikiRes.on('end', () => {
        if (status === 404 || status === 410 || body.includes('noarticletext')) {
          const m = wikiPath.match(/\/wiki\/(.+)/);
          const t = m ? decodeURIComponent(m[1]).replace(/_/g, ' ') : wikiPath;
          if (!res.headersSent) { res.writeHead(200); res.end(ERROR_PAGE(t, 'Cette page Wikipedia n\'existe pas ou a ete deplacee.')); }
          return;
        }
        body = body
          .replace(/href="\/wiki\//g, 'href="/wiki-proxy/wiki/')
          .replace(/href="\/w\//g, 'href="/wiki-proxy/w/')
          .replace(/action="\/w\//g, 'action="/wiki-proxy/w/')
          .replace(/src="\/\/upload\.wikimedia\.org/g, 'src="https://upload.wikimedia.org')
          .replace(/srcset="\/\/upload\.wikimedia\.org/g, 'srcset="https://upload.wikimedia.org')
          .replace(/src="\/static\//g, 'src="https://fr.wikipedia.org/static/')
          .replace(/href="\/static\//g, 'href="https://fr.wikipedia.org/static/')
          .replace(/<link[^>]+rel="canonical"[^>]*>/gi, '')
          .replace(/<meta[^>]+http-equiv="refresh"[^>]*>/gi, '');
        if (body.includes('</body>')) body = body.replace('</body>', INJECTED_SCRIPT + '\n</body>');
        else body += INJECTED_SCRIPT;
        if (!res.headersSent) { res.writeHead(200); res.end(body); }
      });
      wikiRes.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end('Stream error'); } });
    } else {
      if (!res.headersSent) res.writeHead(status);
      wikiRes.pipe(res);
    }
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (attempt < 2) return fetchWiki(wikiPath, qs, res, attempt + 1);
    const m = wikiPath.match(/\/wiki\/(.+)/);
    const t = m ? decodeURIComponent(m[1]).replace(/_/g, ' ') : wikiPath;
    if (!res.headersSent) { res.writeHead(200); res.end(ERROR_PAGE(t, 'Wikipedia met trop de temps a repondre. Reessaie !')); }
  });

  proxyReq.on('error', (e) => {
    if (attempt < 2) return setTimeout(() => fetchWiki(wikiPath, qs, res, attempt + 1), 800);
    const m = wikiPath.match(/\/wiki\/(.+)/);
    const t = m ? decodeURIComponent(m[1]).replace(/_/g, ' ') : wikiPath;
    if (!res.headersSent) { res.writeHead(200); res.end(ERROR_PAGE(t, 'Erreur reseau : ' + e.message)); }
  });

  proxyReq.end();
}

// ── HTTP SERVER ──
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Wikipedia proxy (with redirect following + retry + error page) ──
  if (pathname.startsWith('/wiki-proxy/')) {
    const wikiPath = pathname.replace('/wiki-proxy', '');
    const qs = parsed.search || '';
    fetchWiki(wikiPath, qs, res, 0);
    return;
  }

  // ── Serve index.html ──
  if (pathname === '/' || pathname === '/index.html') {
    const filePath = path.join(__dirname, 'public', 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.setHeader('Content-Type', 'text/html');
      res.writeHead(200);
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ── WEBSOCKET SERVER ──
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let myPid = null;
  let myCode = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'create_lobby': {
        const code = genCode();
        myPid = msg.pid;
        myCode = code;
        const lobby = {
          code, host: myPid, phase: 'lobby',
          gameStart: '', gameEnd: '', startTime: 0,
          players: new Map()
        };
        const colorIdx = 0;
        lobby.players.set(myPid, { pid: myPid, name: msg.name, colorIdx, ws, path: [], clicks: 0, finished: false, finishTime: 0 });
        lobbies.set(code, lobby);
        ws.send(JSON.stringify({ type: 'lobby_created', code, lobby: lobbyToJSON(lobby) }));
        break;
      }

      case 'join_lobby': {
        const code = msg.code.toUpperCase();
        const lobby = lobbies.get(code);
        if (!lobby) { ws.send(JSON.stringify({ type: 'error', msg: 'Lobby introuvable.' })); return; }
        if (lobby.phase === 'playing') { ws.send(JSON.stringify({ type: 'error', msg: 'Partie déjà en cours.' })); return; }
        myPid = msg.pid;
        myCode = code;
        const colorIdx = lobby.players.size;
        lobby.players.set(myPid, { pid: myPid, name: msg.name, colorIdx, ws, path: [], clicks: 0, finished: false, finishTime: 0 });
        ws.send(JSON.stringify({ type: 'lobby_joined', code, lobby: lobbyToJSON(lobby) }));
        broadcast(lobby, { type: 'player_joined', lobby: lobbyToJSON(lobby) }, myPid);
        break;
      }

      case 'start_game': {
        const lobby = lobbies.get(myCode);
        if (!lobby || lobby.host !== myPid) return;
        lobby.phase = 'playing';
        lobby.gameStart = msg.start;
        lobby.gameEnd = msg.end;
        lobby.startTime = Date.now() + 3500;
        lobby.players.forEach(p => { p.path = []; p.clicks = 0; p.finished = false; p.finishTime = 0; });
        broadcastAll(lobby, { type: 'game_start', start: msg.start, end: msg.end, serverStart: lobby.startTime });
        break;
      }

      case 'player_update': {
        const lobby = lobbies.get(myCode);
        if (!lobby) return;
        const player = lobby.players.get(myPid);
        if (!player) return;
        player.path = msg.path;
        player.clicks = msg.clicks;
        player.finished = msg.finished;
        player.finishTime = msg.finishTime;
        broadcast(lobby, { type: 'player_update', pid: myPid, path: msg.path, clicks: msg.clicks, finished: msg.finished, finishTime: msg.finishTime }, myPid);
        // Check all finished
        const all = [...lobby.players.values()];
        const done = all.filter(p => p.finished);
        if (done.length === all.length && lobby.phase === 'playing') {
          lobby.phase = 'results';
          const results = all.map(p => ({ pid: p.pid, name: p.name, colorIdx: p.colorIdx, path: [...p.path], clicks: p.clicks, finished: p.finished, finishTime: p.finishTime }));
          results.sort((a, b) => { if (a.finished && !b.finished) return -1; if (!a.finished && b.finished) return 1; return a.finishTime - b.finishTime; });
          setTimeout(() => broadcastAll(lobby, { type: 'game_end', results }), 1500);
        }
        break;
      }

      case 'force_end': {
        const lobby = lobbies.get(myCode);
        if (!lobby || lobby.host !== myPid) return;
        lobby.phase = 'results';
        const all = [...lobby.players.values()];
        const results = all.map(p => ({ pid: p.pid, name: p.name, colorIdx: p.colorIdx, path: [...p.path], clicks: p.clicks, finished: p.finished, finishTime: p.finishTime }));
        results.sort((a, b) => { if (a.finished && !b.finished) return -1; if (!a.finished && b.finished) return 1; return a.finishTime - b.finishTime; });
        broadcastAll(lobby, { type: 'game_end', results });
        break;
      }

      case 'back_to_lobby': {
        const lobby = lobbies.get(myCode);
        if (!lobby || lobby.host !== myPid) return;
        lobby.phase = 'lobby';
        lobby.players.forEach(p => { p.path = []; p.clicks = 0; p.finished = false; p.finishTime = 0; });
        broadcastAll(lobby, { type: 'back_to_lobby', lobby: lobbyToJSON(lobby) });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!myCode || !myPid) return;
    const lobby = lobbies.get(myCode);
    if (!lobby) return;
    lobby.players.delete(myPid);
    if (lobby.players.size === 0) { lobbies.delete(myCode); return; }
    if (lobby.host === myPid) {
      lobby.host = lobby.players.keys().next().value;
    }
    broadcastAll(lobby, { type: 'player_left', pid: myPid, lobby: lobbyToJSON(lobby) });
  });
});

server.listen(PORT, () => {
  console.log(`WikiRace server running on http://localhost:${PORT}`);
});
