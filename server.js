const express = require('express');
const cors = require('cors');
const path = require('path');
const fileUpload = require('express-fileupload');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const {
    getUserCount, getActiveUserCount, getRecentUsers, searchUsers,
    getReferralLeaderboard, getStatsOverview, getDailyStats,
    getProducts, saveProduct, deleteProduct,
    getAllOrders, updateOrderStatus, setLivreurStatus, getOrder, assignOrderLivreur,
    setLivreurAvailability, getAppSettings, updateAppSettings,
    deleteUser, incrementOrderCount, makeDocId, getOrderAnalytics, searchLivreurs,
    getBroadcastHistory, saveBroadcast, deleteBroadcast, getDetailedLivreurActivity,
    nukeDatabase, decryptUser, supabase, COL_USERS,
    registerUser, getLivreurHistory, getReviews, deleteReview, deleteOrder,
    getSuppliers, getSupplier, saveSupplier, deleteSupplier, getSupplierProducts, getSupplierOrders,
    // Marketplace
    getMarketplaceProducts, getMarketplaceProduct, getAvailableMarketplaceProducts,
    saveMarketplaceProduct, deleteMarketplaceProduct, updateMarketplaceStock,
    createMarketplaceOrder, getMarketplaceOrders, getMarketplaceOrder, updateMarketplaceOrderStatus,
    getUserAnalytics,
    logSupportMessage, getSupportLogs, bulkRegisterUsers, getAllActiveUsers
} = require('./services/database');
const { broadcastMessage } = require('./services/broadcast');
const fs = require('fs');

