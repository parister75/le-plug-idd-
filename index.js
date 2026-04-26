const fs = require('fs');
const envPath = fs.existsSync('.env.railway') ? '.env.railway' : '.env';
require('dotenv').config({ path: envPath });
// [DEPLOY] QR Regeneration & Debug - 2026-04-25 23:05

console.log(`[Système] Chargement de l'environnement depuis : ${envPath}`);
if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) {
    console.log('[Système] Environnement Railway détecté');
    console.log('[Système] ID Déploiement :', process.env.RAILWAY_DEPLOYMENT_ID || 'Inconnu');
    console.log('[Système] Index Réplica :', process.env.RAILWAY_REPLICA_INDEX || '0');
    console.log('[Système] ID Processus :', process.pid);
}

// DEBUG ENV (Masked)
const keysToLog = ['BOT_TOKEN', 'SUPABASE_URL', 'WHATSAPPD_SESSION_ID', 'WHATSAPP_SESSION_ID', 'PORT'];
console.log('[Système-Debug] Vérification des variables clés :');
keysToLog.forEach(key => {
    let val = process.env[key];
    if (typeof val === 'string') val = val.trim();

    if (val && val.length > 0) {
        console.log(`   - ${key} : PRÉSENT (${val.length} chars, début: ${val.substring(0, 4)}...)`);
    } else {
        const rawVal = process.env[key];
        const detail = (rawVal === undefined) ? 'UNDEFINED' : (rawVal === '' ? 'EMPTY_STRING' : 'WHITESPACE_ONLY');
        console.log(`   - ${key} : MANQUANT ❌ (${detail})`);
    }
});

const { createServer, setBotInstance } = require('./server');
const { dispatcher } = require('./services/dispatcher');
const { registry } = require('./channels/ChannelRegistry');
const { initChannels } = require('./services/channel_init');
const { registerUser, getAppSettings, markUserBlocked, markUserUnblocked, getAllUsersForBroadcast, getAllActiveUsers, updateUserData } = require('./services/database');
const { setBroadcastBot, broadcastMessage } = require('./services/broadcast');
const { safeEdit, cleanupUserChat } = require('./services/utils');
const { notifyAdmins } = require('./services/notifications');

// Gestionnaires
const { setupStartHandler, initStartState, getMainMenuKeyboard, getLivreurMenuKeyboard } = require('./handlers/start');
const { setupAdminHandlers } = require('./handlers/admin');
const { setupOrderSystem, initOrderState, checkAbandonedCarts } = require('./handlers/order_system');
const { setupMarketplaceHandlers, initMarketplaceState } = require('./handlers/supplier_marketplace');

const PORT = process.env.PORT || 3000;
console.log(`[Système] PORT final déterminé : ${PORT}`);
const awaitingPollResponse = new Map();

let isStarting = false;

