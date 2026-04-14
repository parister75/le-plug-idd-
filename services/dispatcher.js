const { registry } = require('../channels/ChannelRegistry');
const { registerUser, getAppSettings, markUserBlocked, markUserUnblocked, addMessageToTrack } = require('./database');
const { createPersistentMap } = require('./persistent_map');
const { waLog } = require('./wa_log_shared');

class Dispatcher {
    constructor() {
        this.commands = new Map();
        this.actions = new Map();
        this.middleware = [];
        this.onHandlers = [];
        this.catchHandler = null;
        this.userLastButtons = createPersistentMap('userLastButtons'); 
        this.userLastMessageIds = createPersistentMap('userLastMessageIds');
        this.processedMessages = new Set(); // Pour éviter les doublons de Baileys
    }

    // Normalise les IDs utilisateurs (surtout WhatsApp : retire le suffixe de session :1, :2...)
    _normalizeId(id, platform = null) {
        if (!id) return id;
        let s = String(id).replace(/^(telegram_|whatsapp_)/, '');
        
        // Supprimer les suffixes de session (:1, :2)
        s = s.split(':')[0];

        if (s.includes('@s.whatsapp.net') || s.includes('@lid')) {
            return s;
        }

        // Pour les IDs numériques purs venant de WhatsApp via notifications.js
        if (platform === 'whatsapp' || (!platform && s.length >= 8 && /^\d+$/.test(s) && !s.includes('@'))) {
            return s + '@s.whatsapp.net';
        }
        return s;
    }

    async init() {
        await this.userLastButtons.load();
        await this.userLastMessageIds.load();
    }

    // Permet aux fonctions externes (notifyUser) d'enregistrer des boutons pour le fallback numérique WA
    setUserLastButtons(userId, buttons) {
        const id = this._normalizeId(userId);
        if (buttons && buttons.length > 0) {
            console.log(`[Dispatcher] setLastButtons for ${id}: ${JSON.stringify(buttons.map(b => b.id || (b.web_app ? 'WebApp' : 'Text')))}`);
            this.userLastButtons.set(id, buttons);
        } else {
            console.log(`[Dispatcher] Clearing buttons for ${id}`);
            this.userLastButtons.delete(id);
        }
    }

    // --- Interface pour simuler Telegraf ---
    use(fn) { this.middleware.push(fn); }
    command(cmd, fn) { this.commands.set(cmd, fn); }
    action(trigger, fn) { this.actions.set(trigger, fn); }
    on(types, fn) {
        const typeArray = Array.isArray(types) ? types : [types];
        for (const t of typeArray) {
            this.onHandlers.push({ type: t, fn });
        }
    }
    catch(fn) { this.catchHandler = fn; }