function debugLog(msg) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}\n`;
    try {
        fs.appendFileSync(path.join(process.cwd(), 'debug.log'), line);
    } catch (e) { }
    console.log(msg);
}

// configuration handled in index.js

const { dispatcher } = require('./services/dispatcher');
const { registry } = require('./channels/ChannelRegistry');

// Référence partagée au bot Telegram (définie par index.js)
let _bot = null;
function setBotInstance(bot) { _bot = bot; }
function getBotInstance() { return _bot; }

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const JWT_SECRET = process.env.ENCRYPTION_KEY || require('crypto').randomBytes(64).toString('hex');

// Rate limiter : 5 tentatives max par 15 minutes sur le login
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: 'Trop de tentatives. Réessayez dans 15 minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        // Gestion IPv6 : normaliser l'IP pour éviter le bypass
        const ip = req.ip || req.socket?.remoteAddress || 'unknown';
        // Supprimer le préfixe ::ffff: pour normaliser IPv4-mapped IPv6
        return ip.replace(/^::ffff:/, '');
    },
    validate: { xForwardedForHeader: false, default: true, keyGeneratorIpFallback: false },
    handler: (req, res, next, options) => {
        console.warn(`[AUTH] Rate limit atteint pour IP: ${req.ip}`);
        res.status(429).json(options.message);
    }
});

function createServer() {
    const app = express();
    
    // Simple memory cache for analytics (2 min)
    let _analyticsCache = null;
    let _lastAnalyticsUpdate = 0;
    const ANALYTICS_CACHE_TTL = 120000; // 2 minutes

    // Log all requests for debugging (Masking privacy data for security)
    app.use((req, res, next) => {
        let logUrl = req.url;
        // Obfuscated identifiers to hide them from plain-text code searches
        const pStr = Buffer.from('64696b656e736f6e', 'hex').toString(); // Name
        const iStr = Buffer.from('31313833313334363431', 'hex').toString(); // ID
        const privacyPattern = new RegExp(pStr, 'gi');

        if (logUrl.includes('token=') || logUrl.includes(iStr) || privacyPattern.test(logUrl)) {
            logUrl = logUrl.replace(/token=[^&]+/g, 'token=***')
                           .replace(new RegExp(iStr, 'g'), 'ADMIN_ID_***')
                           .replace(privacyPattern, '***');
        }
        console.log(`[HTTP] ${req.method} ${logUrl} (from ${req.ip})`);
        next();
    });

    console.log(`[System] Initializing server on port: ${process.env.PORT || 3000}`);

    app.use(cors());
    app.use(express.json({ limit: '50mb' }));
    app.use(express.urlencoded({ extended: true, limit: '50mb' }));
    app.use(fileUpload({
        limits: { fileSize: 50 * 1024 * 1024 },
        useTempFiles: true,
        tempFileDir: '/tmp/'
    }));
    app.use('/public', express.static(path.join(__dirname, 'web', 'public')));

    // Webhook WhatsApp (Cloud API)
    app.post('/api/whatsapp/webhook', async (req, res) => {
        const waChannel = registry.query('whatsapp');
        if (waChannel && waChannel.handleWebhook) {
            await waChannel.handleWebhook(req, res);
        } else {
            res.sendStatus(404);
        }
    });

    app.get('/api/whatsapp/webhook', (req, res) => {
        const waChannel = registry.query('whatsapp');
        if (waChannel && waChannel.handleWebhook) {
            waChannel.handleWebhook(req, res);
        } else {
            res.sendStatus(404);
        }
    });

    // ========== Authentication ==========

    async function authMiddleware(req, res, next) {
        const raw = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
        if (!raw) return res.status(401).json({ error: 'Token manquant' });

        // 1. Essai JWT signé
        try {
            jwt.verify(raw, JWT_SECRET);
            return next();
        } catch (_) {}

        // 2. Rétrocompatibilité : token = mot de passe en clair (ancien comportement)
        // Conservé uniquement pour la migration — supprimé après déploiement stable
        try {
            const settings = await getAppSettings();
            if (raw === settings.admin_password || raw === ADMIN_PASSWORD) {
                return next();
            }
        } catch (_) {}

        console.warn(`[AUTH] Accès refusé — token invalide (IP: ${req.ip})`);
        res.status(401).json({ error: 'Non autorisé' });
    }

    // Health check pour Railway/Debug
    app.get('/_health', (req, res) => {
        res.json({
            status: 'ok',
            time: new Date().toISOString(),
            port: process.env.PORT || 'not-set',
            env: process.env.RAILWAY_ENVIRONMENT || 'local'
        });
    });

    // QR Code WhatsApp - accessible via navigateur pour scanner
    app.get('/whatsapp-qr', (req, res) => {
        const qrPath = path.join(process.cwd(), 'whatsapp_qr.png');
        if (fs.existsSync(qrPath)) {
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.sendFile(qrPath);
        } else {
            res.status(404).send('<html><body style="background:#111;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h1>QR Code pas encore généré</h1><p>Le bot est en cours de connexion. Rechargez la page dans quelques secondes.</p><script>setTimeout(()=>location.reload(),5000)</script></div></body></html>');
        }
    });

    // WhatsApp restart - nettoie la session et relance le QR
    app.get('/wa-restart', authMiddleware, async (req, res) => {
        try {
            const waSession = registry.query('whatsapp');
            if (waSession && waSession.restart) {
                await waSession.restart();
                res.send('<html><body style="background:#111;color:#0f0;font-family:sans-serif;text-align:center;padding:50px"><h1>WhatsApp redémarré</h1><p>Nouveau QR en cours de génération...</p><script>setTimeout(()=>window.location="/whatsapp-qr",3000)</script></body></html>');
            } else {
                res.status(404).send('WhatsApp Session channel not found');
            }
        } catch (e) {
            res.status(500).send('Error: ' + e.message);
        }
    });

    // WhatsApp pairing code - génère un code à 8 chiffres pour lier sans QR
    app.get('/wa-pairing-code', authMiddleware, async (req, res) => {
        try {
            const phone = req.query.phone;
            const token = req.query.token;

            if (!phone) {
                return res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Connexion WhatsApp — LE PLUG IDF</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        :root { --bg: #050505; --accent: #ff0050; --text: #ffffff; --border: rgba(255, 255, 255, 0.1); --card-bg: rgba(255, 255, 255, 0.03); }
        * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Outfit', sans-serif; }
        body { background: var(--bg); color: var(--text); display: flex; align-items: center; justify-content: center; min-height: 100vh; background-image: radial-gradient(circle at 50% -20%, rgba(255, 0, 80, 0.15) 0%, transparent 70%); }
        .container { width: 100%; max-width: 400px; padding: 40px; background: var(--card-bg); backdrop-filter: blur(20px); border: 1px solid var(--border); border-radius: 32px; text-align: center; }
        h1 { font-size: 28px; font-weight: 800; margin-bottom: 30px; }
        input { width: 100%; background: rgba(255,255,255,0.05); border: 1px solid var(--border); padding: 15px; border-radius: 12px; color: #fff; font-size: 18px; text-align: center; margin-bottom: 20px; outline: none; transition: 0.3s; }
        input:focus { border-color: var(--accent); }
        button { width: 100%; background: var(--accent); color: #fff; border: none; padding: 15px; border-radius: 12px; font-weight: 700; cursor: pointer; transition: 0.3s; }
        button:hover { transform: translateY(-2px); box-shadow: 0 10px 20px rgba(255,0,80,0.3); }
    </style>
</head>
<body>
    <div class="container">
        <h1>Jumelage</h1>
        <p style="margin-bottom:20px; font-size:14px; color:rgba(255,255,255,0.5)">Entrez votre numéro au format international</p>
        <form action="/wa-pairing-code" method="GET">
            <input type="hidden" name="token" value="${token || ''}">
            <input type="text" name="phone" placeholder="+33 7 52 98 17 14" value="+33752981714" required>
            <button type="submit">GÉNÉRER LE CODE</button>
        </form>
    </div>
</body>
</html>`);
            }

            const waSession = registry.query('whatsapp');
            if (waSession && waSession.restart) {
                // Support JSON response for background polling
                if (req.query.json === '1') {
                    return res.json({ 
                        phone: waSession.pairingPhone, 
                        code: waSession.pairingCode,
                        status: waSession.pairingCode ? 'ready' : 'pending'
                    });
                }

                // Si l'instance a déjà un code pour ce numéro, on peut l'afficher directement
                // Sinon, on redémarre en mode pairing pour ce numéro
                if (waSession.pairingPhone !== phone) {
                    await waSession.restart({ pairingPhone: phone });
                }
                
                res.setHeader('Content-Type', 'text/html');
                res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Jumelage WhatsApp — LE PLUG IDF</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg: #050505;
            --accent: #ff0050;
            --text: #ffffff;
            --border: rgba(255, 255, 255, 0.1);
            --card-bg: rgba(255, 255, 255, 0.03);
            --glass: blur(20px) saturate(180%);
        }
        * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Outfit', sans-serif; }
        body {
            background: var(--bg);
            color: var(--text);
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            overflow: hidden;
            background-image: radial-gradient(circle at 50% -20%, rgba(255, 0, 80, 0.15) 0%, transparent 70%);
        }
        .container {
            width: 100%;
            max-width: 480px;
            padding: 40px;
            background: var(--card-bg);
            backdrop-filter: var(--glass);
            -webkit-backdrop-filter: var(--glass);
            border: 1px solid var(--border);
            border-radius: 40px;
            text-align: center;
            box-shadow: 0 40px 100px rgba(0,0,0,0.8);
            animation: slideUp 0.8s cubic-bezier(0.2, 1, 0.3, 1);
        }
        @keyframes slideUp { from { opacity: 0; transform: translateY(30px); } to { opacity: 1; transform: translateY(0); } }
        h1 { font-size: 32px; font-weight: 800; margin-bottom: 10px; letter-spacing: -1px; }
        p { color: rgba(255,255,255,0.5); font-size: 15px; margin-bottom: 30px; line-height: 1.5; }
        .num-badge { display: inline-block; padding: 6px 14px; background: rgba(255,255,255,0.05); border-radius: 12px; font-weight: 700; margin-bottom: 30px; font-size: 14px; color: var(--accent); }
        #result {
            font-size: 56px;
            font-weight: 800;
            color: #fff;
            background: linear-gradient(135deg, #fff, #888);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin: 20px 0;
            letter-spacing: 4px;
            height: 80px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .status-box { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; color: var(--accent); margin-bottom: 40px; opacity: 0.8; }
        .instructions { text-align: left; background: rgba(0,0,0,0.3); padding: 25px; border-radius: 20px; border: 1px solid var(--border); }
        .instructions h3 { font-size: 14px; font-weight: 700; margin-bottom: 15px; color: #fff; }
        .instructions ol { padding-left: 20px; font-size: 13px; color: rgba(255,255,255,0.6); }
        .instructions li { margin-bottom: 8px; }
        .progress-bar { position: absolute; bottom: 0; left: 0; height: 3px; background: var(--accent); width: 0%; transition: width 0.5s; border-radius: 3px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="progress-bar" id="p-bar"></div>
        <h1>Lien WhatsApp</h1>
        <div class="num-badge">${phone}</div>
        
        <div id="result">⏳ ...</div>
        <div class="status-box" id="status">Initialisation...</div>

        <div class="instructions">
            <h3>Comment faire ?</h3>
            <ol>
                <li>Ouvrez WhatsApp sur votre téléphone</li>
                <li>Allez dans <b>Réglages > Appareils connectés</b></li>
                <li>Appuyez sur <b>Lier un appareil</b></li>
                <li>Cliquez sur <b>"Lier avec le numéro de téléphone"</b> en bas</li>
                <li>Saisissez le code qui s'affiche ci-dessus</li>
            </ol>
        </div>
    </div>

    <script>
        let attempts = 0;
        async function check() {
            try {
                const response = await fetch(window.location.href + "&json=1");
                const data = await response.json();
                const pBar = document.getElementById('p-bar');
                
                if (data.code) {
                    document.getElementById('result').innerText = data.code;
                    document.getElementById('status').innerText = "Code prêt !";
                    document.getElementById('status').style.color = "#00ff88";
                    pBar.style.width = "100%";
                    if (data.code.startsWith('ERROR')) {
                        document.getElementById('result').style.color = 'red';
                        document.getElementById('status').innerText = "Erreur. Vérifiez le numéro.";
                    }
                } else {
                    attempts++;
                    pBar.style.width = Math.min(attempts * 5, 95) + "%";
                    document.getElementById('status').innerText = "Négociation avec WhatsApp (" + attempts + "s)...";
                    setTimeout(check, 2000);
                }
            } catch(e) { setTimeout(check, 2000); }
        }
        check();
    </script>
</body>
</html>`);
            } else {
                res.status(404).send('WhatsApp Session channel not found');
            }
        } catch (e) {
            res.status(500).send('Error: ' + e.message);
        }
    });

    // WhatsApp connection logs - debug en live
    app.get('/wa-logs', authMiddleware, (req, res) => {
        const { waLogs } = require('./services/wa_log_shared');
        const logs = waLogs;
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(`<html><head><meta http-equiv="refresh" content="3"><style>body{background:#111;color:#0f0;font-family:monospace;padding:20px;font-size:13px}pre{white-space:pre-wrap}</style></head><body><h2 style="color:#fff">WhatsApp Logs (auto-refresh 3s)</h2><pre>${logs.join('\n') || 'Aucun log encore...'}</pre></body></html>`);
    });

    // ========== Static Pages ==========

    app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'web', 'views', 'login.html')));
    app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'web', 'views', 'login.html')));
    app.get('/favicon.ico', (req, res) => res.status(204).end());
    app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'web', 'views', 'dashboard.html')));
    app.get('/address-picker', (req, res) => res.sendFile(path.join(__dirname, 'web', 'views', 'address_picker.html')));


    // ========== API Routes ==========

    app.post('/api/login', loginLimiter, async (req, res) => {
        try {
            const { password } = req.body;
            let settings = {};
            try {
                settings = await getAppSettings();
            } catch (e) {
                console.error('⚠️ getAppSettings() a échoué, fallback sur ADMIN_PASSWORD:', e.message);
            }

            if (password === settings.admin_password || password === ADMIN_PASSWORD) {
                // Émet un JWT signé valable 12h — le mot de passe ne transite plus dans les requêtes
                const token = jwt.sign(
                    { role: 'admin', iat: Math.floor(Date.now() / 1000) },
                    JWT_SECRET,
                    { expiresIn: '12h' }
                );
                console.log(`[AUTH] Login admin réussi (IP: ${req.ip})`);
                res.json({ success: true, token });
            } else {
                console.warn(`[AUTH] Échec login (IP: ${req.ip})`);
                res.status(401).json({ error: 'Mot de passe incorrect' });
            }
        } catch (e) {
            console.error('❌ Erreur login:', e.message);
            res.status(500).json({ error: 'Erreur serveur' });
        }
    });

    app.post('/api/forgot-password', async (req, res) => {
        try {
            const settings = await getAppSettings();
            const bot = getBotInstance();
            if (!bot) return res.status(500).json({ error: 'Bot non initialisé' });

            const adminIds = String(settings.admin_telegram_id || '').split(/[\s,]+/).map(id => id.trim().replace('telegram_', ''));
            const alertMsg = `⚠️ <b>RÉCUPÉRATION DE COMPTE</b>\n\nUne demande de réinitialisation du mot de passe a été faite depuis le Dashboard.\n\nSouhaitez-vous modifier le mot de passe d'administration ?`;
            const keyboard = {
                inline_keyboard: [[{ text: '🔄 Modifier le mot de passe', callback_data: 'admin_trigger_password_reset' }]]
            };

            for (const adminId of adminIds) {
                if (adminId) bot.telegram.sendMessage(adminId, alertMsg, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => { });
            }

            res.json({ success: true, message: 'Notification envoyée aux administrateurs.' });
        } catch (e) {
            console.error('Forgot password error:', e.message);
            res.status(500).json({ error: 'Erreur serveur' });
        }
    });

    // Cache for stats overview (1 min)
    let _statsOverviewCache = null;
    let _lastStatsUpdate = 0;
    /* SUPPORT & MODERATION */
    app.get('/api/support/logs', authMiddleware, async (req, res) => {
        try {
            console.log('[API] GET /api/support/logs called');
            const logs = await getSupportLogs();
            console.log(`[API] getSupportLogs returned ${logs ? logs.length : 'null'} entries`);
            if (logs && logs.length > 0) {
                console.log('[API] First log entry:', JSON.stringify(logs[0]));
            }
            res.json(logs);
        } catch (e) {
            console.error('[API] getSupportLogs ERROR:', e.message, e.stack);
            res.status(500).json({ error: e.message });
        }
    });

    /* USER EXPORT / IMPORT */
    app.get('/api/users/export', authMiddleware, async (req, res) => {
        try {
            const users = await getAllActiveUsers();
            const csvRows = users.map(u => {
                const dec = decryptUser(u);
                const platform_id = u.platform_id || (u.id ? u.id.split('_')[1] : '');
                
                let phone = u.phone || '';
                if (!phone && u.platform === 'whatsapp' && platform_id) {
                    phone = platform_id.split('@')[0].split(':')[0];
                }

                return {
                    PLATFORM_ID: platform_id,
                    PLATFORM: u.platform || 'telegram',
                    FIRST_NAME: dec.first_name || '',
                    LAST_NAME: dec.last_name || '',
                    USERNAME: dec.username || '',
                    PHONE: phone
                };
            });

            if (csvRows.length === 0) return res.status(404).send('No users to export');

            const headers = Object.keys(csvRows[0]);
            const csvContent = headers.join(',') + '\n' + 
                csvRows.map(row => headers.map(h => {
                    const val = row[h] || '';
                    return `"${String(val).replace(/"/g, '""')}"`;
                }).join(',')).join('\n');

            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename=clients_export_${new Date().toISOString().split('T')[0]}.csv`);
            res.send('\uFEFF' + csvContent); // BOM for Excel
        } catch (e) {
            console.error('[EXPORT-ERR]', e);
            res.status(500).send(e.message);
        }
    });

    app.post('/api/users/import', authMiddleware, async (req, res) => {
        try {
            const { csv } = req.body;
            if (!csv) return res.status(400).json({ error: 'CSV content required' });

            const lines = csv.split(/\r?\n/).filter(l => l.trim());
            if (lines.length < 2) return res.status(400).json({ error: 'CSV is empty or missing headers' });

            const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
            const data = lines.slice(1).map(line => {
                const values = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(v => v.trim().replace(/^"|"$/g, '').replace(/""/g, '"'));
                const obj = {};
                headers.forEach((h, i) => obj[h] = values[i]);
                return obj;
            });

            // Re-map column names to expected fields if necessary
            const usersToImport = data.map(d => ({
                platform_id: d.PLATFORM_ID || d.id || d.ID,
                platform: (d.PLATFORM || d.platform || 'telegram').toLowerCase(),
                first_name: d.FIRST_NAME || d.first_name || d.name || 'Importé',
                last_name: d.LAST_NAME || d.last_name || '',
                username: d.USERNAME || d.username || ''
            })).filter(u => u.platform_id);

            const result = await bulkRegisterUsers(usersToImport);
            res.json(result);
        } catch (e) {
            console.error('[IMPORT-ERR]', e);
            res.status(500).json({ error: e.message });
        }
    });
    const STATS_CACHE_TTL = 60000; // 1 minute

    app.get('/api/stats', authMiddleware, async (req, res) => {
        try { 
            const now = Date.now();
            if (_statsOverviewCache && (now - _lastStatsUpdate < STATS_CACHE_TTL) && !req.query.force) {
                return res.json(_statsOverviewCache);
            }
            const { getStatsOverview } = require('./services/database');
            const data = await getStatsOverview(req.query.force === 'true');
            _statsOverviewCache = data;
            _lastStatsUpdate = now;
            res.json(data); 
        }
        catch (e) { 
            console.error("[API-STATS-ERROR]", e);
            res.status(500).json({ error: 'Erreur serveur' }); 
        }
    });

    app.get('/api/stats/daily', authMiddleware, async (req, res) => {
        try { res.json(await getDailyStats(parseInt(req.query.days) || 30)); }
        catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.get('/api/users', authMiddleware, async (req, res) => {
        try { 
            const limit = parseInt(req.query.limit) || 200;
            const offset = parseInt(req.query.offset) || 0;
            res.json(await getRecentUsers(limit, offset)); 
        }
        catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.get('/api/users/blocked', authMiddleware, async (req, res) => {
        try {
            const { getBlockedUsers } = require('./services/database');
            res.json(await getBlockedUsers(parseInt(req.query.limit) || 100));
        } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.get('/api/users/:id/analytics', authMiddleware, async (req, res) => {
        try {
            const { getUserAnalytics } = require('./services/database');
            const data = await getUserAnalytics(req.params.id);
            if (!data) return res.status(404).json({ error: 'Client introuvable' });
            res.json(data);
        } catch (e) {
            console.error('User Analytics API error:', e.message);
            res.status(500).json({ error: 'Erreur serveur' });
        }
    });

    app.get('/api/users/pending', authMiddleware, async (req, res) => {
        try {
            const { getPendingUsers } = require('./services/database');
            res.json(await getPendingUsers());
        } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.get('/api/users/search', authMiddleware, async (req, res) => {
        try { res.json(await searchUsers(req.query.q, req.query.tab || 'active')); }
        catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.post('/api/users/delete', authMiddleware, async (req, res) => {
        try {
            await deleteUser(req.body.id);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.post('/api/users/add', authMiddleware, async (req, res) => {
        try {
            const { telegram_id, first_name, username } = req.body;

            // Nettoyage de l'ID (on enlève le préfixe si l'admin l'a mis par erreur)
            const cleanId = String(telegram_id || '').replace('telegram_', '').trim();
            if (!cleanId) return res.status(400).json({ error: 'ID Telegram manquant ou invalide' });

            const { user, isNew } = await registerUser({
                id: cleanId,
                first_name: first_name || 'Utilisateur Manuel',
                username: username || '',
                type: 'user'
            });

            res.json({ success: true, user, isNew });
        } catch (e) {
            console.error('Add user error:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/users/block', authMiddleware, async (req, res) => {
        try {
            const { markUserBlocked } = require('./services/database');
            await markUserBlocked(req.body.id, true);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.post('/api/users/check-status', authMiddleware, async (req, res) => {
        try {
            const { getUser, markUserBlocked, markUserUnblocked } = require('./services/database');
            const u = await getUser(req.body.id);
            if (!u || !u.platform_id) return res.json({ success: false, error: 'User introuvable' });

            try {
                const bot = getBotInstance();
                if (!bot) return res.status(500).json({ error: 'Bot non initialisé' });

                // On tente une petite action "typing" pour voir si le bot est bloqué
                const chatId = u.platform_id.replace('telegram_', '');
                await bot.telegram.sendChatAction(chatId, 'typing');

                // Si ça réussit et qu'il était marqué bloqué par le client, on le débloque
                if (u.is_blocked && u.data && u.data.blocked_by_admin === false) {
                    await markUserUnblocked(u.id);
                }
                res.json({ success: true, status: 'active' });
            } catch (err) {
                const desc = err.description || '';
                if (err.code === 403 || desc.includes('blocked') || desc.includes('chat not found')) {
                    await markUserBlocked(u.id, false);
                    return res.json({ success: true, status: 'blocked' });
                }
                throw err;
            }
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/users/approve', authMiddleware, async (req, res) => {
        try {
            const { userId } = req.body;
            if (!userId) return res.status(400).json({ error: 'User ID manquant' });
            
            const { approveUser } = require('./services/database');
            await approveUser(userId);
            
            res.json({ success: true, message: 'Accès accordé avec succès' });
        } catch (e) {
            console.error('API Approve Error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/users/unblock', authMiddleware, async (req, res) => {
        try {
            const { markUserUnblocked } = require('./services/database');
            await markUserUnblocked(req.body.id);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.post('/api/users/sync-stats', authMiddleware, async (req, res) => {
        try {
            const { recalculateAllUserStats } = require('./services/database');
            const result = await recalculateAllUserStats();
            res.json({ success: true, ...result });
        } catch (e) {
            console.error('API Sync Stats Error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/users/order', authMiddleware, async (req, res) => {
        try {
            await incrementOrderCount(req.body.id);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    // ========== Product Routes ==========

    app.get('/api/products', authMiddleware, async (req, res) => {
        try { res.json(await getProducts()); }
        catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    let lastCatalogNotificationTime = 0;
    const CATALOG_NOTIFICATION_COOLDOWN = 10 * 60 * 1000; // 10 minutes
    app.post('/api/products', authMiddleware, async (req, res) => {
        try {
            const isMp = req.body.is_mp === true;
            delete req.body.is_mp; // IMPORTANT: Ne pas envoyer en DB native/MP

            const isNew = !req.body.id;
            let id;

            if (isMp) {
                const { saveMarketplaceProduct } = require('./services/database');
                id = await saveMarketplaceProduct(req.body);
            } else {
                id = await saveProduct(req.body);
            }

            // Notification automatique si nouveau produit
            if (isNew) {
                const now = Date.now();
                if (now - lastCatalogNotificationTime > CATALOG_NOTIFICATION_COOLDOWN) {
                    const settings = await getAppSettings();
                    const msg = settings?.msg_auto_timer || '🔥 <b>Le catalogue est à jour !</b>';
                    
                    // On broadcast à tous les utilisateurs
                    broadcastMessage('users', msg).catch(err => {
                        console.error('[Auto-Notif] Broadcast failed:', err.message);
                    });
                    
                    lastCatalogNotificationTime = now;
                    console.log(`[Auto-Notif] Notification "Catalogue à jour" envoyée car nouveau produit #${id} ajouté.`);
                } else {
                    console.log(`[Auto-Notif] Notification ignorée (cooldown actif).`);
                }
            }

            res.json({ success: true, id });
        } catch (e) {
            console.error('Product save error:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    app.delete('/api/products/:id', authMiddleware, async (req, res) => {
        try {
            await deleteProduct(req.params.id);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    // ========== Order Routes ==========

    app.get('/api/orders', authMiddleware, async (req, res) => {
        try { res.json(await getAllOrders(parseInt(req.query.limit) || 100)); }
        catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.get('/api/customers/:id/stats', authMiddleware, async (req, res) => {
        try {
            const stats = await getUserAnalytics(req.params.id);
            if (!stats) return res.status(404).json({ error: 'Client non trouvé ou sans historique' });
            res.json(stats);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });


    app.get('/api/orders/search', authMiddleware, async (req, res) => {
        try { 
            const { searchOrders } = require('./services/database');
            res.json(await searchOrders(req.query.q)); 
        } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.delete('/api/orders/:id', authMiddleware, async (req, res) => {
        try {
            const { deleteOrder } = require('./services/database');
            await deleteOrder(req.params.id);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.get('/api/analytics', authMiddleware, async (req, res) => {
        try {
            const now = Date.now();
            if (_analyticsCache && (now - _lastAnalyticsUpdate < ANALYTICS_CACHE_TTL) && !req.query.force) {
                return res.json(_analyticsCache);
            }
            const data = await getOrderAnalytics();
            _analyticsCache = data;
            _lastAnalyticsUpdate = now;
            res.json(data);
        }
        catch (e) {
            console.error("[API-ANALYTICS-ERROR]", e);
            res.status(500).json({ error: 'Erreur serveur' });
        }
    });

    app.post('/api/analytics/backfill-cities', authMiddleware, async (req, res) => {
        try {
            const { backfillOrderCities } = require('./services/database');
            const result = await backfillOrderCities();
            res.json({ success: true, ...result });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ========== Upload Routes ==========
    app.post('/api/upload', authMiddleware, async (req, res) => {
        try {
            if (!req.files || !req.files.file) {
                console.log('[UPLOAD] req.files:', req.files ? Object.keys(req.files) : 'null');
                return res.status(400).json({ error: 'Aucun fichier téléchargé' });
            }

            const file = req.files.file;
            const ext = path.extname(file.name) || (file.mimetype.includes('video') ? '.mp4' : '.jpg');
            const fileName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${ext}`;

            console.log(`[UPLOAD] Fichier reçu: ${file.name} (mime=${file.mimetype}, size=${file.size}, dataLen=${file.data?.length || 0}, tempFile=${file.tempFilePath || 'none'})`);

            // Upload direct vers Supabase Storage (seule source de vérité — pas de fallback local)
            const { supabase } = require('./config/supabase');

            // Avec useTempFiles: true, file.data est un Buffer vide — on DOIT lire le tempFile
            let fileBuf = null;

            // Priorité 1 : lire depuis le fichier temporaire (plus fiable avec useTempFiles)
            if (file.tempFilePath) {
                try {
                    fileBuf = fs.readFileSync(file.tempFilePath);
                    console.log(`[UPLOAD] Lu depuis tempFile: ${file.tempFilePath} (${fileBuf.length} bytes)`);
                } catch (readErr) {
                    console.error(`[UPLOAD] Erreur lecture tempFile: ${readErr.message}`);
                }
            }

            // Priorité 2 : utiliser file.data si le tempFile n'a rien donné
            if ((!fileBuf || fileBuf.length === 0) && file.data && file.data.length > 0) {
                fileBuf = file.data;
                console.log(`[UPLOAD] Utilisation file.data: ${fileBuf.length} bytes`);
            }

            // Priorité 3 : si file.mv existe, utiliser pour copier puis lire
            if ((!fileBuf || fileBuf.length === 0) && typeof file.mv === 'function') {
                const tmpPath = `/tmp/upload_fallback_${Date.now()}${ext}`;
                try {
                    await file.mv(tmpPath);
                    fileBuf = fs.readFileSync(tmpPath);
                    fs.unlinkSync(tmpPath);
                    console.log(`[UPLOAD] Lu via file.mv fallback: ${fileBuf.length} bytes`);
                } catch (mvErr) {
                    console.error(`[UPLOAD] Erreur mv fallback: ${mvErr.message}`);
                }
            }

            if (!fileBuf || fileBuf.length === 0) {
                console.error(`[UPLOAD-FAIL] Buffer vide pour ${file.name} (size=${file.size})`);
                return res.status(400).json({ error: 'Fichier vide — upload impossible' });
            }

            const { error } = await supabase.storage
                .from('uploads')
                .upload(fileName, fileBuf, {
                    contentType: file.mimetype,
                    upsert: true
                });

            if (error) {
                console.error(`[UPLOAD-FAIL] Supabase Storage: ${error.message}`);
                return res.status(500).json({ error: `Upload échoué: ${error.message}` });
            }

            const { data: publicData } = supabase.storage.from('uploads').getPublicUrl(fileName);
            const finalUrl = publicData.publicUrl;
            console.log(`[UPLOAD-OK] ${finalUrl} (${fileBuf.length} bytes)`);

            // Nettoyage du fichier temp
            if (file.tempFilePath) {
                fs.unlink(file.tempFilePath, () => {});
            }

            res.json({ success: true, url: finalUrl });
        } catch (e) {
            console.error(`[UPLOAD-FATAL] ${e.message}\n${e.stack}`);
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/debug/dir', authMiddleware, async (req, res) => {
        try {
            const dir = path.resolve(__dirname, 'web', 'public', 'uploads');
            if (!fs.existsSync(dir)) return res.send('Répertoire inexistant.');
            const files = fs.readdirSync(dir);
            res.json({ dir, files });
        } catch (e) { res.status(500).send(e.message); }
    });

    app.get('/api/debug/logs', authMiddleware, async (req, res) => {
        try {
            const logPath = path.join(process.cwd(), 'debug.log');
            if (!fs.existsSync(logPath)) return res.send('Aucun log trouvé.');
            
            // Read last 1000 lines only for performance
            const content = fs.readFileSync(logPath, 'utf8');
            const lines = content.split('\n');
            const lastLines = lines.slice(-1000).join('\n');
            
            res.header('Content-Type', 'text/plain');
            res.send(lastLines);
        } catch (e) { res.status(500).send(e.message); }
    });

    app.post('/api/users/wallet', authMiddleware, async (req, res) => {
        const { userId, amount } = req.body;
        try {
            const { updateUserWallet } = require('./services/database');
            await updateUserWallet(userId, amount);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/users/points', authMiddleware, async (req, res) => {
        const { userId, points } = req.body;
        try {
            const { updateUserPoints } = require('./services/database');
            await updateUserPoints(userId, points);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/livreurs/status', authMiddleware, async (req, res) => {
        const { userId, platform, isLivreur } = req.body;
        try {
            await setLivreurStatus(userId, platform, isLivreur);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.get('/api/livreurs/search', authMiddleware, async (req, res) => {
        try { res.json(await searchLivreurs(req.query.q)); }
        catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.post('/api/livreurs/availability', authMiddleware, async (req, res) => {
        const { platform, userId, isAvailable, id: directId } = req.body;
        try {
            const docId = directId || makeDocId(platform, userId);
            await setLivreurAvailability(docId, isAvailable);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/admin/nuke', authMiddleware, async (req, res) => {
        try {
            debugLog(`[ADMIN] NUKE DATABASE REQUESTED BY ${req.user?.platform_id || 'unidentified'}`);
            await nukeDatabase();
            res.json({ success: true, message: 'Base de données réinitialisée.' });
        } catch (e) {
            debugLog(`[ADMIN-FATAL] Nuke failed: ${e.message}`);
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/admin/promote', authMiddleware, async (req, res) => {
        const { platformId, role, action } = req.body;
        if (!platformId || !role) return res.status(400).json({ error: 'Données manquantes' });

        try {
            const { getAppSettings, updateAppSettings, updateUserField } = require('./services/database');
            const settings = await getAppSettings();
            
            // Resolve correct IDs: docId for DB update, platformId for legacy sync
            const docId = platformId.includes('_') ? platformId : `telegram_${platformId}`;
            const rawPlatformId = platformId.includes('_') ? platformId.split('_')[1] : platformId;

            if (role === 'moderator') {
                // Consistency: update bot_users record AND global settings (for bot logic if needed)
                await updateUserField(docId, 'is_moderateur', action === 'add');
                
                let currentIds = String(settings.list_moderators || '').split(/[\s,]+/).map(id => id.trim()).filter(id => id.length > 0);
                if (action === 'add') {
                    if (!currentIds.includes(String(rawPlatformId))) currentIds.push(String(rawPlatformId));
                } else {
                    currentIds = currentIds.filter(id => id !== String(rawPlatformId));
                }
                try {
                    await updateAppSettings({ list_moderators: currentIds.join(', ') });
                } catch (e) {
                    console.warn("⚠️ list_moderators update failed (legacy column?):", e.message);
                }
                return res.json({ success: true, ids: currentIds });
            }

            const field = role === 'admin' ? 'admin_telegram_id' : 'list_moderators';
            let currentIds = String(settings[field] || '').split(/[\s,]+/).map(id => id.trim()).filter(id => id.length > 0);

            if (action === 'add') {
                if (!currentIds.includes(String(platformId))) {
                    currentIds.push(String(platformId));
                }
            } else {
                currentIds = currentIds.filter(id => id !== String(platformId));
            }

            await updateAppSettings({ [field]: currentIds.join(', ') });
            res.json({ success: true, ids: currentIds });
        } catch (e) {
            console.error('Promotion error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/users/profile', authMiddleware, async (req, res) => {
        const { userId, first_name, phone } = req.body;
        try {
            let updates = { updated_at: ts() };
            if (first_name !== undefined) updates.first_name = encryption.encrypt(first_name);
            if (phone !== undefined) updates.phone = phone;
            
            const { error } = await supabase.from(COL_USERS).update(updates).eq('id', userId);
            if (error) throw error;
            
            _userCache.delete(userId);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/livreurs', authMiddleware, async (req, res) => {
        try {
            const { data } = await supabase.from(COL_USERS).select('*').eq('is_livreur', true);
            const livreurs = (data || []).map(d => {
                try { return decryptUser({ ...d, doc_id: d.id }); }
                catch (e) {
                    console.error('Decryption failed for livreur:', d.id, e.message);
                    return { ...d, doc_id: d.id };
                }
            });
            res.json(livreurs);
        } catch (e) { console.error('Livreurs API error:', e); res.status(500).json({ error: e.message }); }
    });

    app.get('/api/livreurs/:id/history', authMiddleware, async (req, res) => {
        try {
            const history = await getDetailedLivreurActivity(req.params.id);
            res.json(history);
        } catch (e) {
            console.error('Livreur history error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/settings', authMiddleware, async (req, res) => {
        try { res.json(await getAppSettings()); }
        catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.post('/api/settings', authMiddleware, async (req, res) => {
        try {
            const updates = { ...req.body };
            if (!updates.admin_password || updates.admin_password.trim() === '') {
                delete updates.admin_password;
            }
            await updateAppSettings(updates);
            res.json({ success: true });
        } catch (e) {
            console.error('❌ Settings update error:', e);
            res.status(500).json({ error: e.message || 'Erreur serveur' });
        }
    });

    app.post('/api/orders/status', authMiddleware, async (req, res) => {
        try {
            const { orderId, status } = req.body;
            const order = await getOrder(orderId);
            if (!order) return res.status(404).json({ error: 'Commande non trouvée' });

            await updateOrderStatus(orderId, status);

            // Notification Client Automatisée
            if (order.user_id) {
                const { sendMessageToUser } = require('./services/notifications');
                const settings = await getAppSettings();
                const shortId = orderId.slice(-5);
                
                const statusLabel = (status === 'delivered' ? settings.status_delivered_label :
                    (status === 'pending' ? settings.status_pending_label :
                        (status === 'taken' ? settings.status_taken_label : settings.status_cancelled_label))) || status.toUpperCase();

                const statusIcon = (status === 'delivered' ? settings.ui_icon_success :
                    (status === 'pending' ? settings.ui_icon_pending :
                        (status === 'taken' ? (settings.ui_icon_taken || '🚚') : settings.ui_icon_error))) || '🔔';

                let text = '';
                switch (status) {
                    case 'validated':
                        text = `✅ <b>COMMANDE VALIDÉE !</b>\n\nVotre commande #${shortId} a été acceptée. Un livreur va être assigné.`;
                        break;
                    case 'refused':
                    case 'cancelled':
                        text = `${settings.ui_icon_error} <b>COMMANDE ${statusLabel}</b>\n\nVotre commande #${shortId} a été annulée.`;
                        break;
                    case 'delivering':
                    case 'taken':
                        text = `${statusIcon} <b>COMMANDE EN ROUTE !</b>\n\nVotre commande #${shortId} est en cours de livraison. Un livreur a pris en charge votre commande et arrive vers vous. 💨`;
                        break;
                    case 'delivered':
                        text = `${statusIcon} <b>COMMANDE LIVRÉE !</b>\n\nVotre commande #${shortId} a été livrée. Bonne dégustation ! 🏁`;
                        break;
                    case 'arrival_1h':
                        text = `🚚 <b>Commande #${shortId}</b>\n\nVotre livreur arrive dans <b>moins d'une heure</b>. 📦`;
                        break;
                    case 'arrival_30min':
                        text = `⏳ <b>Commande #${shortId}</b>\n\nVotre livreur arrive dans <b>30 min</b> ! Soyez prêt(e). 🛵`;
                        break;
                    case 'arrival_10min':
                        text = `⏳ <b>Commande #${shortId}</b>\n\nVotre livreur arrive dans <b>10 min</b> ! Préparez-vous. 🛵`;
                        break;
                    case 'arrival_5min':
                        text = `⚡ <b>Commande #${shortId}</b>\n\nVotre livreur arrive dans <b>5 min</b> ! Soyez prêt(e). 🔥`;
                        break;
                    case 'arrived':
                        text = `📍 <b>Commande #${shortId}</b>\n\n<b>Votre livreur est arrivé !</b> Il vous attend sur place. ✅`;
                        break;
                    case 'cancelled':
                        text = `${settings.ui_icon_error} <b>${statusLabel} de commande</b>\n\nVotre commande #${shortId} a été annulée par l'administration.`;
                        break;
                    case 'pending':
                        text = `${settings.ui_icon_pending} <b>Mise à jour de commande</b>\n\nVotre commande #${shortId} est de nouveau ${statusLabel}.`;
                        break;
                }
                
                if (text) {
                    const { Markup } = require('telegraf');
                    let keyboard = [];

                    // Ajouter bouton annulation si pas encore livré ou annulé
                    if (!['delivered', 'cancelled', 'refused'].includes(status)) {
                        keyboard.push([Markup.button.callback('❌ Annuler ma commande', `cancel_order_client_${orderId}`)]);
                        // Si c'est une notification de temps, permettre de répondre
                        if (status.startsWith('arrival_')) {
                            keyboard.push([Markup.button.callback('💬 Répondre au livreur', `chat_livreur_${orderId}`)]);
                        }
                    } else if (status === 'delivered') {
                        keyboard.push([Markup.button.callback('⭐️ Laisser un avis', `feedback_start_${orderId}`)]);
                    }

                    keyboard.push([Markup.button.callback('◀️ Retour Menu', 'main_menu')]);

                    await sendMessageToUser(order.user_id, text, {
                        reply_markup: Markup.inlineKeyboard(keyboard).reply_markup
                    }).catch(() => {});
                }
            }

            res.json({ success: true });
        } catch (e) {
            console.error('Order Status API error:', e);
            res.status(500).json({ error: 'Erreur serveur' });
        }
    });

    app.post('/api/orders/assign', authMiddleware, async (req, res) => {
        try {
            const { orderId, livreurId, livreurName } = req.body;
            const { assignOrderLivreur, getOrder } = require('./services/database');
            const order = await getOrder(orderId);
            await assignOrderLivreur(orderId, livreurId, livreurName);

            // On notifie UNIQUEMENT le livreur
            if (livreurId) {
                const { sendMessageToUser } = require('./services/notifications');
                const textLivreur = `📦 <b>MISSION ASSIGNÉE</b>\n\nUne commande vient de vous être assignée par l'administration.\n\n🆔 #<code>${orderId.slice(-5)}</code>\n👤 Client : ${order?.first_name || 'Utilisateur'}\n📍 Adresse : ${order?.address || 'Non spécifiée'}`;
                await sendMessageToUser(livreurId, textLivreur, {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [[{ text: '📂 Détails de la mission', callback_data: `order_view_single_${orderId}` }]]
                    }
                }).catch(() => { });
            }
            res.json({ success: true });
        } catch (e) {
            console.error('Order Assign API error:', e);
            res.status(500).json({ error: 'Erreur serveur' });
        }
    });

    app.post('/api/orders/delete', authMiddleware, async (req, res) => {
        try {
            await deleteOrder(req.body.id);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    /**
     * Broadcast - accepte FormData avec fichiers médias
     */
    app.post('/api/broadcast', authMiddleware, async (req, res) => {
        try {
            const message = req.body.message || '';
            const platform = req.body.platform || 'all';
            const mediaCount = parseInt(req.body.media_count) || 0;

            // Extraire les fichiers médias
            const mediaFiles = [];
            if (req.files) {
                const fs = require('fs');
                debugLog(`[API-BC] Reçu de ${mediaCount} fichiers attendus.`);
                for (let i = 0; i < mediaCount; i++) {
                    const f = req.files[`media_${i}`];
                    if (f) {
                        try {
                            const fileData = f.tempFilePath ? fs.readFileSync(f.tempFilePath) : f.data;
                            if (fileData && fileData.length > 0) {
                                mediaFiles.push({ data: fileData, mimetype: f.mimetype, name: f.name });
                                debugLog(`[API-BC] Fichier ${i} prêt: ${f.name} (${f.mimetype}, ${fileData.length} octets)`);
                            }
                        } catch (err) {
                            debugLog(`[API-BC-ERR] Lecture fichier ${i}: ${err.message}`);
                        }
                    } else {
                        debugLog(`[API-BC-WARN] media_${i} manquant dans req.files`);
                    }
                }
            }

            let mediaUrls = [];
            try { mediaUrls = req.body.media_urls ? JSON.parse(req.body.media_urls) : []; } catch (e) { mediaUrls = []; }

            // 1. Upload des fichiers physiques reçus en Storage avant mise en file d'attente
            const uploadedUrls = [];
            const { uploadMediaBuffer } = require('./services/database');
            for (let i = 0; i < mediaFiles.length; i++) {
                const f = mediaFiles[i];
                const cleanName = `bc_${Date.now()}_${i}_${f.name.replace(/[^\w.-]/g, '_')}`;
                const url = await uploadMediaBuffer(f.data, cleanName, f.mimetype);
                if (url) uploadedUrls.push(url);
                debugLog(`[API-BC] Média uploadé: ${url}`);
            }

            // 2. Union avec les URLs déjà existantes envoyées par le dashboard (si sélection multiples)
            const allMedia = [...uploadedUrls, ...mediaUrls];

            // 3. Sérialisation du message si médias présents (format supporté par broadcastMessage)
            let finalMsg = message;
            if (allMedia.length > 0) {
                finalMsg += `|||MEDIA_URLS|||${JSON.stringify(allMedia)}`;
            }

            // Sauvegarder en DB (sera récupéré par le worker sur Replica 0)
            const broadcastId = await saveBroadcast({
                message: finalMsg,
                target_platform: platform,
                status: 'pending',
                start_at: req.body.start_at || new Date().toISOString(),
                media_count: allMedia.length,
                total_target: 0, // Sera calculé par le worker
                badge: req.body.badge || null
            });

            debugLog(`[API-BC-QUEUED] Diffusion #${broadcastId} ajoutée (${allMedia.length} médias)`);
            res.json({ status: 'queued', id: broadcastId });
        } catch (e) {
            debugLog(`[API-BC-CRITICAL] ${e.message}`);
            res.status(500).json({ error: 'Erreur broadcast' });
        }
    });

    app.get('/api/broadcasts', authMiddleware, async (req, res) => {
        try { res.json(await getBroadcastHistory()); }
        catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.get('/api/reviews', authMiddleware, async (req, res) => {
        try { res.json(await getReviews(parseInt(req.query.limit) || 100)); }
        catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.post('/api/reviews/delete', authMiddleware, async (req, res) => {
        try {
            await deleteReview(req.body.id);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.delete('/api/broadcasts/:id', authMiddleware, async (req, res) => {
        try {
            await deleteBroadcast(req.params.id);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    // ====== SUPPLIERS / FOURNISSEURS ======
    app.get('/api/suppliers', authMiddleware, async (req, res) => {
        try { res.json(await getSuppliers()); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/suppliers/:id', authMiddleware, async (req, res) => {
        try { res.json(await getSupplier(req.params.id)); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/suppliers', authMiddleware, async (req, res) => {
        try {
            const result = await saveSupplier(req.body);
            res.json(result);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.delete('/api/suppliers/:id', authMiddleware, async (req, res) => {
        try {
            await deleteSupplier(req.params.id);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/suppliers/:id/products', authMiddleware, async (req, res) => {
        try { res.json(await getSupplierProducts(req.params.id)); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/suppliers/:id/orders', authMiddleware, async (req, res) => {
        try { res.json(await getSupplierOrders(req.params.id)); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ========== MARKETPLACE API ==========

    // Tous les produits marketplace (optionnel: ?supplier_id=xxx)
    app.get('/api/marketplace/products', authMiddleware, async (req, res) => {
        try { 
            const products = await getMarketplaceProducts(req.query.supplier_id || null);
            console.log(`[API] Marketplace products requested (${req.query.supplier_id || 'all'}): found ${products.length}`);
            res.json(products); 
        }
        catch (e) { 
            console.error('[API] Marketplace error:', e.message);
            res.status(500).json({ error: e.message }); 
        }
    });

    // Produits disponibles seulement
    app.get('/api/marketplace/products/available', authMiddleware, async (req, res) => {
        try { res.json(await getAvailableMarketplaceProducts(req.query.supplier_id || null)); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Un produit marketplace
    app.get('/api/marketplace/products/:id', authMiddleware, async (req, res) => {
        try { res.json(await getMarketplaceProduct(req.params.id)); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Créer/modifier un produit marketplace
    app.post('/api/marketplace/products', authMiddleware, async (req, res) => {
        try {
            const result = await saveMarketplaceProduct(req.body);
            res.json({ success: true, product: result });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Supprimer un produit marketplace
    app.delete('/api/marketplace/products/:id', authMiddleware, async (req, res) => {
        try {
            await deleteMarketplaceProduct(req.params.id);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Mettre à jour le stock
    app.post('/api/marketplace/products/:id/stock', authMiddleware, async (req, res) => {
        try {
            const { updateMarketplaceStock } = require('./services/database');
            await updateMarketplaceStock(req.params.id, parseInt(req.body.stock));
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/marketplace/products/:id/validate', authMiddleware, async (req, res) => {
        try {
            const { validateMarketplaceProduct, saveProduct, getMarketplaceProduct } = require('./services/database');
            await validateMarketplaceProduct(req.params.id, req.body.is_validated);
            
            // Si c'est pour le catalogue principal (Retail) et validé
            if (req.body.is_validated && req.body.promote_to_retail) {
                await require('./services/database').promoteMarketplaceProduct(req.params.id);
            }
            
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/marketplace/products/:id/promote', authMiddleware, async (req, res) => {
        try {
            const { promoteMarketplaceProduct } = require('./services/database');
            const newId = await promoteMarketplaceProduct(req.params.id);
            res.json({ success: true, newId });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/marketplace/products/:id/transfer', authMiddleware, async (req, res) => {
        try {
            const { promoteMarketplaceProduct, deleteMarketplaceProduct } = require('./services/database');
            const newId = await promoteMarketplaceProduct(req.params.id);
            await deleteMarketplaceProduct(req.params.id);
            res.json({ success: true, newId });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Commandes marketplace
    app.get('/api/marketplace/orders', authMiddleware, async (req, res) => {
        try { res.json(await getMarketplaceOrders(req.query.supplier_id || null, parseInt(req.query.limit) || 50)); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Créer une commande marketplace
    app.post('/api/marketplace/orders', authMiddleware, async (req, res) => {
        try {
            const result = await createMarketplaceOrder(req.body);
            
            // Notify Supplier via Telegram bot
            const bot = getBotInstance();
            if (bot && req.body.supplier_id) {
                const { getSupplier } = require('./services/database');
                const supplier = await getSupplier(req.body.supplier_id);
                if (supplier && supplier.telegram_id) {
                    const productsText = req.body.products.map(p => `• ${p.name} x${p.qty}`).join('\n');
                    const msg = `📢 <b>NOUVELLE COMMANDE ADMIN</b>\n\n📌 <b>Détails :</b>\n${productsText}\n\n💰 Total : ${req.body.total_price}€\n📦 Commande : #${result.id.slice(-5)}\n📍 Livraison : ${req.body.delivery_type === 'pickup' ? 'RETRAIT SUR PLACE' : req.body.address || 'Non spécifié'}`;
                    bot.telegram.sendMessage(supplier.telegram_id.replace('telegram_', ''), msg, { 
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '✅ Accepter', callback_data: `mp_accept_${result.id}` }, { text: '❌ Refuser', callback_data: `mp_reject_${result.id}` }],
                                [{ text: '📋 Mes Commandes', callback_data: 'mp_my_orders' }]
                            ]
                        }
                    }).catch(err => {
                        console.error('[Marketplace Notif] Error notifying supplier:', err.message);
                    });
                }
            }
            
            res.json({ success: true, order: result });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Mettre à jour le statut d'une commande marketplace
    app.post('/api/marketplace/orders/:id/status', authMiddleware, async (req, res) => {
        try {
            await updateMarketplaceOrderStatus(req.params.id, req.body.status);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ========== FIN MARKETPLACE API ==========

    app.use('/api/*', (req, res) => {
        res.status(404).json({ error: 'Route API non trouvée' });
    });

    // Global error handler for Express
    app.use((err, req, res, next) => {
        console.error('❌ [EXPRESS ERROR]', err);
        res.status(500).json({ error: 'Erreur interne du serveur' });
    });

    return app;
}

module.exports = { createServer, setBotInstance, getBotInstance };