async function main() {
    if (isStarting) return;
    isStarting = true;

    console.log('🚀 DÉMARRAGE VERSION RAILWAY STABLE...');
    
    const finalPort = process.env.PORT || 3000;

    // 1. Démarrage du serveur Web IMMÉDIAT
    const server = createServer();
    server.listen(finalPort, '0.0.0.0', () => {
        console.log(`\n✅ SERVEUR WEB ACTIF SUR LE PORT ${finalPort}`);
        console.log(`🔗 TEST SANTÉ : https://TIMLEMEILLEURidf-production.up.railway.app/_health\n`);
    });

    // 2. Initialisation du Dispatcher (Simule Telegraf)
    console.log('📦 Initialisation du Dispatcher...');
    await dispatcher.init();

    // Middleware de maintenance et tracking
    dispatcher.use(async (ctx, next) => {
        try {
            const settings = ctx.state.settings;

            // 1. Vérifier si la plateforme est activée
            if (ctx.platform === 'telegram' && settings.enable_telegram === false) {
                if (ctx.callbackQuery) return ctx.answerCbQuery("ℹ️ Le service Telegram est actuellement désactivé.", { show_alert: true }).catch(() => {});
                return ctx.reply("ℹ️ <b>Service Temporairement Indisponible</b>\n\nLe bot Telegram est actuellement désactivé par l'administration. Veuillez nous contacter sur WhatsApp ou réessayer plus tard.", { parse_mode: 'HTML' }).catch(() => {});
            }
            if (ctx.platform === 'whatsapp' && settings.enable_whatsapp === false) {
                return ctx.reply("ℹ️ *Service Temporairement Indisponible*\n\nLe service WhatsApp est actuellement désactivé. Veuillez utiliser notre bot Telegram ou réessayer plus tard.").catch(() => {});
            }

            // 2. Vérifier si le mode maintenance est activé
            if (settings && (settings.maintenance_mode === true || settings.maintenance_mode === 'true')) {
                const adminContact = settings.maintenance_contact || 'https://t.me/plugnation_admin';
                const maintenanceMessage = settings.maintenance_message || '🔧 <b>Le bot est actuellement en maintenance.</b>\n\nNous revenons bientôt !\n\nContactez l\'admin : @plugnation_admin';

                if (ctx.callbackQuery) {
                    await ctx.answerCbQuery(maintenanceMessage, { show_alert: true }).catch(() => { });
                    return;
                }

                if (ctx.message) {
                    await ctx.reply(maintenanceMessage + `\n\n📱 Contact : ${adminContact}`, { parse_mode: 'HTML' }).catch(() => { });
                    if (ctx.platform === 'telegram') await ctx.deleteMessage().catch(() => { });
                    return;
                }
                return;
            }

            // Suivi d'activité pour paniers abandonnés
            const { userLastActivity } = require('./handlers/order_system');
            if (userLastActivity && ctx.from?.id) {
                userLastActivity.set(ctx.from.id, Date.now());
            }

            // Gestion des bannissements
            const registeredUser = ctx.state.user;
            if (registeredUser && registeredUser.is_blocked) {
                if (!registeredUser.data || registeredUser.data.blocked_by_admin !== true) {
                    await markUserUnblocked(registeredUser.id);
                    registeredUser.is_blocked = false;
                } else {
                    if (ctx.callbackQuery) {
                        return ctx.answerCbQuery("⛔️ Votre compte est suspendu.", { show_alert: true }).catch(() => { });
                    }
                    return ctx.reply("⛔️ <b>ACCÈS REFUSÉ</b>\n\nVotre compte a été suspendu par l'administration. Contactez le support pour plus d'informations.", { parse_mode: 'HTML' }).catch(() => { });
                }
            }

            await next();

            // Nettoyage messages Telegram
            if (ctx.platform === 'telegram' && ctx.message && ctx.chat?.type === 'private') {
                await ctx.deleteMessage().catch(() => { });
            }
        } catch (e) {
            console.error('❌ Erreur Fatale Middleware :', e.message);
            throw e;
        }
    });

    // [DEPLOY] QR Regeneration & Debug - 2026-04-25 22:40
    // Liaison des Gestionnaires existants au dispatcher
    setupStartHandler(dispatcher);
    setupOrderSystem(dispatcher);
    setupAdminHandlers(dispatcher);

    // Marketplace fournisseurs
    const { handleMarketplaceText, handleMarketplacePhoto, handleMarketplaceVideo } = setupMarketplaceHandlers(dispatcher);
    await initMarketplaceState();
    console.log('🏪 Marketplace fournisseurs initialisée');

    // Sondages (Actions & Messages)
    dispatcher.action(/^poll_free_([\w-]+)(?:_(\d+))?$/, async (ctx) => {
        const bcId = ctx.match[1];
        const bcIndex = ctx.match[2];
        const userId = ctx.from.id;
        awaitingPollResponse.set(userId, { bcId, bcIndex });
        await ctx.answerCbQuery();
        await cleanupUserChat(ctx);
        await ctx.reply("🖋 <b>Veuillez écrire votre réponse ci-dessous :</b>", { parse_mode: 'HTML' });
    });

    dispatcher.action(/^poll_vote_([\w-]+)_(\d+)(?:_(\d+))?$/, async (ctx) => {
        const bcId = ctx.match[1];
        const optIdx = parseInt(ctx.match[2]);
        const bcIndex = ctx.match[3];
        const userId = `${ctx.platform}_${ctx.from.id}`;
        const { recordPollVote } = require('./services/database');

        try {
            const userName = ctx.from.first_name || 'Utilisateur';
            const result = await recordPollVote(bcId, optIdx, userId, userName, ctx.platform);
            
            if (result === 'already_voted') {
                await ctx.answerCbQuery("⚠️ Vous avez déjà voté pour ce sondage !", { show_alert: true });
                return;
            }

            await ctx.answerCbQuery("✅ Vote enregistré, merci !");
            await cleanupUserChat(ctx);

            if (bcIndex !== undefined) {
                await ctx.reply("✅ Vote enregistré !");
                return;
            }

            const settings = ctx.state.settings;
            const user = ctx.state.user;

            let text = `✅ <b>Merci pour votre participation !</b>\n\nQue souhaitez-vous faire maintenant ?`;
            let keyboard = user.is_livreur ? await getLivreurMenuKeyboard(ctx, settings, user) : await getMainMenuKeyboard(ctx, settings, user);
            
            await ctx.reply(text, keyboard);
        } catch (e) {
            console.error('[SONDAGE-VOTE] Erreur :', e);
            await ctx.answerCbQuery("⚠️ Erreur lors du vote.", { show_alert: true });
        }
    });

    dispatcher.on('text', async (ctx, next) => {
        const userId = ctx.from.id;
        if (awaitingPollResponse.has(userId)) {
            const { bcId, bcIndex } = awaitingPollResponse.get(userId);
            awaitingPollResponse.delete(userId);
            const text = (ctx.message.text || '').trim();
            if (text) {
                const { recordPollFreeResponse } = require('./services/database');
                try {
                    const userName = ctx.from.first_name || 'Utilisateur';
                    await recordPollFreeResponse(bcId, userId, userName, text);
                    const replyText = `✅ <b>Votre réponse a été enregistrée :</b>\n\n<i>"${text}"</i>\n\nMerci pour votre participation !`;
                    
                    await cleanupUserChat(ctx);
                    if (bcIndex !== undefined) {
                        await ctx.reply(replyText);
                        return ctx.reply("🔄 Menu Principal", await getMainMenuKeyboard(ctx, ctx.state.settings, ctx.state.user));
                    }
                    await ctx.reply(replyText, await getMainMenuKeyboard(ctx, ctx.state.settings, ctx.state.user));
                    return;
                } catch (e) {
                    console.error('[SONDAGE-LIBRE] Erreur :', e);
                    await ctx.reply("⚠️ Une erreur est survenue.");
                }
            }
        }
        // Gestionnaire texte Marketplace (flux ajout/édition produit fournisseur)
        const mpResult = handleMarketplaceText(ctx);
        if (mpResult !== false) { await mpResult; return; }

        await next();
    });

    // Gestionnaire photo Marketplace
    dispatcher.on('photo', async (ctx, next) => {
        console.log(`[Marketplace-Photo] Photo reçue de ${ctx.from.id}`);
        const mpPhotoResult = handleMarketplacePhoto(ctx);
        if (mpPhotoResult !== false) { 
            console.log(`[Marketplace-Photo] Photo traitée par la marketplace`);
            await mpPhotoResult; 
            return; 
        }
        await next();
    });

    // Gestionnaire vidéo Marketplace
    dispatcher.on('video', async (ctx, next) => {
        console.log(`[Marketplace-Vidéo] Vidéo reçue de ${ctx.from.id}`);
        const mpVideoResult = handleMarketplaceVideo(ctx);
        if (mpVideoResult !== false) { 
            console.log(`[Marketplace-Vidéo] Vidéo traitée par la marketplace`);
            await mpVideoResult; 
            return; 
        }
        await next();
    });


    // 2. Initialisation des Canaux
    const replicaIndex = process.env.RAILWAY_REPLICA_INDEX || '0';
    if (replicaIndex === '0') {
        console.log('[Système] Réplica 0 : Démarrage de tous les canaux (WA + TG)...');
        await initChannels();
        
        // Travailleur de Diffusion en Arrière-plan
        const { processPendingBroadcasts } = require('./services/broadcast');
        const bcInterval = 15000;
        
        // Exécuter immédiatement au démarrage, puis toutes les 15s
        const runBcWorker = async () => {
            try {
                await processPendingBroadcasts();
            } catch (e) {
                console.error('[BC-WORKER-ERR] Erreur de boucle :', e.message);
            }
        };
        runBcWorker();
        setInterval(runBcWorker, bcInterval);
        console.log('👷 Travailleur de Diffusion actif (Réplica 0)');
    } else {
        console.log(`[Système] Réplica ${replicaIndex} : Canaux d'arrière-plan désactivés pour éviter les conflits.`);
    }

    // 3. Liaison Canaux -> Dispatcher
    const channels = registry.query();
    for (const channel of channels) {
        channel.onMessage(async (msg) => {
            await dispatcher.handleUpdate(channel, msg);
        });
        if (channel.type === 'telegram') {
            const bot = channel.getBotInstance ? channel.getBotInstance() : null;
            if (bot) {
                setBotInstance(bot);
                setBroadcastBot(bot);

                // Config Telegram (Description, Commandes)
                getAppSettings().then(settings => {
                    if (settings.bot_description) bot.telegram.setMyDescription(settings.bot_description).catch(() => { });
                    if (settings.bot_short_description) bot.telegram.setMyShortDescription(settings.bot_short_description).catch(() => { });
                    bot.telegram.setMyCommands([
                        { command: 'start', description: '🏠 Lancer le bot / Accueil' },
                        { command: 'menu', description: '🛒 Voir le catalogue' },
                        { command: 'orders', description: '📦 Mes commandes' },
                        { command: 'help', description: '❓ Aide et support' }
                    ]).catch(() => { });
                }).catch(() => { });
            }
        }
    }

    // 5. États persistants & Timers
    await Promise.all([initOrderState(), initStartState(), require('./handlers/admin').initAdminState()]);

    const runAutomatedTasks = () => {
        const tgChannel = registry.query('telegram');
        const bot = tgChannel?.getBotInstance();
        if (bot) {
            // startAutomatedTimer(bot); // RETIRÉ — Notification catalogue à jour
            setInterval(() => checkPlannedOrders(bot), 60000);
            setInterval(() => checkAbandonedCarts(bot), 1800000);
            setInterval(() => runAutomatedSync(bot), 900000);
        }
        // Doublon checkScheduledBroadcasts supprimé - géré par le worker Réplica 0 dans broadcast.js
    };
    runAutomatedTasks();

    console.log('\n🚀 Environnement Multi-Canaux prêt !');
}