    // --- Gestion des messages entrants ---
    async handleUpdate(channel, msg) {
        // 0. Dé-duplication (Baileys envoie parfois plusieurs fois le même message)
        const msgId = msg.message_id || msg.rawId;
        if (msgId && this.processedMessages.has(msgId)) {
            console.log(`[Dispatcher] Ignored duplicate message: ${msgId}`);
            return;
        }
        if (msgId) {
            this.processedMessages.add(msgId);
            if (this.processedMessages.size > 500) {
                const first = this.processedMessages.values().next().value;
                this.processedMessages.delete(first);
            }
        }

        const fromRaw = String(msg.from || '');
        const userId = this._normalizeId(fromRaw, channel.type);
        const isCallback = !!msg.isAction;

        try {
            const settings = await getAppSettings();
            msg._settings = settings;

            if (isCallback) {
                // Callback = user déjà connu → charger user cache
                const docId = `${channel.type}_${userId}`;
                
                // Try from cache
                let entry = require('./database')._userCache?.get(docId);
                let registeredUser = entry?.data || null;
                
                // If not in cache, try from DB
                if (!registeredUser) {
                    const { getUser } = require('./database');
                    const dbUser = await getUser(userId, channel.type);
                    registeredUser = dbUser;
                }
                
                msg.user = registeredUser;
                msg._isNewUser = false;
            } else {
                // Message normal → enregistrer l'utilisateur
                const { isNew, user: registeredUser } = await registerUser({
                    id: userId,
                    first_name: msg.name || settings.default_wa_name || 'Utilisateur WhatsApp',
                    username: '',
                    type: 'user'
                }, channel.type);

                msg.user = registeredUser;
                msg._isNewUser = isNew;
            }
        } catch (e) {
            console.error(`[Dispatcher] Auto-reg failed: ${e.message}`);
        }

        // Uniformisation du contexte
        const ctx = await this._createUnifiedContext(channel, msg, userId);
        
        try {
            // 1. Exécuter les middlewares
            let index = -1;
            const next = async () => {
                index++;
                if (index < this.middleware.length) {
                    await this.middleware[index](ctx, next);
                } else {
                    // 3. Gestion des approbations (STRICT)
                    const registeredUser = ctx.state.user;
                    const isApproved = registeredUser?.is_approved !== false || registeredUser?.is_livreur === true || (await require('../handlers/admin').isAdmin(ctx));

                    const isStartCommand = ctx.message?.text?.startsWith('/start') || ctx.message?.text?.toLowerCase() === 'start';
                    const isPermittedAction = ctx.callbackQuery && [
                        'check_sub', 'refresh_status', 'help_menu', 'help_chat_admin', 'user_chat_reply_admin', 'cancel_user_support'
                    ].some(a => ctx.callbackQuery.data === a || 
                        ctx.callbackQuery.data.startsWith('approve_') || 
                        ctx.callbackQuery.data.startsWith('poll_vote_') || 
                        ctx.callbackQuery.data.startsWith('poll_free_') ||
                        ctx.callbackQuery.data.startsWith('feedback_rate_') ||
                        ctx.callbackQuery.data.startsWith('review_rate_') ||
                        ctx.callbackQuery.data.startsWith('order_view_')
                    );

                    // Permettre les messages si une session de support est en cours (même si non approuvé)
                    const { activeUserSessions, awaitingUserSupportReply } = require('../handlers/admin');
                    const uKey = `${ctx.platform}_${this._normalizeId(ctx.from.id, ctx.platform)}`;
                    const isSupportSession = activeUserSessions.has(uKey) || awaitingUserSupportReply.has(uKey);

                    if (!isApproved && !isStartCommand && !isPermittedAction && !isSupportSession) {
                        if (ctx.callbackQuery) {
                            return ctx.answerCbQuery("🛑 Votre accès est en attente de validation par l'administrateur.", { show_alert: true }).catch(() => { });
                        }
                        
                        // Si message texte sur WhatsApp/Telegram non approuvé -> redirection vers /start (via command handler)
                        if (this.commands.has('start')) {
                            console.log(`[Dispatcher] Redirection user non-approuvé ${ctx.from.id} vers /start`);
                            return await this.commands.get('start')(ctx);
                        }
                        return; // Bloquer
                    }

                    // Gestion des bannissements
                    if (registeredUser && registeredUser.is_blocked) {
                        if (ctx.callbackQuery) {
                            return ctx.answerCbQuery("⛔️ Votre compte est suspendu.", { show_alert: true }).catch(() => { });
                        }
                        return ctx.reply("⛔️ <b>ACCÈS REFUSÉ</b>\n\nVotre compte a été suspendu par l'administration. Contactez le support pour plus d'informations.", { parse_mode: 'HTML' }).catch(() => { });
                    }

                    await this._route(ctx);
                }
            };
            await next();
        } catch (err) {
            console.error(`[Dispatcher] Error:`, err);
            if (this.catchHandler) await this.catchHandler(err, ctx);
        }
    }

