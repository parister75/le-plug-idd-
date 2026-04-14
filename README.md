# 🤖 monshopbot (V5)

Un bot Telegram robuste conçu avec **Node.js (Telegraf)** et **Supabase**, incluant une **interface web d'administration premium**.

## ✨ Fonctionnalités

### 👤 Utilisateur (Bot)
- **Inscription automatique** : Sauvegarde de l'ID, username, prénom et date d'inscription.
- **Système de parrainage** : Lien unique par utilisateur, compteur de filleuls et classement.
- **Menu interactif** : Accès rapide au contact privé, au canal Telegram et au message d'accueil.
- **Fidélité & Portefeuille** : Système de points de fidélité et solde de portefeuille pour les commandes.
- **Suivi de commande** : Notifications en temps réel lors du changement d'état d'une commande.

### 🛠 Administration (Bot & Web)
- **monshopbot** : Statistiques en temps réel, graphiques d'inscription (Chart.js), gestion des utilisateurs et des commandes.
- **Système de Broadcast** : 
  - Envoi à TOUS les utilisateurs (y compris ceux ayant supprimé le bot, avec détection automatique).
  - Statistiques précises : Succès, Échecs, Nouveaux Bloqués, Déjà Bloqués.
  - Gestion des **Rate Limits** de Telegram.
- **Gestion des Produits** : Ajout, modification et suppression de produits via l'interface web.
- **Commandes Admin (Telegram)** : Accès rapide aux fonctions de gestion via le bot.

---

## 🚀 Installation & Configuration

### 1. Prérequis
- [Node.js v18+](https://nodejs.org/)
- Un compte [Supabase](https://supabase.com/) (Gratuit)
- Un token de bot via [@BotFather](https://t.me/BotFather)

### 2. Configuration Supabase
1. Créez un projet sur Supabase.
2. Configurez les tables nécessaires (`users`, `orders`, `products`, `settings`, etc.).
3. Récupérez votre **URL de projet** et votre **Clé API anon**.

### 3. Variables d'environnement
Créez un fichier `.env` à la racine :
```env
BOT_TOKEN=123456789:ABCDEF...
ADMIN_PASSWORD=votre_mot_de_passe_admin
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-anon-key
PORT=3000
```

### 4. Lancement
```bash
# Installer les dépendances
npm install

# Lancer en mode développement
npm run dev

# Lancer en production
npm start
```

---

## 🌐 Déploiement

### Railway / Render
Ce projet est prêt pour le déploiement sur Railway ou Render :
1. Connectez votre dépôt GitHub.
2. Ajoutez les variables d'environnement dans les paramètres du service.

---

## 🛠 Maintenance & Sécurité
- **Doublons** : Gérés par l'utilisation de l'ID Telegram comme identifiant unique.
- **Rate Limits** : Le service de broadcast utilise un système de batching intelligent pour respecter les limites de l'API Telegram.
- **Sécurité** : Accès à l'interface administrative protégé par mot de passe admin.

---

## 📈 Onboarding Admin
1. **Démarrer le bot** : Envoyez `/start` à votre bot.
2. **Accéder au Web** : Ouvrez votre URL de déploiement (ou localhost).
3. **Paramétrage** : Rendez-vous dans l'onglet "Settings" pour configurer les messages d'accueil et les seuils de fidélité.