// Fonctionnalités héritées de l'ancien index.js
async function checkPlannedOrders(bot) {
    try {
        const { getUpcomingPlannedOrders, markNotifSent } = require('./services/database');
        const orders = await getUpcomingPlannedOrders();
        if (orders.length === 0) return;
        const nowParis = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Paris" }));
        for (const order of orders) {
            if (!order.scheduled_at || !order.scheduled_at.includes(' ')) continue;
            
            const parts = order.scheduled_at.split(' ');
            const datePart = parts[0];
            const timePart = parts[1];
            if (!timePart) continue;

            const timeClean = timePart.replace('h', ':');
            const [h, m] = timeClean.split(':');
            if (h === undefined || m === undefined) continue;

            const schedDate = new Date(`${datePart}T${h.padStart(2, '0')}:${m.padStart(2, '0')}:00`);
            if (isNaN(schedDate.getTime())) continue;

            const diffMin = Math.round((schedDate - nowParis) / 60000);
            if (diffMin <= 60 && diffMin > 30 && !order.notif_1h_sent) {
                await sendPlannedAlert(bot, order, '1h');
                await markNotifSent(order.id, '1h');
            }
            if (diffMin <= 30 && diffMin > 0 && !order.notif_30m_sent) {
                await sendPlannedAlert(bot, order, '30m');
                await markNotifSent(order.id, '30m');
            }
        }
    } catch (e) {
        console.error('❌ Erreur checkPlannedOrders :', e.message);
    }
}

