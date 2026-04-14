// Dynamic import wrapper for ESM-only @whiskeysockets/baileys (Node 22+)
let Baileys, makeWASocket, DisconnectReason, jidDecode, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, downloadMediaMessage;

async function loadBaileys() {
    if (Baileys) return;
    Baileys = await import('@whiskeysockets/baileys');
    makeWASocket = Baileys.default?.default || Baileys.default || Baileys;
    DisconnectReason = Baileys.DisconnectReason;
    jidDecode = Baileys.jidDecode;
    fetchLatestBaileysVersion = Baileys.fetchLatestBaileysVersion;
    makeCacheableSignalKeyStore = Baileys.makeCacheableSignalKeyStore;
    downloadMediaMessage = Baileys.downloadMediaMessage;
}

const { Channel } = require('./Channel');
const { useSupabaseAuthState } = require('../services/database');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const qrcodeTerminal = require('qrcode-terminal');
const qrcodeImage = require('qrcode');



const { waLogs, waLog } = require('../services/wa_log_shared');

class WhatsAppSessionChannel extends Channel {
    constructor(config) {
        super('whatsapp', 'WhatsApp (Session)');
        this.sessionId = config.sessionId || 'default';
        this.sock = null;
        this.messageHandler = null;
        this.store = null;
        this._restarting = false;
        this._clearSession = null; // Sera défini dans start()
        this._conflictBackoff = 5000; // Backoff initial pour code 440 (ms)
        this.pairingPhone = null;  // Numéro pour le jumelage sans QR
        this.pairingCode = null;   // Code à 8 caractères généré
    }

    static getLogs() { return waLogs; }

    async initialize() {
        await loadBaileys();
        console.log(`[WA-Session] Supabase mode for: ${this.sessionId}`);
    }

    async start(options = {}) {
        await loadBaileys();
        if (options.pairingPhone) {
            this.pairingPhone = options.pairingPhone;
            this.pairingCode = null;
            waLog(`[WA-Pairing] Mode jumelage activé pour : ${this.pairingPhone}`);
        }
        const { state, saveCreds, clearSession, claimLock, checkLock } = await useSupabaseAuthState(this.sessionId);
        this._clearSession = clearSession;

        // --- LOCK SYSTEM (PREVENTS CONFLICT 440) ---
        const myInstanceId = `${process.env.RAILWAY_SERVICE_NAME || 'local'}-${process.env.RAILWAY_REPLICA_INDEX || '0'}-${process.pid}`;
        const activeLock = await checkLock();
        
        if (activeLock && activeLock.owner !== myInstanceId) {
            const now = Date.now();
            const updatedAt = activeLock.updatedAt || 0;
            const diff = now - updatedAt;

            // Si le lock existe et qu'il a été mis à jour il y a moins de 5 minutes, il est ACTIF
            if (activeLock.owner && diff < 300000) {
                const waitTime = 30000;
                waLog(`[WA-LOCK] Session busy (owned by ${activeLock.owner}, updated ${Math.round(diff/1000)}s ago). Waiting ${waitTime}ms to avoid conflict 440...`);
                this.isActive = false;
                setTimeout(() => this.start(), waitTime);
                return;
            }
        }
        
        // Prendre le lock
        await claimLock(myInstanceId);
        waLog(`[WA-LOCK] Session locked for our instance: ${myInstanceId}`);
        this.isActive = true; // Marquer comme actif pour le heartbeat dès maintenant

        // [🛡️ REDONDANCE] Heartbeat pour garder le lock vivant
        // On le lance immédiatement pour éviter tout timeout pendant la connexion Baileys
        if (this._lockHeartbeat) clearInterval(this._lockHeartbeat);
        this._lockHeartbeat = setInterval(async () => {
             // Met à jour le timestamp 'updatedAt' dans Supabase
             await claimLock(myInstanceId).catch(err => {
                 waLog(`[WA-LOCK] Heartbeat failed: ${err.message}`);
             });
        }, 60000); // 1 minute (plus agressif pour être sûr)

        let version = [2, 3000, 1015901307];
        let isLatest = false;
        try {
            const latest = await Promise.race([
                fetchLatestBaileysVersion(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Version fetch timeout')), 5000))
            ]).catch(() => null);
            if (latest && latest.version) {
                version = latest.version;
                isLatest = latest.isLatest;
            }
        } catch (e) {
            console.warn('[WA] Version fetch failed, using fallback.');
        }
        console.log(`[WA] Using version v${version.join('.')}, isLatest: ${isLatest}`);

        const logger = pino({ level: 'silent' });
        this.sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            logger,
            browser: ['Mac OS', 'Safari', '17.0'],
            syncFullHistory: false,
            generateHighQualityLinkPreview: false,
            getMessage: async (key) => {
                // Nécessaire pour que Baileys puisse décrypter les messages retry
                return { conversation: '' };
            }
        });