    _isPrivilegedUser(userId, user, settings) {
        // Admin ou livreur = pas de protect_content
        if (user?.is_livreur) return true;
        const platformId = String(userId).includes('_') ? userId.split('_').slice(1).join('_') : userId;
        const cleanId = String(platformId).match(/\d+/g)?.[0] || '';
        const adminIds = String(settings?.admin_telegram_id || '').match(/\d+/g) || [];
        const envAdmin = String(process.env.ADMIN_TELEGRAM_ID || '').match(/\d+/g)?.[0] || '';
        const extraAdmins = (Array.isArray(settings?.list_admins) ? settings.list_admins : [])
            .map(id => String(id).match(/\d+/g)?.[0]).filter(Boolean);
        return adminIds.includes(cleanId) || extraAdmins.includes(cleanId) || cleanId === envAdmin;
    }

    async _createUnifiedContext(channel, msg, normalizedFrom) {
        const userId = normalizedFrom || this._normalizeId(msg.from, channel.type);
        // Réutiliser les settings déjà chargées dans handleUpdate pour éviter un 2e appel
        const settings = msg._settings || await getAppSettings();
        
        const _isPrivileged = this._isPrivilegedUser(userId, msg.user, settings);

        const ctx = {
            channel: channel,
            platform: channel.type, // 'telegram' ou 'whatsapp'
            from: { id: userId, first_name: msg.name, username: msg.user?.username || msg.username || '', is_bot: false },
            chat: { id: userId, type: 'private' },
            state: { user: msg.user, settings: settings },
            _handled: false,
            _isPrivileged,
            message: { text: msg.text, photo: msg.photo, video: msg.video, message_id: msg.message_id || msg.rawId },
            updateType: msg.type || 'message',
            match: null,
            botInfo: { username: settings.bot_name || 'Bot' },
            callbackQuery: msg.isAction ? { 
                data: msg.text,
                message: msg.ctx?.callbackQuery?.message || null
            } : null,
            telegram: {
                // Si on a l'instance réelle (Telegram), on l'expose au cas où
                instance: (channel.type === 'telegram' && channel.getBotInstance) ? channel.getBotInstance().telegram : null,
                
                sendMessage: async (id, text, extra = {}) => {
                    const { sendMessageToUser } = require('./notifications');
                    if (String(id) === String(userId)) return ctx.reply(text, extra);
                    return sendMessageToUser(id, text, extra);
                },
                sendPhoto: async (id, photo, extra = {}) => {
                    const { sendMessageToUser } = require('./notifications');
                    if (String(id) === String(userId)) return ctx.replyWithPhoto(photo, extra);
                    return sendMessageToUser(id, extra.caption || "", { ...extra, media_url: photo, media_type: 'photo' });
                },
                sendVideo: async (id, video, extra = {}) => {
                    const { sendMessageToUser } = require('./notifications');
                    if (String(id) === String(userId)) return ctx.replyWithVideo(video, extra);
                    return sendMessageToUser(id, extra.caption || "", { ...extra, media_url: video, media_type: 'video' });
                },
                editMessageText: async (cid, mid, mid2, text, extra = {}) => {
                    if (channel.type === 'telegram') {
                        const tgCh = registry.query('telegram');
                        const tgBot = tgCh?.getBotInstance?.();
                        if (tgBot) return tgBot.telegram.editMessageText(cid || userId, mid, mid2, text, { parse_mode: 'HTML', ...extra });
                    }
                    return ctx.reply(text, extra);
                },
                editMessageMedia: async (cid, mid, mid2, media, extra = {}) => {
                    if (channel.type === 'telegram') {
                        const tgCh = registry.query('telegram');
                        const tgBot = tgCh?.getBotInstance?.();
                        if (tgBot) return tgBot.telegram.editMessageMedia(cid || userId, mid, mid2, media, extra);
                    }
                    return ctx.replyWithPhoto(media.media, { caption: media.caption });
                },
                deleteMessage: async (cid, mid) => {
                    if (channel.type === 'telegram') {
                        const tgCh = registry.query('telegram');
                        const tgBot = tgCh?.getBotInstance?.();
                        if (tgBot) return tgBot.telegram.deleteMessage(cid || userId, mid).catch(() => {});
                    }
                    return channel.deleteMessage(cid || userId, mid);
                },
                sendMediaGroup: async (cid, mediaGroup, opts = {}) => {
                    if (channel.type === 'telegram') {
                        const tgCh = registry.query('telegram');
                        const tgBot = tgCh?.getBotInstance?.();
                        if (tgBot) {
                            if (!_isPrivileged) opts = { ...opts, protect_content: true };
                            return tgBot.telegram.sendMediaGroup(cid || userId, mediaGroup, opts);
                        }
                    }
                    // Fallback pour WhatsApp : envoyer les médias un par un
                    const results = [];
                    for (const m of mediaGroup) {
                        const mediaUrl = typeof m.media === 'string' ? m.media : m.media?.url;
                        if (m.type === 'video') {
                            results.push(await ctx.replyWithVideo(mediaUrl, { caption: m.caption || '' }));
                        } else {
                            results.push(await ctx.replyWithPhoto(mediaUrl, { caption: m.caption || '' }));
                        }
                    }
                    return results;
                },
                setChatMenuButton: async () => {},
                getFileLink: async (fileId) => {
                    if (channel.type === 'telegram') {
                        const tgCh = registry.query('telegram');
                        const tgBot = tgCh?.getBotInstance?.();
                        if (tgBot) return tgBot.telegram.getFileLink(fileId);
                    }
                    throw new Error('getFileLink not available for this platform');
                }
            },

            reply: async (text, extra = {}) => {
                ctx._handled = true;
                // Telegram : protect_content pour les utilisateurs non-privilégiés
                if (channel.type === 'telegram' && !_isPrivileged) {
                    extra = { ...extra, protect_content: true };
                }
                const options = this._convertExtra(extra);
                if (options.buttons) this.setUserLastButtons(userId, options.buttons);
                else if (channel.type === 'whatsapp') this.setUserLastButtons(userId, null); // Clear if no buttons
                
                // Cleanup auto pour WA
                if (channel.type === 'whatsapp') {
                    const oldIds = this.userLastMessageIds.get(userId) || [];
                    console.log(`[WA-Cleanup] Tentative de suppression de ${oldIds.length} messages pour ${userId}`);
                    for(const id of oldIds) {
                        try {
                            await channel.deleteMessage(userId, id);
                        } catch (e) {
                            console.warn(`[WA-Cleanup] Echec suppression ${id}:`, e.message);
                        }
                    }
                    this.userLastMessageIds.delete(userId);
                }

                let res;
                if (options.buttons && options.buttons.length > 0) {
                    res = await channel.sendInteractive(userId, text, options.buttons, options);
                } else {
                    res = await channel.sendMessage(userId, text, options);
                }
                
                if (channel.type === 'whatsapp') {
                    if (!res) {
                        console.error(`[WA-Reply] sendInteractive/sendMessage a retourné undefined pour ${userId} — socket probablement déconnecté.`);
                        return { success: false };
                    }
                    const sentIds = res.sentIds || (res.messageId ? [res.messageId] : []);
                    if (sentIds.length > 0) {
                        this.userLastMessageIds.set(userId, sentIds);
                        console.log(`[WA-Stored] IDs stockés pour ${userId}:`, sentIds);
                    }
                }
                const trackId = res?.message_id || res?.messageId || (res?.sentIds ? res.sentIds[0] : null);
                if (trackId) addMessageToTrack(userId, trackId).catch(() => {});
                return res;
            },
            replyWithHTML: async (text, extra = {}) => ctx.reply(text, { ...extra, parse_mode: 'HTML' }),
            replyWithPhoto: async (photo, extra = {}) => {
                ctx._handled = true;
                if (channel.type === 'telegram' && !_isPrivileged) {
                    extra = { ...extra, protect_content: true };
                }
                const options = this._convertExtra(extra);
                if (options.buttons) this.setUserLastButtons(userId, options.buttons);
                else if (channel.type === 'whatsapp') this.setUserLastButtons(userId, null);
                
                if (channel.type === 'whatsapp') {
                    const oldIds = this.userLastMessageIds.get(userId) || [];
                    for(const id of oldIds) await channel.deleteMessage(userId, id);
                }

                let res;
                if (options.buttons && options.buttons.length > 0) {
                    res = await channel.sendInteractive(userId, extra.caption || "", options.buttons, { ...options, media_url: photo, media_type: 'photo' });
                } else {
                    res = await channel.sendMessage(userId, extra.caption || "", { ...options, media_url: photo, media_type: 'photo' });
                }

                if (channel.type === 'whatsapp' && res.sentIds) this.userLastMessageIds.set(userId, res.sentIds);
                else if (channel.type === 'whatsapp' && res.messageId) this.userLastMessageIds.set(userId, [res.messageId]);
                
                const trackId = res?.message_id || res?.messageId || (res?.sentIds ? res.sentIds[0] : null);
                if (trackId) addMessageToTrack(userId, trackId).catch(() => {});
                return res;
            },
            replyWithVideo: async (video, extra = {}) => {
                ctx._handled = true;
                if (channel.type === 'telegram' && !_isPrivileged) {
                    extra = { ...extra, protect_content: true };
                }
                const options = this._convertExtra(extra);
                if (options.buttons) this.setUserLastButtons(userId, options.buttons);
                else if (channel.type === 'whatsapp') this.setUserLastButtons(userId, null);
                
                if (channel.type === 'whatsapp') {
                    const oldIds = this.userLastMessageIds.get(userId) || [];
                    for(const id of oldIds) await channel.deleteMessage(userId, id);
                }

                let res;
                if (options.buttons && options.buttons.length > 0) {
                    res = await channel.sendInteractive(userId, extra.caption || "", options.buttons, { ...options, media_url: video, media_type: 'video' });
                } else {
                    res = await channel.sendMessage(userId, extra.caption || "", { ...options, media_url: video, media_type: 'video' });
                }

                if (channel.type === 'whatsapp' && res.sentIds) this.userLastMessageIds.set(userId, res.sentIds);
                else if (channel.type === 'whatsapp' && res.messageId) this.userLastMessageIds.set(userId, [res.messageId]);
                
                const trackId = res?.message_id || res?.messageId || (res?.sentIds ? res.sentIds[0] : null);
                if (trackId) addMessageToTrack(userId, trackId).catch(() => {});
                return res;
            },
            answerCbQuery: async (text) => {
                console.log(`[CB-Answer] ${text || ''}`);
                // Utiliser le vrai answerCbQuery Telegraf si disponible
                if (msg.ctx?.answerCbQuery) {
                    return msg.ctx.answerCbQuery(text).catch(() => {});
                }
                return true;
            },
            deleteMessage: async (mid) => {
                const targetMid = mid || ctx.message?.message_id;
                if (!targetMid) return false;
                
                if (channel.type === 'whatsapp') return channel.deleteMessage(userId, targetMid);
                if (channel.type === 'telegram') {
                    const tgCh = registry.query('telegram');
                    const tgBot = tgCh?.getBotInstance?.();
                    if (tgBot) return tgBot.telegram.deleteMessage(userId, targetMid).catch(() => {});
                }
                return true;
            },
            editMessageText: async (text, extra = {}) => {
                ctx._handled = true;
                if (channel.type === 'telegram' && ctx.callbackQuery?.message) {
                    const tgCh = registry.query('telegram');
                    const tgBot = tgCh?.getBotInstance?.();
                    if (tgBot) {
                        try {
                            return await tgBot.telegram.editMessageText(userId, ctx.callbackQuery.message.message_id, null, text, { parse_mode: 'HTML', ...extra });
                        } catch (e) {
                            if (!String(e.description || '').includes('not modified')) console.warn('[Dispatcher] editMessageText failed:', e.message);
                        }
                    }
                }
                return ctx.reply(text, extra);
            }
        };

        return ctx;
    }

