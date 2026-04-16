const fs = require('fs');
const envPath = fs.existsSync('.env.railway') ? '.env.railway' : '.env';
require('dotenv').config({ path: envPath });
// [TEST RECONNECT] Supabase session persistence — push sans déconnexion WA

console.log(`[System] Loading environment from: ${envPath}`);
if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) {
    console.log('[System] Detected Railway Environment');
    console.log('[System] Deployment ID:', process.env.RAILWAY_DEPLOYMENT_ID || 'Unknown');
    console.log('[System] Replica Index:', process.env.RAILWAY_REPLICA_INDEX || '0');
    console.log('[System] Process ID:', process.pid);
}

const { createServer, setBotInstance } = require('./server');
const { dispatcher } = require('./services/dispatcher');
const { registry } = require('./channels/ChannelRegistry');
const { initChannels } = require('./services/channel_init');
const { registerUser, getAppSettings, markUserBlocked, markUserUnblocked, getAllUsersForBroadcast, getAllActiveUsers, updateUserData } = require('./services/database');
const { setBroadcastBot, broadcastMessage } = require('./services/broadcast');
const { safeEdit, cleanupUserChat } = require('./services/utils');
const { notifyAdmins } = require('./services/notifications');

// Handlers
const { setupStartHandler, initStartState, getMainMenuKeyboard, getLivreurMenuKeyboard } = require('./handlers/start');
const { setupAdminHandlers } = require('./handlers/admin');
const { setupOrderSystem, initOrderState, checkAbandonedCarts } = require('./handlers/order_system');
const { setupMarketplaceHandlers, initMarketplaceState } = require('./handlers/supplier_marketplace');

const PORT = process.env.PORT || 3000;
console.log(`[System] Final PORT determined: ${PORT}`);
const awaitingPollResponse = new Map();
let handleMarketplaceText = () => false;
let handleMarketplacePhoto = () => false;
let handleMarketplaceVideo = () => false;

let isStarting = false;

