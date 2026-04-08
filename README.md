# WikiRace Online — Multijoueur

Jeu WikiRace multijoueur en temps réel avec lobby, proxy Wikipedia et suivi de chemin.

## Stack technique
- **Backend** : Node.js pur (zéro framework), WebSocket natif (`ws`)
- **Frontend** : HTML/CSS/JS vanilla, une seule page
- **Proxy** : Wikipedia français proxifié côté serveur (résout les problèmes CORS)
- **Sync** : WebSocket bidirectionnel full-duplex

---

## Déploiement gratuit sur Render.com (recommandé)

### 1. Préparer le repo GitHub
```bash
git init
git add .
git commit -m "Initial WikiRace"
# Pousse sur GitHub
```

### 2. Déployer sur Render
1. Va sur [render.com](https://render.com) → "New Web Service"
2. Connecte ton repo GitHub
3. Configure :
   - **Environment** : `Node`
   - **Build command** : `npm install`
   - **Start command** : `node server.js`
   - **Plan** : Free
4. Clique "Create Web Service"
5. Ton jeu sera dispo sur `https://ton-app.onrender.com`

---

## Déploiement sur Railway.app

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

---

## Lancer en local

```bash
npm install
node server.js
# Ouvre http://localhost:3000
# Partage ton IP locale (192.168.x.x:3000) avec tes amis sur le même réseau
```

---

## Architecture

```
┌─────────────────────────────────────────────┐
│                  server.js                   │
│                                              │
│  HTTP /               → public/index.html   │
│  HTTP /wiki-proxy/*   → proxy Wikipedia FR  │
│  WS   /               → lobby + game sync   │
└─────────────────────────────────────────────┘
```

## Messages WebSocket

| Type | Direction | Description |
|------|-----------|-------------|
| `create_lobby` | C→S | Crée un nouveau lobby |
| `join_lobby` | C→S | Rejoint un lobby existant |
| `start_game` | C→S (hôte) | Lance la partie |
| `player_update` | C→S | Envoie progression du joueur |
| `force_end` | C→S (hôte) | Force la fin |
| `back_to_lobby` | C→S (hôte) | Retour au lobby |
| `lobby_created/joined` | S→C | Confirmation + état |
| `game_start` | S→C | Démarre le compte à rebours |
| `game_end` | S→C | Envoie les résultats finaux |

## Fonctionnalités
- Lobby avec code 6 caractères
- Lien de partage automatique (`?code=XXXXXX`)
- Proxy Wikipedia FR (navigation sans CORS)
- Détection automatique de la page d'arrivée
- Suivi du chemin en temps réel pour tous les joueurs
- Timer et compteur de clics
- Classement final avec chemins complets
- L'hôte peut forcer la fin et relancer une partie