    _convertExtra(extra) {
        const options = {};
        let buttons = [];

        if (extra.reply_markup) {
            if (extra.reply_markup.inline_keyboard) {
                buttons = extra.reply_markup.inline_keyboard;
            } else if (extra.reply_markup.keyboard) {
                buttons = extra.reply_markup.keyboard.flat();
            }
        } else if (extra.inline_keyboard) {
            buttons = extra.inline_keyboard;
        }

        if (buttons.length > 0) {
            // If buttons is a 2D array (inline_keyboard), flatten it for processing
            const processedButtons = Array.isArray(buttons[0]) ? buttons.flat() : buttons;

            options.buttons = processedButtons.map(b => ({
                id: b.callback_data,
                title: b.text,
                url: b.url,
                web_app: b.web_app
            }));
            console.log(`[Dispatcher] Extracted ${options.buttons.length} buttons`);
        }

        if (extra.parse_mode === 'HTML') options.parse_mode = 'HTML';
        if (extra.video) {
            options.media_url = extra.video;
            options.media_type = 'video';
        } else if (extra.photo) {
            options.media_url = extra.photo;
            options.media_type = 'photo';
        }
        if (extra.caption) options.caption = extra.caption;
        if (extra.protect_content) options.protect_content = true;
        return options;
    }

