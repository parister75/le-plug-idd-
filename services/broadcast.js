const { getAllUsersForBroadcast, saveBroadcast, updateBroadcast, markUserBlocked, getPendingBroadcasts, claimBroadcast } = require('./database');
const { registry } = require('../channels/ChannelRegistry');
const { dispatcher } = require('./dispatcher');
const fs = require('fs');
const path = require('path');

function ts() { return new Date().toISOString(); }

function debugLog(msg) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}\n`;
    try {
        fs.appendFileSync(path.join(process.cwd(), 'debug_shop.log'), line);
    } catch (e) { }
    console.log(msg);
}

// Configuration des délais
const CONCURRENCY_LIMIT = 10; // On augmente pour compenser les latences DB/Réseau
const BATCH_DELAY_MS = 100; // Délai réduit entre chaque envoi individuel
const TELEGRAM_TIMEOUT_MS = 15000; // Timeout de 15s par requête

let _bot = null;
function setBroadcastBot(bot) { 
    _bot = bot; 
    debugLog(`[BC-SERVICE] Bot Telegram lié à la diffusion.`);
}

/**
 * Attend que le bot soit prêt avant de lancer la diffusion
 */
async function _waitForReady() {
    let attempts = 0;
    while (!_bot && attempts < 10) {
        debugLog(`[BC-WAIT] En attente du bot Telegram... (essai ${attempts + 1}/10)`);
        await new Promise(r => setTimeout(r, 2000));
        attempts++;
    }
    return !!_bot;
}

function _isBroadcastPrivileged(user) {
    if (user?.is_livreur) return true;
    const cleanId = String(user?.platform_id || '').match(/\d+/g)?.[0] || '';
    const adminIds = String(process.env.ADMIN_TELEGRAM_ID || '').match(/\d+/g) || [];
    return adminIds.includes(cleanId);
}

async function broadcastMessage(platform, message, options = {}) {
    const {
        mediaFiles = [],
        mediaUrls: existingUrls = [],
        start_at = ts(),
        end_at = null,
        badge = null,
        poll_options = null,
        poll_allow_free = false
    } = options;

    let finalMessage = message;
    let finalMediaUrls = [...existingUrls];

    // --- NOUVEAU: Support du format stocké (message|||MEDIA_URLS|||json) ---
    if (message && typeof message === 'string' && message.includes('|||MEDIA_URLS|||')) {
        const parts = message.split('|||MEDIA_URLS|||');
        finalMessage = parts[0];
        try {
            const extraUrls = JSON.parse(parts[1]);
            if (Array.isArray(extraUrls)) {
                finalMediaUrls = [...finalMediaUrls, ...extraUrls];
            }
        } catch (e) {
            debugLog(`[BC-PARSE-ERR] ${e.message}`);
        }
    }

    debugLog(`[BC-START] Plateforme: ${platform}, Médias: ${mediaFiles.length}, URLs: ${finalMediaUrls.length}, Message: "${(finalMessage || '').substring(0, 30)}..."`);

    // Récupérer toutes les cibles (users + groups)
    // S'assurer que le bot est prêt (évite race condition au reboot)
    const isReady = await _waitForReady();
    if (!isReady) {
        debugLog(`[BC-ERROR] Impossible de lancer la diffusion: Bot non prêt après 20s.`);
        return { success: 0, failed: 0, blocked: 0, total: 0 };
    }

    let bType = null;
    if (platform === 'users') bType = 'user';
    else if (platform === 'groups') bType = 'group';
    else if (platform === 'livreurs') bType = 'livreurs';

    // On récupère TOUTES les cibles sans filtrer par plateforme pour être sûr de n'oublier personne
    // Et si on cible les 'users', on prend tout ce qui n'est pas un groupe (pour inclure les types non définis)
    // NOUVEAU: On utilise getAllUsersForBroadcast pour inclure aussi les utilisateurs bloqués
    const targets = await getAllUsersForBroadcast(null, bType);
    const totalTargets = targets.length;
    debugLog(`[BC-TARGETS] ${totalTargets} cibles trouvées (Argument Platform: ${platform}, InternalType: ${bType}).`);

    // --- NOUVEAU : Vérification de la planification ---
    const now = new Date();
    const startTime = new Date(start_at);
    const isFuture = startTime > now;

    if (totalTargets === 0) {
        return { success: 0, failed: 0, blocked: 0, total: 0 };
    }

    // 1. Normalisation des URLs existantes envoyées par options OU extraites supra
    const normalizedExistingUrls = finalMediaUrls.map(u => {
        if (typeof u === 'string') {
            const isVideo = u.match(/\.(mp4|mov|avi|wmv|webm|mkv)(\?.*)?$/i);
            const type = isVideo ? 'video' : 'photo';
            return { url: u, type };
        }
        return u;
    });
    const unifiedMediaList = [...normalizedExistingUrls];
    const { uploadMediaBuffer } = require('./database');
    
    for (let f of mediaFiles) {
        try {
            const extension = f.mimetype.includes('video') ? 'mp4' : (f.mimetype.includes('png') ? 'png' : 'jpg');
            const fileName = `bc-${Date.now()}-${Math.round(Math.random() * 1E9)}-${f.name.replace(/[^a-zA-Z0-9.\-_]/g, '')}`;
            const finalPath = fileName.match(/\.[a-zA-Z0-9]+$/) ? fileName : `${fileName}.${extension}`;

            let fileBuffer = f.data;
            if (!fileBuffer && f.tempFilePath) {
                fileBuffer = fs.readFileSync(f.tempFilePath);
            }

            if (!fileBuffer || fileBuffer.length === 0) {
                debugLog(`[BC-UPLOAD-SKIP] Buffer vide pour ${f.name}`);
                continue;
            }

            const publicUrl = await uploadMediaBuffer(fileBuffer, finalPath, f.mimetype);
            if (publicUrl) {
                unifiedMediaList.push({ 
                    url: publicUrl, 
                    source: !publicUrl ? fileBuffer : null,
                    type: f.mimetype.includes('video') ? 'video' : 'photo' 
                });
            } else {
                debugLog(`[BC-UPLOAD-WARN] Pas d'URL retournée pour ${f.name}. Fallback to buffer.`);
                unifiedMediaList.push({ source: fileBuffer, filename: f.name, type: f.mimetype.includes('video') ? 'video' : 'photo' });
            }
        } catch (e) {
            debugLog(`[BC-UPLOAD-ERR] ${e.message}`);
            let fallbackBuffer = f.data;
            try { if (!fallbackBuffer && f.tempFilePath) fallbackBuffer = fs.readFileSync(f.tempFilePath); } catch (err) { }
            unifiedMediaList.push({ source: fallbackBuffer, filename: f.name, type: f.mimetype.includes('video') ? 'video' : 'photo' });
        }
    }

    // 2. Init log en DB — on garde URL + type pour pouvoir afficher correctement
    const mediaUrlsJson = JSON.stringify(unifiedMediaList.filter(m => m.url).map(m => ({ url: m.url, type: m.type || 'photo' })));
    const finalMessageStr = message ? message : `[Médias: ${unifiedMediaList.length}]`;
    const payloadMessage = `${finalMessageStr}|||MEDIA_URLS|||${mediaUrlsJson}`;

    let broadcastId = options.id;
    if (!broadcastId) {
        broadcastId = await saveBroadcast({
            message: payloadMessage,
            media_count: unifiedMediaList.length,
            total_target: totalTargets,
            target_platform: platform,
            status: isFuture ? 'pending' : 'in_progress',
            success: 0, failed: 0, blocked: 0,
            start_at,
            end_at,
            badge,
            poll_data: (poll_options && typeof poll_options === 'string') ? { 
                options: poll_options.split('|'), 
                title: message, 
                poll_allow_free: options.poll_allow_free || false 
            } : null
        });
    } else {
        // Déjà un ID (venant du worker), on est déjà passé par checkPending
        // Mais par sécurité on s'assure qu'il est bien in_progress
        if (!isFuture) {
            await updateBroadcast(broadcastId, { status: 'in_progress' });
        }
    }

    if (isFuture) {
        debugLog(`[BC-SCHEDULED] Diffusion ${broadcastId} planifiée pour ${start_at}.`);
        return { success: 0, failed: 0, blocked: 0, total: totalTargets, scheduled: true, broadcastId };
    }

    let successCount = 0;
    let failedCount = 0;
    let newlyBlockedCount = 0;
    let previouslyBlockedCount = 0;
    const newlyBlockedNames = [];

    // Déduplication et filtrage des cibles éligibles
    const seenPlatformIds = new Set();
    const eligibleTargets = targets.filter(u => {
        if (u.is_blocked) {
            previouslyBlockedCount++;
            return false;
        }
        const pid = String(u.platform_id || '').replace(/^(telegram_|whatsapp_)/, '');
        if (seenPlatformIds.has(pid)) return false;
        seenPlatformIds.add(pid);
        return true;
    });

    const totalToProcess = eligibleTargets.length;
    debugLog(`[BC-READY] ${totalToProcess} cibles éligibles pour l'envoi.`);

    // --- ENVOI SEQUENTIEL AVEC CONCURRENCE LIMITÉE ---
    const { default: pLimit } = await import('p-limit');
    const limit = pLimit(CONCURRENCY_LIMIT);

    const tasks = eligibleTargets.map((user, index) => limit(async () => {
        // Décalage fixe entre les débuts de tâches pour lisser l'envoi
        // (moins gourmand en mémoire qu'un décalage cumulatif sur 1000 users)
        const jitter = Math.floor(Math.random() * 100);
        await new Promise(r => setTimeout(r, BATCH_DELAY_MS + jitter));

        const res = await sendToUser(user, finalMessage, unifiedMediaList, { ...options, broadcastId });
        
        if (res.success) {
            successCount++;
        } else {
            if (res.blocked) {
                newlyBlockedCount++;
                newlyBlockedNames.push(user.first_name || user.platform_id);
            } else {
                failedCount++;
            }
        }

        // Mise à jour régulière du statut en DB toutes les 10 cibles pour feedback dashboard
        if ((successCount + failedCount + newlyBlockedCount) % 10 === 0) {
            await updateBroadcast(broadcastId, {
                success: successCount,
                failed: failedCount,
                blocked: newlyBlockedCount + previouslyBlockedCount
            }).catch(() => {});
        }
    }));

    await Promise.allSettled(tasks);

    // Finaliser log en DB
    const finalBlockedCount = newlyBlockedCount + previouslyBlockedCount;
    await updateBroadcast(broadcastId, {
        status: 'completed',
        success: successCount,
        failed: failedCount,
        blocked: finalBlockedCount,
        previously_blocked: previouslyBlockedCount,
        blocked_names: newlyBlockedNames.length > 0 ? newlyBlockedNames.join(', ') : null,
        completed_at: ts()
    }).catch(e => debugLog(`[BC-LOG-ERR] ${e.message}`));

    debugLog(`[BC-END] Terminé. Succès: ${successCount}, Échecs: ${failedCount}, Total Bloqués: ${finalBlockedCount}`);
    return { success: successCount, failed: failedCount, blocked: finalBlockedCount, total: totalTargets, broadcastId };
}