        // this.store.bind(this.sock.ev); // Removed store bind

        this.sock.ev.on('creds.update', saveCreds);

        this.sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            waLog(`[WA] Connection Update: ${JSON.stringify(update, null, 2)}`);

            if (qr) {
                console.log('--------------------------------------------------');
                console.log('👉 SCANNEZ CE QR CODE POUR CONNECTER WHATSAPP :');
                qrcodeTerminal.generate(qr, { small: true });
                console.log('--------------------------------------------------');

                // Sauvegarder en image pour le web endpoint /whatsapp-qr
                try {
                    const artifactPath = path.join(process.cwd(), 'whatsapp_qr.png');
                    await qrcodeImage.toFile(artifactPath, qr, {
                        color: { dark: '#000000', light: '#ffffff' },
                        width: 256
                    });
                    console.log(`✅ QR Image générée: ${artifactPath}`);
                } catch (err) {
                    console.error('❌ Erreur génération image QR:', err);
                }
            }

            // --- PAIRING CODE LOGIC ---
            if (this.pairingPhone && !this.sock.authState.creds.registered && !this.pairingCode) {
                // On attend que la socket soit bien stable (10s) avant de demander le code
                // Cela évite les rejets "401 Unauthorized" trop précoces sur certains réseaux
                waLog(`[WA-Pairing] Demande de code pour ${this.pairingPhone} dans 10 secondes...`);
                setTimeout(async () => {
                    try {
                        const cleanPhone = this.pairingPhone.replace(/\D/g, '');
                        waLog(`📡 [WA-Pairing] Envoi de la requête de code pour +${cleanPhone}...`);
                        const code = await this.sock.requestPairingCode(cleanPhone);
                        this.pairingCode = code;
                        waLog(`✅ [WA-Pairing] CODE REÇU : ${this.pairingCode}`);
                    } catch (err) {
                        waLog(`❌ [WA-Pairing] Échec demande de code : ${err.message}`);
                        this.pairingCode = "ERROR: " + err.message;
                    }
                }, 10000);
            }

