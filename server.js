const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const url = require('url');

const PORT = process.env.PORT || 3000;

// ── LOBBIES STATE ──
const lobbies = new Map();

function genCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function lobbyToJSON(lobby) {
  const players = {};
  lobby.players.forEach((p, pid) => {
    players[pid] = {
      pid: p.pid, name: p.name, colorIdx: p.colorIdx,
      path: p.path, clicks: p.clicks, finished: p.finished, finishTime: p.finishTime
    };
  });
  return {
    code: lobby.code, host: lobby.host, phase: lobby.phase,
    gameStart: lobby.gameStart, gameEnd: lobby.gameEnd,
    startTime: lobby.startTime, players
  };
}

function broadcast(lobby, msg, excludePid = null) {
  const data = JSON.stringify(msg);
  lobby.players.forEach((p) => {
    if (p.pid !== excludePid && p.ws && p.ws.readyState === 1) p.ws.send(data);
  });
}

function broadcastAll(lobby, msg) {
  const data = JSON.stringify(msg);
  lobby.players.forEach((p) => {
    if (p.ws && p.ws.readyState === 1) p.ws.send(data);
  });
}

// ── WIKI FETCH with redirect following ──
function wikiRequest(options, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));

    const req = https.request(options, (res) => {
      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const loc = new URL(res.headers.location, `https://${options.hostname}`);
        const newOpts = {
          ...options,
          hostname: loc.hostname,
          path: loc.pathname + (loc.search || ''),
        };
        res.resume(); // drain
        return wikiRequest(newOpts, maxRedirects - 1).then(resolve).catch(reject);
      }
      resolve(res);
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ── WIKI API: resolve article title (handles redirects, normalization) ──
function resolveWikiTitle(title) {
  return new Promise((resolve, reject) => {
    const apiPath = `/w/api.php?action=query&titles=${encodeURIComponent(title)}&redirects=1&format=json`;
    const options = {
      hostname: 'fr.wikipedia.org',
      path: apiPath,
      method: 'GET',
      headers: {
        'User-Agent': 'WikiRaceGame/2.0 (educational game)',
        'Accept': 'application/json',
      }
    };

    wikiRequest(options).then(res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const pages = data.query.pages;
          const pageId = Object.keys(pages)[0];
          if (pageId === '-1') {
            resolve({ found: false, title });
          } else {
            resolve({ found: true, title: pages[pageId].title, pageId });
          }
        } catch (e) {
          reject(e);
        }
      });
    }).catch(reject);
  });
}

// ── WIKI API: get random article ──
function getRandomArticle() {
  return new Promise((resolve, reject) => {
    const apiPath = `/w/api.php?action=query&list=random&rnnamespace=0&rnlimit=1&format=json`;
    const options = {
      hostname: 'fr.wikipedia.org',
      path: apiPath,
      method: 'GET',
      headers: { 'User-Agent': 'WikiRaceGame/2.0' }
    };

    wikiRequest(options).then(res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(data.query.random[0].title);
        } catch (e) { reject(e); }
      });
    }).catch(reject);
  });
}

