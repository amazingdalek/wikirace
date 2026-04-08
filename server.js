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

// ── HTTP SERVER ──
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Wikipedia proxy ──
  if (pathname.startsWith('/wiki-proxy/')) {
    const wikiPath = pathname.replace('/wiki-proxy', '');
    const qs = parsed.search || '';
    const target = `https://fr.wikipedia.org${wikiPath}${qs}`;

    const options = {
      hostname: 'fr.wikipedia.org',
      path: wikiPath + qs,
      method: 'GET',
      headers: {
        'User-Agent': 'WikiRaceGame/1.0 (educational game)',
        'Accept': req.headers['accept'] || '*/*',
        'Accept-Encoding': 'identity',
        'Accept-Language': 'fr',
      }
    };

    const proxy = https.request(options, (wikiRes) => {
      let ct = wikiRes.headers['content-type'] || '';
      res.setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', 'public, max-age=300');

      if (ct.includes('text/html')) {
        let body = '';
        wikiRes.setEncoding('utf8');
        wikiRes.on('data', c => body += c);
        wikiRes.on('end', () => {
          // Rewrite internal links to go through our proxy
          body = body
            .replace(/href="\/wiki\//g, 'href="/wiki-proxy/wiki/')
            .replace(/href="\/w\//g, 'href="/wiki-proxy/w/')
            .replace(/src="\/\/upload\.wikimedia\.org/g, 'src="https://upload.wikimedia.org')
            .replace(/src="\/static\//g, 'src="https://fr.wikipedia.org/static/')
            .replace(/href="\/static\//g, 'href="https://fr.wikipedia.org/static/')
            .replace(/<link[^>]+rel="canonical"[^>]*>/gi, '')
            // Inject game script to capture clicks & send to parent
            .replace('</body>', `
<script>
(function(){
  function getTitle(){
    var h=document.querySelector('#firstHeading .mw-page-title-main')||document.querySelector('#firstHeading');
    return h?h.textContent.trim():document.title.replace(/\\s*[-—].*$/,'').trim();
  }
  document.addEventListener('click',function(e){
    var a=e.target.closest('a');
    if(!a)return;
    var href=a.getAttribute('href');
    if(!href)return;
    if(href.startsWith('/wiki-proxy/wiki/')&&!href.includes(':')&&!href.includes('#')){
      e.preventDefault();
      var rawTitle=decodeURIComponent(href.replace('/wiki-proxy/wiki/','')).replace(/_/g,' ');
      window.parent.postMessage({type:'wiki_navigate',title:rawTitle,href:href},'*');
    } else if(href.startsWith('/wiki-proxy/wiki/')&&href.includes('#')){
      e.preventDefault();
    } else if(!href.startsWith('/wiki-proxy/wiki/')&&!href.startsWith('#')&&!href.startsWith('javascript')){
      e.preventDefault();
    }
  });
  window.parent.postMessage({type:'wiki_loaded',title:getTitle()},'*');
})();
<\/script>
</body>`);
          res.writeHead(200);
          res.end(body);
        });
      } else {
        res.writeHead(wikiRes.statusCode);
        wikiRes.pipe(res);
      }
    });

    proxy.on('error', (e) => {
      res.writeHead(502);
      res.end('Proxy error: ' + e.message);
    });
    proxy.end();
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