async function sendPlannedAlert(bot, order, type) {
    const text = `⏰ <b>RAPPEL COMMANDE PLANIFIÉE (${type})</b>\n\n...`;
    if (order.livreur_id) {
        const livreurTgId = order.livreur_id.replace('telegram_', '');
        await bot.telegram.sendMessage(livreurTgId, text, { parse_mode: 'HTML' }).catch(() => { });
    }
    notifyAdmins(bot, `📢 [INFO ADMIN] ${text}`);
}

async function checkScheduledBroadcasts() {
    try {
        const { supabase, COL_BROADCASTS, COL_USERS } = require('./services/database'); // Ajout de COL_USERS
        const { broadcastMessage } = require('./services/broadcast');
        const now = new Date().toISOString();
        const { data: pending } = await supabase.from(COL_BROADCASTS).select('*').eq('status', 'pending').lte('start_at', now);
        if (!pending || pending.length === 0) return;
        for (const bc of pending) {
            let finalMsg = bc.message || '';
            let mediaUrls = [];
            if (finalMsg.includes('|||MEDIA_URLS|||')) {
                const parts = finalMsg.split('|||MEDIA_URLS|||');
                finalMsg = parts[0];
                try { mediaUrls = JSON.parse(parts[1]); } catch (e) { }
            }
            await broadcastMessage(bc.target_platform, finalMsg, { id: bc.id, mediaUrls: mediaUrls, start_at: bc.start_at, end_at: bc.end_at, badge: bc.badge });
        }
    } catch (e) { console.error('❌ Erreur checkScheduledBroadcasts :', e.message); }
}