            if (connection === 'close') {
                const error = lastDisconnect?.error;
                const statusCode = error?.output?.statusCode;
                waLog(`[WA] Connexion fermée. Code: ${statusCode}, Msg: ${error?.message}, Payload: ${JSON.stringify(error?.output?.payload)}`);

                // Si on est en restart, ne pas reconnecter (restart() s'en charge)
                if (this._restarting) {
                    waLog('[WA] Restart en cours, pas de reconnexion auto.');
                    return;
                }

                // Codes qui nécessitent une session fraîche (nouveau QR)
                const needsFreshSession = [
                    DisconnectReason.loggedOut,   // 401 - déconnecté par l'utilisateur
                    DisconnectReason.forbidden,    // 403 - compte banni/bloqué
                    DisconnectReason.badSession,   // 500 - session corrompue
                    DisconnectReason.multideviceMismatch, // 411 - conflit appareils
                ].includes(statusCode);

                if (needsFreshSession) {
                    waLog(`[WA] Session invalide (code ${statusCode}) — effacement Supabase. Attente de 3s avant nouveau QR...`);
                    if (this._clearSession) await this._clearSession();
                    this.isActive = false;
                    setTimeout(() => this.start(), 3000); // Délai de 3s pour garantir le nettoyage DB avant de repartir 🔄
                } else if (statusCode === 440) {
                    // Conflit : une autre instance a pris la session.
                    // Backoff exponentiel pour éviter la boucle infinie de conflits.
                    const delay = this._conflictBackoff;
                    this._conflictBackoff = Math.min(this._conflictBackoff * 2, 60000); // max 60s
                    waLog(`[WA] Conflit 440 (replaced) — attente ${delay}ms avant reconnexion (backoff=${this._conflictBackoff}ms)...`);
                    this.isActive = false;
                    setTimeout(() => this.start(), delay);
                } else {
                    // Reconnexion simple (timeout, perte réseau, etc.)
                    this._conflictBackoff = 5000; // reset backoff sur reconnexion normale
                    waLog(`[WA] Reconnexion simple (code ${statusCode})...`);
                    this.start();
                }
            } else if (connection === 'open') {
                waLog('✅ [WA] WhatsApp connecté avec succès !');
                this.isActive = true;
                this._conflictBackoff = 5000; // reset backoff sur connexion réussie
            }
        });


        this.sock.ev.on('messages.upsert', async (m) => {
            waLog(`[WA-MSG] messages.upsert type=${m.type}, count=${m.messages?.length}`);
            if (m.type !== 'notify') {
                waLog(`[WA-MSG] SKIP: type=${m.type} (not notify)`);
                return;
            }
            const selfJid = this.sock.user?.id;
            waLog(`[WA-MSG] selfJid=${selfJid}`);

            for (const msg of m.messages) {
                const remoteJid = msg.key.remoteJid;
                const isMe = msg.key.fromMe;

                // Ignorer les messages de protocole sans contenu utile
                if (!msg.message || msg.message?.protocolMessage || msg.message?.senderKeyDistributionMessage) {
                    waLog(`[WA-MSG] SKIP protocol/empty from ${remoteJid}`);
                    continue;
                }

                const selfJidClean = selfJid?.split(':')[0];
                const remoteJidClean = remoteJid?.split('@')[0].split(':')[0];
                const isMessageToSelf = remoteJidClean === selfJidClean || remoteJid?.endsWith('@lid');

                // Détecter si le message vient d'un BOT (Baileys ou autre bot instance)
                const isBotId = msg.key.id.startsWith('BAE5') || msg.key.id.startsWith('3EB0') || msg.key.id.length > 20;

                waLog(`[WA-MSG] fromMe=${isMe}, isBotId=${isBotId}, remoteJid=${remoteJid}, toSelf=${isMessageToSelf}, msgKeys=${Object.keys(msg.message || {}).join(',')}`);

                // Empêcher les boucles : on ignore tout ce qui est marqué fromMe SAUF si c'est nous qui écrivons manuellement (pas un ID de bot)
                if (isMe && isBotId) { waLog(`[WA-MSG] SKIP: fromMe+botId`); continue; }
                // Si c'est un message "To Self" (notre propre compte), on accepte seulement si c'est un message manuel (pas du bot)
                if (isMe && !isBotId && isMessageToSelf) {
                    waLog(`[WA-MSG] ACCEPT: self-message from human`);
                } else if (isMe) {
                    waLog(`[WA-MSG] SKIP: fromMe outbound`);
                    continue;
                }

                const name = msg.pushName || 'User';
                const text = this._extractText(msg);
                const isAction = !!(msg.message?.listResponseMessage || msg.message?.buttonsResponseMessage);

                // Extraction média (Image/Vidéo)
                let photo = null;
                let video = null;
                const m2 = msg.message;
                if (m2?.imageMessage) {
                    photo = [{ file_id: msg.key.id, isWa: true, msg: msg }];
                } else if (m2?.videoMessage) {
                    video = [{ file_id: msg.key.id, isWa: true, msg: msg }];
                }

                waLog(`[WA-MSG] text="${text}", photo=${!!photo}, video=${!!video}, handler=${!!this.messageHandler}`);

                if (this.messageHandler && (text || photo || video)) {
                    waLog(`[WA-In] Processing: "${text}" from ${remoteJid}`);
                    await this.messageHandler({
                        from: remoteJid,
                        name: name,
                        text: text,
                        photo: photo,
                        video: video,
                        type: video ? 'video' : (photo ? 'photo' : 'text'),
                        isAction: isAction,
                        raw: msg
                    });
                }
            }
        });




    }

    async stop() {
        if (this.sock) this.sock.end();
        this.isActive = false;
    }

    async restart(options = {}) {
        waLog('[WA] Restart demandé — nettoyage session Supabase et reconnexion...');
        this._restarting = true;
        // 1. Fermer la connexion existante
        if (this.sock) {
            try { this.sock.end(); } catch (e) {}
            this.sock = null;
        }
        this.isActive = false;
        this.pairingCode = null;
        this.pairingPhone = options.pairingPhone || null;
        
        // 2. Supprimer la session Supabase pour forcer un nouveau QR/Code
        if (this._clearSession) {
            await this._clearSession();
            waLog('[WA] Session Supabase supprimée.');
        }
        // 3. Supprimer l'ancien QR image
        const qrPath = path.join(process.cwd(), 'whatsapp_qr.png');
        if (fs.existsSync(qrPath)) fs.unlinkSync(qrPath);
        // 4. Redémarrer
        this._restarting = false;
        await this.start(options);
    }

    _resolveMedia(url) {
        if (typeof url !== 'string') return url;
        if (url.startsWith('http') || url.startsWith('data:')) return url;
        // Si c'est un chemin commençant par /public/ ou relatif, on le résout par rapport au CWD
        let relative = url.startsWith('/') ? url.substring(1) : url;
        const absolute = path.join(process.cwd(), relative);
        if (fs.existsSync(absolute)) return absolute;
        // Fallback spécifique pour web/public/...
        const webPublic = path.join(process.cwd(), 'web', relative);
        if (fs.existsSync(webPublic)) return webPublic;
        return url;
    }

    onMessage(handler) { this.messageHandler = handler; }

    async sendMessage(userId, text, options = {}) {
        const jid = this._normalizeId(userId);
        
        if (!this.sock || !this.isActive) {
            waLog(`[WA-Send-Error] Disconnected! State: ${!!this.sock ? 'WaitSock' : 'NoSock'}, Active: ${this.isActive} | To: ${jid}`);
            return { success: false, error: 'WhatsApp not connected or session locked' };
        }

        waLog(`[WA-Send] Sending to ${jid} | HasMedia: ${!!(options.source || options.media_url)}`);
        const cleanText = this._stripHTML(text);

        try {
            let result;
            if (options.source || options.media_url) {
                let mediaSource = options.source;
                let mediaUrl = this._resolveMedia(options.media_url);

                // Si c'est un chemin local et qu'on n'a pas encore de buffer (source)
                if (!mediaSource && typeof mediaUrl === 'string' && fs.existsSync(mediaUrl)) {
                    try {
                        mediaSource = fs.readFileSync(mediaUrl);
                        mediaUrl = null;
                    } catch (e) {
                        console.error(`[WA-Send] Error reading local file ${mediaUrl}:`, e.message);
                    }
                }

                const mediaType = options.media_type === 'video' ? 'video' : 'image';
                const msgPayload = {
                    [mediaType]: mediaSource ? mediaSource : { url: mediaUrl },
                    caption: cleanText
                };
                result = await this.sock.sendMessage(jid, msgPayload);
            } else {
                result = await this.sock.sendMessage(jid, { text: cleanText });
            }
            return { success: true, messageId: result?.key?.id };
        } catch (e) {
            console.error('[WA-Send] Error:', e);
            return { success: false, error: e.message };
        }
    }

    async deleteMessage(jid, messageId) {
        if (!this.sock || !this.isActive || !messageId) return;
        try {
            await this.sock.sendMessage(jid, {
                delete: {
                    remoteJid: jid,
                    fromMe: true,
                    id: messageId,
                    participant: undefined
                }
            });
            return true;
        } catch (e) {
            console.error('[WA-Delete] Error:', e);
            return false;
        }
    }

    async sendInteractive(userId, text, buttons = [], options = {}) {
        if (!this.sock || !this.isActive) {
            console.warn(`[WA-Interactive] Socket non disponible (isActive=${this.isActive}, sockNull=${!this.sock}) — message non envoyé à ${userId}`);
            return { success: false, sentIds: [], error: 'Not connected' };
        }

        const jid = (userId.includes('@')) ? userId : `${userId}@s.whatsapp.net`;
        const sentIds = [];
        console.log(`[WA-Interactive] To: ${jid}, Buttons: ${buttons.length}, HasMedia: ${!!options.media_url}`);

        const cleanText = this._stripHTML(text);
        let textMenu = cleanText;

        // Préparer le menu textuel si des boutons sont présents
        if (buttons.length > 0) {
            if (textMenu) textMenu += "\n\n";
            textMenu += "*📋 OPTIONS DISPONIBLES :*\n";
            buttons.forEach((b, i) => {
                const label = b.title || b.text || 'Option';
                const link = b.url ? `\n🔗 ${b.url}` : '';
                textMenu += `*${i+1}* — ${label}${link}\n`;
            });
            textMenu += "\n_Répondez avec le chiffre correspondant._";
        }

        // 1. Tentative envoi avec média (si présent)
        if (options.source || options.media_url) {
            try {
                let mediaSource = options.source;
                let mediaUrl = this._resolveMedia(options.media_url);

                // Détecter chemin local absolute pour WhatsApp
                if (!mediaSource && typeof mediaUrl === 'string' && fs.existsSync(mediaUrl)) {
                    try {
                        mediaSource = fs.readFileSync(mediaUrl);
                        mediaUrl = null;
                    } catch (e) { }
                }

                const mediaType = options.media_type === 'video' ? 'video' : 'image';
                const msgPayload = {
                    [mediaType]: mediaSource ? mediaSource : { url: mediaUrl },
                    caption: textMenu || ""
                };
                const result = await this.sock.sendMessage(jid, msgPayload);
                if (result?.key?.id) sentIds.push(result.key.id);
                return { success: true, sentIds };
            } catch (e) {
                console.warn(`[WA-Interactive] Échec envoi média (${options.media_url || 'source buffer'}) — fallback texte seul. Erreur: ${e.message}`);
                // Fallback : envoyer texte seul ci-dessous
            }
        }

        // 2. Envoi Texte seul (aussi utilisé comme fallback si le média échoue)
        try {
            const result = await this.sock.sendMessage(jid, { text: textMenu || "Choisissez une option :" });
            if (result?.key?.id) sentIds.push(result.key.id);
            return { success: true, sentIds };
        } catch (e) {
            console.error('[WA-Interactive] Échec envoi texte:', e);
            return { success: false, sentIds };
        }
    }

    _extractText(msg) {
        const m = msg.message;
        const text = m?.listResponseMessage?.singleSelectReply?.selectedRowId ||
                     m?.buttonsResponseMessage?.selectedButtonId ||
                     m?.conversation ||
                     m?.extendedTextMessage?.text ||
                     m?.imageMessage?.caption ||
                     m?.videoMessage?.caption ||
                     "";
        return text;
    }

    async downloadMedia(msg) {
        try {
            await loadBaileys();
            const buffer = await downloadMediaMessage(
                msg,
                'buffer',
                {},
                {
                    logger: pino({ level: 'silent' }),
                    reuploadRequest: this.sock.updateMediaMessage
                }
            );
            return buffer;
        } catch (e) {
            console.error('[WA-Download] Error:', e.message);
            return null;
        }
    }

    _stripHTML(text) {
        if (!text) return '';
        // Conversion basique HTML -> WA Markdown
        let t = text
            .replace(/<b[^>]*>(.*?)<\/b>/gi, '*$1*')
            .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '*$1*')
            .replace(/<i[^>]*>(.*?)<\/i>/gi, '_$1_')
            .replace(/<em[^>]*>(.*?)<\/em>/gi, '_$1_')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/&nbsp;/g, ' ');

        // Supprimer toutes les autres balises
        return t.replace(/<[^>]*>/g, '').trim();
    }

    _normalizeId(id) {
        if (!id) return id;
        let s = String(id).trim();
        
        // Remove 'whatsapp_' prefix if present (from notifications.js)
        if (s.startsWith('whatsapp_')) s = s.replace('whatsapp_', '');

        if (s.includes('@s.whatsapp.net')) {
            return s.split(':')[0].split('@')[0] + '@s.whatsapp.net';
        }
        if (s.includes('@lid')) {
            return s.split(':')[0].split('@')[0] + '@lid';
        }
        
        // Default to s.whatsapp.net if no suffix
        if (!s.includes('@')) return s + '@s.whatsapp.net';
        
        return s;
    }
}

module.exports = { WhatsAppSessionChannel };