// ── HTTP SERVER ──
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── API: resolve title ──
  if (pathname === '/api/resolve') {
    const title = parsed.query.title;
    if (!title) { res.writeHead(400); res.end(JSON.stringify({ error: 'Missing title' })); return; }
    try {
      const result = await resolveWikiTitle(title);
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── API: random article ──
  if (pathname === '/api/random') {
    try {
      const title = await getRandomArticle();
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({ title }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Wikipedia proxy with robust error handling ──
  if (pathname.startsWith('/wiki-proxy/')) {
    const wikiPath = pathname.replace('/wiki-proxy', '');
    const qs = parsed.search || '';

    const options = {
      hostname: 'fr.wikipedia.org',
      path: wikiPath + qs,
      method: 'GET',
      headers: {
        'User-Agent': 'WikiRaceGame/2.0 (educational game)',
        'Accept': req.headers['accept'] || '*/*',
        'Accept-Encoding': 'identity',
        'Accept-Language': 'fr',
      }
    };

    try {
      const wikiRes = await wikiRequest(options);
      let ct = wikiRes.headers['content-type'] || '';

      // If we got a 404 from Wikipedia, try to resolve via API
      if (wikiRes.statusCode === 404 && wikiPath.startsWith('/wiki/')) {
        const rawTitle = decodeURIComponent(wikiPath.replace('/wiki/', ''));
        try {
          const resolved = await resolveWikiTitle(rawTitle);
          if (resolved.found) {
            // Redirect to the correct page
            const correctPath = '/wiki-proxy/wiki/' + encodeURIComponent(resolved.title.replace(/ /g, '_'));
            res.writeHead(302, { 'Location': correctPath });
            res.end();
            return;
          }
        } catch (_) { /* fallthrough to 404 page */ }

        // Return a styled error page instead of raw 404
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.writeHead(200);
        res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>
          body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:80vh;background:#fafafa;color:#333}
          .box{text-align:center;padding:2rem}
          h2{color:#c33;margin-bottom:1rem}
          .retry-btn{margin-top:1rem;padding:10px 24px;background:#0645ad;color:#fff;border:none;border-radius:6px;font-size:15px;cursor:pointer}
          .retry-btn:hover{background:#0b3d91}
        </style></head><body><div class="box">
          <h2>Page introuvable</h2>
          <p>L'article « <b>${rawTitle.replace(/_/g, ' ')}</b> » n'existe pas sur Wikipédia.</p>
          <p style="color:#888;font-size:14px">Utilisez le bouton retour de votre navigateur ou cliquez un autre lien.</p>
          <button class="retry-btn" onclick="window.parent.postMessage({type:'wiki_retry'},'*')">↩ Revenir en arrière</button>
        </div></body></html>`);
        return;
      }

      res.setHeader('Cache-Control', 'public, max-age=300');

      if (ct.includes('text/html')) {
        let body = '';
        wikiRes.setEncoding('utf8');
        wikiRes.on('data', c => body += c);
        wikiRes.on('end', () => {
          // Rewrite links
          body = body
            .replace(/href="\/wiki\//g, 'href="/wiki-proxy/wiki/')
            .replace(/href="\/w\//g, 'href="/wiki-proxy/w/')
            .replace(/src="\/\/upload\.wikimedia\.org/g, 'src="https://upload.wikimedia.org')
            .replace(/src="\/static\//g, 'src="https://fr.wikipedia.org/static/')
            .replace(/href="\/static\//g, 'href="https://fr.wikipedia.org/static/')
            .replace(/<link[^>]+rel="canonical"[^>]*>/gi, '');

          // Inject game script
          const injectedScript = `
<script>
(function(){
  // Get the real page title from the heading
  function getTitle(){
    var h = document.querySelector('#firstHeading .mw-page-title-main')
         || document.querySelector('#firstHeading');
    if(h) return h.textContent.trim();
    // fallback: extract from <title>
    return document.title.replace(/\\s*[-—].*$/,'').trim();
  }

  // Intercept all link clicks
  document.addEventListener('click', function(e){
    var a = e.target.closest('a');
    if(!a) return;
    var href = a.getAttribute('href');
    if(!href) return;

    // Internal wiki article links only (skip Special:, File:, etc.)
    if(href.startsWith('/wiki-proxy/wiki/')) {
      var afterWiki = href.replace('/wiki-proxy/wiki/', '');
      // Block namespace links (contain colon before any slash)
      var decoded = decodeURIComponent(afterWiki.split('#')[0]);
      if(decoded.includes(':')) {
        e.preventDefault();
        return;
      }
      // Block anchor-only
      if(afterWiki.startsWith('#')) {
        return; // allow in-page anchors
      }
      e.preventDefault();
      var rawTitle = decoded.replace(/_/g, ' ');
      window.parent.postMessage({type:'wiki_navigate', title:rawTitle, href:href}, '*');
    }
    // Block external links
    else if(!href.startsWith('#') && !href.startsWith('javascript')) {
      e.preventDefault();
    }
  });

  // Report loaded title to parent
  window.parent.postMessage({type:'wiki_loaded', title:getTitle()}, '*');
})();
<\/script>`;

          body = body.replace('</body>', injectedScript + '</body>');

          res.setHeader('Content-Type', ct);
          res.writeHead(200);
          res.end(body);
        });
      } else {
        res.setHeader('Content-Type', ct);
        res.writeHead(wikiRes.statusCode);
        wikiRes.pipe(res);
      }
    } catch (e) {
      // Network error — return a retry page
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.writeHead(200);
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>
        body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:80vh;background:#fafafa;color:#333}
        .box{text-align:center;padding:2rem}
        .retry-btn{margin-top:1rem;padding:10px 24px;background:#0645ad;color:#fff;border:none;border-radius:6px;font-size:15px;cursor:pointer}
      </style></head><body><div class="box">
        <h2>Erreur de chargement</h2>
        <p>Impossible de charger la page. Vérifiez votre connexion.</p>
        <button class="retry-btn" onclick="location.reload()">Réessayer</button>
        <button class="retry-btn" style="background:#666" onclick="window.parent.postMessage({type:'wiki_retry'},'*')">↩ Revenir en arrière</button>
      </div></body></html>`);
    }
    return;
  }

  // ── Serve static files ──
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

// Periodic cleanup of empty lobbies
setInterval(() => {
  lobbies.forEach((lobby, code) => {
    if (lobby.players.size === 0) lobbies.delete(code);
  });
}, 60000);

wss.on('connection', (ws) => {
  let myPid = null;
  let myCode = null;

  // Heartbeat
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

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
        lobby.players.set(myPid, {
          pid: myPid, name: msg.name, colorIdx: 0, ws,
          path: [], clicks: 0, finished: false, finishTime: 0
        });
        lobbies.set(code, lobby);
        ws.send(JSON.stringify({ type: 'lobby_created', code, lobby: lobbyToJSON(lobby) }));
        break;
      }

      case 'join_lobby': {
        const code = (msg.code || '').toUpperCase();
        const lobby = lobbies.get(code);
        if (!lobby) {
          ws.send(JSON.stringify({ type: 'error', msg: 'Lobby introuvable. Vérifiez le code.' }));
          return;
        }
        if (lobby.phase === 'playing') {
          ws.send(JSON.stringify({ type: 'error', msg: 'Partie déjà en cours, attendez la fin.' }));
          return;
        }
        if (lobby.players.size >= 8) {
          ws.send(JSON.stringify({ type: 'error', msg: 'Lobby plein (8 joueurs max).' }));
          return;
        }
        myPid = msg.pid;
        myCode = code;
        const colorIdx = lobby.players.size;
        lobby.players.set(myPid, {
          pid: myPid, name: msg.name, colorIdx, ws,
          path: [], clicks: 0, finished: false, finishTime: 0
        });
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
        lobby.startTime = Date.now() + 4000;
        lobby.players.forEach(p => {
          p.path = []; p.clicks = 0; p.finished = false; p.finishTime = 0;
        });
        broadcastAll(lobby, {
          type: 'game_start', start: msg.start, end: msg.end,
          startTitle: msg.startTitle || msg.start,
          endTitle: msg.endTitle || msg.end,
          serverStart: lobby.startTime
        });
        break;
      }

      case 'player_update': {
        const lobby = lobbies.get(myCode);
        if (!lobby) return;
        const player = lobby.players.get(myPid);
        if (!player) return;
        player.path = msg.path || [];
        player.clicks = msg.clicks || 0;
        player.finished = !!msg.finished;
        player.finishTime = msg.finishTime || 0;
        broadcast(lobby, {
          type: 'player_update', pid: myPid,
          path: player.path, clicks: player.clicks,
          finished: player.finished, finishTime: player.finishTime
        }, myPid);

        // FIRST player to finish → end the game for everyone
        if (player.finished && lobby.phase === 'playing') {
          lobby.phase = 'results';
          const all = [...lobby.players.values()];
          const results = all.map(p => ({
            pid: p.pid, name: p.name, colorIdx: p.colorIdx,
            path: [...p.path], clicks: p.clicks,
            finished: p.finished, finishTime: p.finishTime
          }));
          results.sort((a, b) => {
            if (a.finished && !b.finished) return -1;
            if (!a.finished && b.finished) return 1;
            return a.finishTime - b.finishTime;
          });
          // Small delay so the winner sees the finish overlay briefly
          setTimeout(() => broadcastAll(lobby, { type: 'game_end', results, winnerPid: myPid }), 2000);
        }
        break;
      }

      case 'force_end': {
        const lobby = lobbies.get(myCode);
        if (!lobby || lobby.host !== myPid) return;
        lobby.phase = 'results';
        const all = [...lobby.players.values()];
        const results = all.map(p => ({
          pid: p.pid, name: p.name, colorIdx: p.colorIdx,
          path: [...p.path], clicks: p.clicks,
          finished: p.finished, finishTime: p.finishTime
        }));
        results.sort((a, b) => {
          if (a.finished && !b.finished) return -1;
          if (!a.finished && b.finished) return 1;
          return a.finishTime - b.finishTime;
        });
        broadcastAll(lobby, { type: 'game_end', results });
        break;
      }

      case 'back_to_lobby': {
        const lobby = lobbies.get(myCode);
        if (!lobby || lobby.host !== myPid) return;
        lobby.phase = 'lobby';
        lobby.players.forEach(p => {
          p.path = []; p.clicks = 0; p.finished = false; p.finishTime = 0;
        });
        broadcastAll(lobby, { type: 'back_to_lobby', lobby: lobbyToJSON(lobby) });
        break;
      }

      case 'ping': {
        ws.send(JSON.stringify({ type: 'pong' }));
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

// Heartbeat interval
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`\n  ┌──────────────────────────────────────┐`);
  console.log(`  │   WikiRace Server v2.0                │`);
  console.log(`  │   Running on http://localhost:${PORT}    │`);
  console.log(`  └──────────────────────────────────────┘\n`);
});