async function sendToUser(user, message, unifiedMediaList = [], options = {}) {
    // 1. Déterminer le canal — détecter WhatsApp même si platform est "telegram" en DB
    let platform = user.platform || 'telegram';
    const pid = String(user.platform_id || '');
    
    // Si le platform_id contient @ c'est un ID WhatsApp (ex: 108388298051671@lid)
    if (pid.includes('@')) {
        platform = 'whatsapp';
    }
    
    const channel = registry.query(platform);
    
    // Si c'est WhatsApp (ou autre que Telegram), on utilise l'interface unifiée
    if (platform !== 'telegram') {
        if (!channel || !channel.isActive) {
            debugLog(`[BC-SKIP] Canal ${platform} inactif ou non trouvé pour ${user.platform_id}`);
            return { success: false, error: "Canal inactif" };
        }

        const buttons = options.poll_options ? options.poll_options.split('|').map((opt, idx) => ({
            id: `poll_vote_${options.broadcastId}_${idx}`,
            title: opt
        })) : [];

        // Nettoyer le platform_id (enlever le prefixe telegram_ ou whatsapp_)
        const cleanPid = pid.replace(/^(telegram_|whatsapp_)/, '');

        try {
            if (buttons.length > 0) {
                const m0 = unifiedMediaList[0] || {};
                let mediaUrl = m0.url || null;
                // Résolution chemin local si relatif
                if (mediaUrl && !mediaUrl.startsWith('http') && mediaUrl.includes('/')) {
                    const abs = path.resolve(process.cwd(), mediaUrl.startsWith('/') ? mediaUrl.substring(1) : mediaUrl);
                    if (fs.existsSync(abs)) mediaUrl = abs;
                }

                // Hydrater le cache du dispatcher pour le fallback numérique WA
                if (buttons.length > 0) {
                    dispatcher.setUserLastButtons(pid, buttons);
                }

                await channel.sendInteractive(cleanPid, message, buttons, {
                    media_url: mediaUrl,
                    media_type: m0.type || 'photo'
                });
            } else {
                // WhatsApp: Chaque média s'il y en a plusieurs
                if (unifiedMediaList.length > 1) {
                    for (let i = 0; i < unifiedMediaList.length; i++) {
                        const m = unifiedMediaList[i];
                        const cap = (i === 0) ? message : "";
                        let mediaUrl = m.url || null;
                        
                        if (mediaUrl && !mediaUrl.startsWith('http') && mediaUrl.includes('/')) {
                            const abs = path.resolve(process.cwd(), mediaUrl.startsWith('/') ? mediaUrl.substring(1) : mediaUrl);
                            if (fs.existsSync(abs)) mediaUrl = abs;
                        }

                        await channel.sendMessage(cleanPid, cap, { 
                            media_url: mediaUrl, 
                            media_type: m.type,
                            source: m.source || null 
                        });
                        await new Promise(r => setTimeout(r, 500));
                    }
                } else {
                    const m = unifiedMediaList[0];
                    let mediaUrl = m?.url || null;

                    if (mediaUrl && !mediaUrl.startsWith('http') && mediaUrl.includes('/')) {
                        const abs = path.resolve(process.cwd(), mediaUrl.startsWith('/') ? mediaUrl.substring(1) : mediaUrl);
                        if (fs.existsSync(abs)) mediaUrl = abs;
                    }

                    await channel.sendMessage(cleanPid, message, { 
                        media_url: mediaUrl, 
                        media_type: m?.type || 'photo',
                        source: m?.source || null
                    });
                }
            }
            return { success: true };
        } catch (err) {
            debugLog(`[BC-ERR-WA] ${cleanPid}: ${err.message}`);
            return { success: false, error: err.message };
        }
    }

    // 2. Logique spécifique Telegram (existante)
    if (!_bot) {
        debugLog("[BC-ERROR] Bot Telegram non initialisé");
        return { success: false, error: "Bot non prêt" };
    }

    const { Markup } = require('telegraf');
    const poll_options = (options.poll_options && typeof options.poll_options === 'string') 
        ? options.poll_options.split('|') 
        : null;
    const poll_allow_free = options.poll_allow_free || false;
    const broadcastId = options.broadcastId;

    let keyboard = null;
    if (poll_options && poll_options.length > 0) {
        const btns = poll_options.map((opt, idx) => [Markup.button.callback(opt, `poll_vote_${broadcastId}_${idx}`)]);
        if (poll_allow_free) {
            btns.push([Markup.button.callback('🖊 Réponse libre', `poll_free_${broadcastId}`)]);
        }
        keyboard = Markup.inlineKeyboard(btns);
    }

    // On nettoie le chatId pour Telegram (retirer le préfixe 'telegram_' si présent)
    const chatId = String(user.platform_id || '').replace('telegram_', '');
    const _protect = !_isBroadcastPrivileged(user);
    // Captions are limited to 1024 chars in Telegram
    const maxCaption = 1020;
    const caption = message ? (message.length > maxCaption ? message.substring(0, maxCaption - 3) + '...' : message) : '';

    // Helper function for safe send with fallback and TOUGH TIMEOUT
    const safeSend = async (method, ...args) => {
        const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout API Telegram')), ms));
        
        const execute = async () => {
            try {
                // First attempt: HTML
                return await _bot.telegram[method](chatId, ...args, { parse_mode: 'HTML' });
            } catch (err) {
                const desc = (err.description || '').toLowerCase();
                if (desc.includes('can\'t parse entities') || desc.includes('bad request')) {
                    debugLog(`[BC-RETRY] Fallback to Plain text for ${chatId} (${method})`);
                    return await _bot.telegram[method](chatId, ...args);
                }
                throw err;
            }
        };

        return await Promise.race([execute(), timeout(TELEGRAM_TIMEOUT_MS)]);
    };
    try {
        if (unifiedMediaList.length > 1) {
            const mediaGroup = unifiedMediaList.slice(0, 10).map((m, i) => {
                let mediaObj = m.file_id;
                if (!mediaObj) {
                    if (m.source) {
                        mediaObj = { source: m.source, filename: m.filename || 'media.mp4' };
                    } else if (m.url) {
                        mediaObj = m.url;
                    }
                }
                return {
                    type: m.type,
                    media: mediaObj,
                    ...(m.type === 'video' ? { supports_streaming: true } : {}),
                    ...(i === 0 && caption ? { caption: caption } : {})
                };
            });

            debugLog(`[BC-SEND] MediaGroup (${mediaGroup.length}) -> ${chatId}`);
            if (mediaGroup[0] && mediaGroup[0].caption) {
                mediaGroup[0].parse_mode = 'HTML';
            }

            const mgOpts = _protect ? { protect_content: true } : {};
            let msgs;
            try {
                msgs = await _bot.telegram.sendMediaGroup(chatId, mediaGroup, mgOpts);
            } catch (err) {
                if (err.description?.includes('can\'t parse entities') && mediaGroup[0]) {
                    delete mediaGroup[0].parse_mode;
                    msgs = await _bot.telegram.sendMediaGroup(chatId, mediaGroup, mgOpts);
                } else throw err;
            }

            // Cache file_ids & Tracking
            if (msgs && Array.isArray(msgs)) {
                const { addMessageToTrack } = require('./database');
                for (const msg of msgs) {
                    await addMessageToTrack(user.id || user.doc_id, msg.message_id, false).catch(() => { });
                }

                msgs.forEach((msg, i) => {
                    if (!unifiedMediaList[i].file_id) {
                        let fId = null;
                        if (msg.photo && msg.photo.length > 0) fId = msg.photo[msg.photo.length - 1].file_id;
                        else if (msg.video) fId = msg.video.file_id;
                        if (fId) unifiedMediaList[i].file_id = fId;
                    }
                });
            }
        } else if (unifiedMediaList.length === 1) {
            const mData = unifiedMediaList[0];
            let mediaObj = mData.file_id;
            if (!mediaObj) {
                if (mData.source) mediaObj = { source: mData.source, filename: mData.filename || 'media.mp4' };
                else if (mData.url) mediaObj = mData.url;
            }

            debugLog(`[BC-SEND] Single ${mData.type.toUpperCase()} -> ${chatId}`);
            let msg;
            if (mData.type === 'video') {
                msg = await safeSend('sendVideo', mediaObj, { caption: caption, supports_streaming: true, ...(_protect ? { protect_content: true } : {}), ...(keyboard ? keyboard : {}) });
                if (msg.video && !mData.file_id) mData.file_id = msg.video.file_id;
            } else {
                msg = await safeSend('sendPhoto', mediaObj, { caption: caption, ...(_protect ? { protect_content: true } : {}), ...(keyboard ? keyboard : {}) });
                if (msg.photo && !mData.file_id) mData.file_id = msg.photo[msg.photo.length - 1].file_id;
            }
            if (msg && (user.id || user.doc_id)) {
                const { addMessageToTrack } = require('./database');
                await addMessageToTrack(user.id || user.doc_id, msg.message_id, false).catch(() => { });
            }
        } else {
            // Texte uniquement
            debugLog(`[BC-SEND] Texte -> ${chatId}`);
            if (!message || message.trim() === '') {
                debugLog(`[BC-SKIP] Message vide pour ${chatId}`);
                return { success: true }; // On skip les messages vides sans erreur
            }
            try {
                const msg = await _bot.telegram.sendMessage(chatId, message, { parse_mode: 'HTML', ...(_protect ? { protect_content: true } : {}), ...(keyboard ? keyboard : {}) });
                if (msg && (user.id || user.doc_id)) {
                    const { addMessageToTrack } = require('./database');
                    await addMessageToTrack(user.id || user.doc_id, msg.message_id, false).catch(() => { });
                }
            } catch (err) {
                if (err.description?.includes('can\'t parse entities')) {
                    debugLog(`[BC-RETRY] Plain text fallback for: ${chatId}`);
                    const msg = await _bot.telegram.sendMessage(chatId, message, { ...(_protect ? { protect_content: true } : {}), ...(keyboard ? keyboard : {}) });
                    if (msg && (user.id || user.doc_id)) {
                        const { addMessageToTrack } = require('./database');
                        await addMessageToTrack(user.id || user.doc_id, msg.message_id, false).catch(() => { });
                    }
                } else throw err;
            }
        }
        return { success: true };
    } catch (error) {
        const desc = (error.description || error.message || "Erreur inconnue").toLowerCase();
        const errorName = error.name || "Error";
        const code = error.code || 0;

        debugLog(`[BC-ERROR] Cible ${chatId}: [${errorName}] ${desc} (Code: ${code})`);

        // Liste exhaustive des erreurs indiquant un blocage ou un bot supprimé
        const isBlockedError = code === 403 ||
            desc.includes('blocked') ||
            desc.includes('chat not found') ||
            desc.includes('kicked') ||
            desc.includes('user is deactivated') ||
            desc.includes('forbidden');

        if (isBlockedError) {
            if (user.id || user.doc_id) {
                const { markUserBlocked } = require('./database');
                await markUserBlocked(user.id || user.doc_id, false).catch(e => {
                    debugLog(`[BC-MARK-ERR] Failed to mark ${chatId} as blocked: ${e.message}`);
                });
            }
            return { success: false, blocked: true, error: desc };
        }
        return { success: false, error: desc };
    }
}

let isProcessing = false;
async function processPendingBroadcasts() {
    if (isProcessing) return;
    isProcessing = true;
    try {
        const pendings = await getPendingBroadcasts();
        if (pendings.length === 0) {
            isProcessing = false;
            return;
        }

        debugLog(`[BC-WORKER] ${pendings.length} diffusions trouvées.`);
        for (const bc of pendings) {
            // Marquage ATOMIQUE en DB pour éviter TOUT doublon entre instances
            const claimed = await claimBroadcast(bc.id);
            if (!claimed) continue;

            const pollOpts = bc.poll_data?.options ? bc.poll_data.options.join('|') : null;
            // On lance la diffusion
            await broadcastMessage(bc.target_platform, bc.message || "", { 
                id: bc.id,
                start_at: bc.start_at,
                poll_options: pollOpts
            });
        }
    } catch (e) {
        debugLog(`[BC-WORKER-ERR] ${e.message}`);
    } finally {
        isProcessing = false;
    }
}

module.exports = { broadcastMessage, setBroadcastBot, processPendingBroadcasts };