    async _route(ctx) {
        const userId = ctx.from.id;
        const msg = ctx.message || {};
        const text = msg.text || ctx.text || '';
        const lowerText = text.toLowerCase().trim();
        const platform = ctx.platform.toUpperCase();
        console.log(`\n====== [${platform}] NOUVEAU MESSAGE ======`);
        console.log(`[${platform}] De: ${userId} | Texte: "${text}" | Est un bouton: ${!!ctx.callbackQuery}`);

        // 1. Gestion des CALLBACKS (Boutons Telegram & Actions WhatsApp)
        if (ctx.callbackQuery) {
            const data = ctx.callbackQuery.data;
            console.log(`[Dispatcher-CB] Bouton détecté: "${data}" (User: ${userId})`);
            const found = await this._routeAction(ctx, data);
            if (found) {
                console.log(`[${platform}] ✅ Handler trouvé et exécuté pour: "${data}"`);
            } else {
                console.log(`[${platform}] ❌ AUCUN handler pour le bouton: "${data}" — bouton non enregistré!`);
            }
            return;
        }

        // 2. Commande explicite /cmd
        if (text.startsWith('/')) {
            const cmd = text.split(' ')[0].substring(1);
            console.log(`[Dispatcher] Checking command: "/${cmd}" (Available: ${Array.from(this.commands.keys()).join(', ')})`);
            if (this.commands.has(cmd)) {
                console.log(`[${platform}] 📟 Commande /${cmd} trouvée`);
                return await this.commands.get(cmd)(ctx);
            }
            console.log(`[${platform}] ⚠️ Commande /${cmd} inconnue`);
        }

        // 3. Fallback: mots-clés courants → menu principal
        if (['menu', 'hi', 'bonjour', 'salut', 'hello', 'hey', 'yo', 'coucou', 'start', 'boutique', 'catalogue', 'commander', 'commande', 'aide', 'help'].includes(lowerText)) {
            console.log(`[${platform}] 🏠 Mot-clé menu → /start`);
            if (this.commands.has('start')) return await this.commands.get('start')(ctx);
        }

        // 3b. WhatsApp: Fallback numérique (AVANT l'auto-accueil pour intercepter les choix de menus)
        const shortId = String(userId).replace(/^(telegram_|whatsapp_)/, '').split('@')[0];
        const lastButtons = this.userLastButtons.get(shortId);

        if (ctx.channel.type === 'whatsapp' && /^\d+$/.test(lowerText) && !ctx._handled) {
            const index = parseInt(lowerText) - 1;
            waLog(`[${platform}] 🔢 Raccourci numérique "${lowerText}" (index ${index}) — UserShortID: ${shortId}`);
            waLog(`[${platform}] 🗂️ Boutons mémorisés: ${lastButtons ? lastButtons.map(b=>b.id || 'btn').join(', ') : 'AUCUN'}`);

            if (lastButtons && lastButtons[index]) {
                const btn = lastButtons[index];
                const trigger = btn.id || btn.callback_data;
                waLog(`[${platform}] ✅ Déclenchement: "${trigger}"`);
                if (trigger) {
                    ctx._handled = true;
                    return await this._routeAction(ctx, trigger);
                }
            } else if (!lastButtons) {
                waLog(`[${platform}] ❌ Pas de boutons mémorisés pour ${shortId} — envoi /start via auto-welcome possible`);
            } else {
                waLog(`[${platform}] ❌ Index ${index} hors limite (${lastButtons.length} boutons disponibles)`);
            }
        }

        // 3c. WhatsApp: auto-accueil si premier message (pas besoin de /start)
        if (ctx.platform === 'whatsapp' && !lastButtons && !ctx._handled) {
            console.log(`[${platform}] 🤝 Auto-welcome (premier message ID: ${shortId})`);
            if (this.commands.has('start')) return await this.commands.get('start')(ctx);
        }

        // 4. Handlers globaux (on text, message, etc.)
        console.log(`[${platform}] 📝 Passage dans ${this.onHandlers.length} handlers globaux...`);
        
        let handlerIndex = -1;
        const runHandlers = async () => {
            handlerIndex++;
            if (handlerIndex >= this.onHandlers.length) return;

            const h = this.onHandlers[handlerIndex];
            let match = false;
            
            if (h.type === 'text' && (ctx.message.text || ctx.text)) match = true;
            else if (h.type === 'photo' && ctx.message.photo) match = true;
            else if (h.type === 'video' && ctx.message.video) match = true;
            else if (h.type === 'message') match = true;
            else if (h.type === 'location' && ctx.message.location) match = true;
            else if (h.type === 'callback_query' && ctx.callbackQuery) match = true;

            if (match) {
                await h.fn(ctx, runHandlers);
            } else {
                await runHandlers();
            }
        };

        await runHandlers();
        waLog(`[${platform}] _handled: ${ctx._handled}`);

    }