async function main() {
    if (isStarting) return;
    isStarting = true;

    console.log('🚀 DÉMARRAGE VERSION RAILWAY STABLE...');
    
    const finalPort = process.env.PORT || 3000;

    // 1. Démarrage du serveur Web IMMEDIAT
    const server = createServer();
    server.listen(finalPort, '0.0.0.0', () => {
        console.log(`\n✅ SERVEUR WEB ACTIF SUR LE PORT ${finalPort}`);
        console.log(`🔗 TEST HEALTH : https://le-plug-idf.up.railway.app/_health\n`);
    });

    // 2. Initialisation du Dispatcher (Simule Telegraf)
    console.log('📦 Initialisation du Dispatcher...');
    await dispatcher.init();

    // Middleware de maintenance et tracking
    dispatcher.use(async (ctx, next) => {
        try {
            const settings = ctx.state.settings;

            // 1. Check if the platform itself is enabled
            if (ctx.platform === 'telegram' && settings.enable_telegram === false) {
                if (ctx.callbackQuery) return ctx.answerCbQuery("ℹ️ Le service Telegram est actuellement désactivé.", { show_alert: true }).catch(() => {});
                return ctx.reply("ℹ️ <b>Service Temporairement Indisponible</b>\n\nLe bot Telegram est actuellement désactivé par l'administration. Veuillez nous contacter sur WhatsApp ou réessayer plus tard.", { parse_mode: 'HTML' }).catch(() => {});
            }
            if (ctx.platform === 'whatsapp' && settings.enable_whatsapp === false) {
                return ctx.reply("ℹ️ *Service Temporairement Indisponible*\n\nLe service WhatsApp est actuellement désactivé. Veuillez utiliser notre bot Telegram ou réessayer plus tard.").catch(() => {});
            }

            // 2. Check if maintenance mode is enabled
            if (settings && (settings.maintenance_mode === true || settings.maintenance_mode === 'true')) {
                const adminContact = settings.maintenance_contact || 'https://t.me/leplugidf_contact';
                const maintenanceMessage = settings.maintenance_message || '🔧 <b>Le bot est actuellement en maintenance.</b>\n\nNous revenons bientôt !\n\nContactez l\'admin : @leplugidf_contact';

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

            // Tracking activité pour paniers abandonnés
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

            // Nettoyage messages telegram
            if (ctx.platform === 'telegram' && ctx.message && ctx.chat?.type === 'private') {
                await ctx.deleteMessage().catch(() => { });
            }
        } catch (e) {
            console.error('❌ Middleware Fatal Error:', e.message);
            throw e;
        }
    });

    // Liaison des Handlers existants au dispatcher
    setupStartHandler(dispatcher);
    setupOrderSystem(dispatcher);
    setupAdminHandlers(dispatcher);
    
    // Marketplace handlers capture
    const mpHandlers = setupMarketplaceHandlers(dispatcher);
    handleMarketplaceText = mpHandlers.handleMarketplaceText;
    handleMarketplacePhoto = mpHandlers.handleMarketplacePhoto;
    handleMarketplaceVideo = mpHandlers.handleMarketplaceVideo;

    // Initialisation des états persistants
    const { initAdminState } = require('./handlers/admin');
    const { initOrderState } = require('./handlers/order_system');
    
    await Promise.all([
        initOrderState(),
        initAdminState(),
        initMarketplaceState()
    ]);
    console.log('✅ Tous les états persistants sont chargés');

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
            console.error('[POLL-VOTE] Error:', e);
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
                    console.error('[POLL-FREE] Error:', e);
                    await ctx.reply("⚠️ Une erreur est survenue.");
                }
            }
        }
        // Marketplace text handler (flows ajout/édition produit fournisseur)
        const mpResult = handleMarketplaceText(ctx);
        if (mpResult !== false) { await mpResult; return; }

        await next();
    });

    // Marketplace photo handler
    dispatcher.on('photo', async (ctx, next) => {
        console.log(`[Marketplace-Photo] Photo received from ${ctx.from.id}`);
        const mpPhotoResult = handleMarketplacePhoto(ctx);
        if (mpPhotoResult !== false) { 
            console.log(`[Marketplace-Photo] Photo handled by marketplace`);
            await mpPhotoResult; 
            return; 
        }
        await next();
    });

    // Marketplace video handler
    dispatcher.on('video', async (ctx, next) => {
        console.log(`[Marketplace-Video] Video received from ${ctx.from.id}`);
        const mpVideoResult = handleMarketplaceVideo(ctx);
        if (mpVideoResult !== false) { 
            console.log(`[Marketplace-Video] Video handled by marketplace`);
            await mpVideoResult; 
            return; 
        }
        await next();
    });


    // 2. Initialisation des Canaux
    const replicaIndex = process.env.RAILWAY_REPLICA_INDEX || '0';
    if (replicaIndex === '0') {
        console.log('[System] Replica 0: Starting all channels (WA + TG)...');
        await initChannels();
        
        // Background Broadcast Worker
        const { processPendingBroadcasts } = require('./services/broadcast');
        const bcInterval = 15000;
        
        // Execute immediately on startup, then every 15s
        const runBcWorker = async () => {
            try {
                await processPendingBroadcasts();
            } catch (e) {
                console.error('[BC-WORKER-ERR] Loop error:', e.message);
            }
        };
        runBcWorker();
        setInterval(runBcWorker, bcInterval);
        console.log('👷 Broadcast Worker active (Replica 0)');
    } else {
        console.log(`[System] Replica ${replicaIndex}: Bot background channels disabled to avoid conflicts.`);
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
        // Removed duplicate checkScheduledBroadcasts - handled by Replica 0 worker in broadcast.js
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
        console.error('❌ Error checkPlannedOrders:', e.message);
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
        const { supabase, COL_BROADCASTS, COL_USERS } = require('./services/database'); // Added COL_USERS
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
    } catch (e) { console.error('❌ Error checkScheduledBroadcasts:', e.message); }
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
        
        console.log(`[Sync] Starting sync for ${users.length} users...`);
        
        // Process in batches of 20 to avoid rate limits and event loop blocking
        const batchSize = 20;
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
                            console.log(`[Sync] User ${u.id} reachable again, unblocking.`);
                        }
                    } catch (err) {
                        // 403 = l'utilisateur a bloqué le bot
                        if (err.code === 403) {
                            // On ne re-marque bloqué QUE s'il ne l'est pas déjà
                            if (!u.is_blocked) {
                                await markUserBlocked(u.id, false);
                                console.log(`[Sync] User ${u.id} blocked the bot.`);
                            }
                        }
                    }
                } catch (e) { }
            }));
            await new Promise(r => setTimeout(r, 500));
        }
        console.log(`[Sync] Finished sync for ${users.length} users.`);
    } catch (e) {
        console.error('❌ Error runAutomatedSync:', e.message);
    }
}

main().catch(console.error);