function startAutomatedTimer(bot) {
    setInterval(async () => {
        try {
            const settings = await getAppSettings();
            if (settings.msg_auto_timer && settings.msg_auto_timer.length > 5) {
                await broadcastMessage('all', settings.msg_auto_timer);
            }
        } catch (e) { }
    }, 6 * 60 * 60 * 1000);
}

async function runAutomatedSync(bot) {
    try {
        const users = await getAllUsersForBroadcast('telegram', 'user');
        if (!users || users.length === 0) return;
        
        console.log(`[Sync] Démarrage de la synchronisation pour ${users.length} utilisateurs...`);
        
        // Traiter par lots de 10 pour éviter le blocage de la boucle d'événements (cause fréquente des erreurs WhatsApp 408)
        const batchSize = 10;
        for (let i = 0; i < users.length; i += batchSize) {
            const batch = users.slice(i, i + batchSize);
            await Promise.allSettled(batch.map(async (u) => {
                try {
                    const chatId = String(u.platform_id || u.id || '').replace('telegram_', '');
                    if (!chatId || isNaN(chatId)) return;
                    
                    // On teste si l'utilisateur a bloqué le bot
                    try {
                        await bot.telegram.sendChatAction(chatId, 'typing');
                        
                        // Si le bot n'est pas bloqué mais l'user était marqué bloqué (auto) -> on débloque
                        if (u.is_blocked && (!u.data || u.data.blocked_by_admin !== true)) {
                            await markUserUnblocked(u.id);
                            console.log(`[Sync] Utilisateur ${u.id} de nouveau joignable, déblocage.`);
                        }
                    } catch (err) {
                        // 403 = l'utilisateur a bloqué le bot
                        if (err.code === 403) {
                            // On ne re-marque bloqué QUE s'il ne l'est pas déjà
                            if (!u.is_blocked) {
                                await markUserBlocked(u.id, false);
                                console.log(`[Sync] Utilisateur ${u.id} a bloqué le bot.`);
                            }
                        }
                    }
                } catch (e) { }
            }));
            // Délai plus long entre les lots pour laisser souffler le processeur
            await new Promise(r => setTimeout(r, 1000));
        }
        console.log(`[Sync] Synchronisation terminée pour ${users.length} utilisateurs.`);
    } catch (e) {
        console.error('❌ Erreur runAutomatedSync :', e.message);
    }
}

main().catch(console.error);