    async _routeAction(ctx, data) {
        for (const [trigger, fn] of this.actions.entries()) {
            if (typeof trigger === 'string' && data === trigger) {
                try {
                    await fn(ctx);
                } catch(e) {
                    waLog(`[ROUTE-ERROR] Handler "${data}" a planté: ${e.message} ${e.stack?.split('\n')[1] || ''}`);
                }
                return true;
            } else if (trigger instanceof RegExp) {
                const match = data.match(trigger);
                if (match) {
                    ctx.match = match;
                    try {
                        await fn(ctx);
                    } catch(e) {
                        waLog(`[ROUTE-ERROR] Handler regex "${trigger}" a planté: ${e.message} ${e.stack?.split('\n')[1] || ''}`);
                    }
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Permet aux services externes (notif, etc.) d'hydrater le cache des boutons
     * pour que les raccourcis numériques WhatsApp fonctionnent sur les messages envoyés hors ctx.reply
     */
    setUserLastButtons(id, buttons) {
        if (!id || !buttons) return;
        const shortId = String(id).replace(/^(telegram_|whatsapp_)/, '').split('@')[0];
        this.userLastButtons.set(shortId, buttons);
        console.log(`[Dispatcher] Buttons cache hydrated for ${shortId} (${buttons.length} buttons)`);
    }
}

const dispatcher = new Dispatcher();
module.exports = { dispatcher, Dispatcher };
