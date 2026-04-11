# WikiRace v2.0 — Multijoueur Online

Course Wikipedia multijoueur en temps réel. Navigue de page en page plus vite que tes amis !

## Fonctionnalités

- **Lobby en ligne** : Crée ou rejoins un lobby avec un code à 5 caractères
- **Multijoueur temps réel** : Vois la progression de tous les joueurs en direct
- **Chemin tracé** : Ton parcours complet est affiché et enregistré
- **Détection automatique** : La page d'arrivée est détectée automatiquement
- **Gestion des erreurs** : Retry automatique si une page ne charge pas
- **Résolution des titres** : Les articles sont vérifiés et normalisés avant le lancement
- **Reconnexion auto** : Si la connexion est perdue, le client se reconnecte
- **Classement final** : Résultats avec temps, nombre de clics et chemin complet

## Installation & Lancement

```bash
# 1. Installer les dépendances
npm install

# 2. Lancer le serveur
npm start
```

Le serveur démarre sur `http://localhost:3000` par défaut.

Pour changer le port :
```bash
PORT=8080 npm start
```

## Déploiement en ligne

### Option 1 : Render.com (gratuit)
1. Push le projet sur GitHub
2. Créer un "Web Service" sur render.com
3. Build command: `npm install`
4. Start command: `npm start`
5. Le WebSocket fonctionne automatiquement en `wss://`

### Option 2 : Railway.app
1. Connecter le repo GitHub
2. Railway détecte automatiquement Node.js
3. Déployé en quelques secondes

### Option 3 : VPS (DigitalOcean, OVH, etc.)
```bash
git clone <repo>
cd wikirace-online
npm install
PORT=3000 node server.js
```

Configurer un reverse proxy Nginx avec WebSocket :
```nginx
server {
    listen 80;
    server_name wikirace.exemple.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## Architecture

```
wikirace-online/
├── server.js          # Serveur Node.js (HTTP + WebSocket + Wiki proxy)
├── public/
│   └── index.html     # Client complet (HTML/CSS/JS)
├── package.json
└── README.md
```

- **WebSocket** : Gestion des lobbies, synchronisation temps réel
- **Wiki Proxy** : Proxy serveur vers fr.wikipedia.org avec réécriture des liens
- **API /api/resolve** : Vérifie et normalise les titres d'articles Wikipedia
- **API /api/random** : Renvoie un article aléatoire

## Corrections v2.0

- ✅ Gestion des redirections Wikipedia (301/302)
- ✅ Retry automatique si une page ne charge pas (max 3 tentatives)
- ✅ Validation des articles avant le lancement de la partie
- ✅ Page d'erreur stylée avec bouton retour au lieu d'un 404 brut
- ✅ Protection contre les double-clics rapides
- ✅ Reconnexion WebSocket automatique
- ✅ Keepalive pour éviter les déconnexions idle
- ✅ Bouton "Aléatoire" côté serveur (plus fiable)
