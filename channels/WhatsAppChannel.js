const axios = require('axios');
const { Channel } = require('./Channel');

const API_VERSION = 'v21.0';
const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

class WhatsAppChannel extends Channel {
    constructor(config) {
        super('whatsapp', 'WhatsApp');
        this.phoneNumberId = config.phoneNumberId;
        this.accessToken = config.accessToken;
        this.verifyToken = config.verifyToken;
        this.baseUrl = `https://graph.facebook.com/${API_VERSION}/${this.phoneNumberId}`;
        this.sessionCache = new Map();
        this.messageHandler = null;
    }

    async initialize() {
        if (!this.phoneNumberId || !this.accessToken) {
            console.warn('  WhatsApp credentials manquantes, canal desactive');
            return;
        }
    }

    async start() {
        if (!this.phoneNumberId || !this.accessToken) return;
        this.isActive = true;
        console.log('  WhatsApp channel started (webhook)');
    }

    async stop() {
        this.isActive = false;
        this.sessionCache.clear();
    }

    onMessage(handler) { this.messageHandler = handler; }

    verifyWebhook(mode, token, challenge) {
        if (mode === 'subscribe' && token === this.verifyToken) return challenge;
        return null;
    }

    async handleWebhook(body) {
        if (!body.entry) return;
        for (const entry of body.entry) {
            for (const change of (entry.changes || [])) {
                if (change.field !== 'messages') continue;
                const val = change.value;
                const contact = val.contacts?.[0];
                for (const msg of (val.messages || [])) {
                    this._touchSession(msg.from);
                    if (this.messageHandler) {
                        const messageData = {
                            from: msg.from,
                            name: contact?.profile?.name || 'WhatsApp User',
                            text: this._extractText(msg),
                            type: msg.type,
                            rawId: msg.id,
                        };

                        // Extraction media + résolution URL pour relay Admin
                        if (msg.image) {
                            const url = await this.resolveMediaUrl(msg.image.id);
                            messageData.photo = [{ file_id: msg.image.id, url: url }];
                            if (msg.image.caption) messageData.caption = msg.image.caption;
                        } else if (msg.video) {
                            const url = await this.resolveMediaUrl(msg.video.id);
                            messageData.video = { file_id: msg.video.id, url: url };
                            if (msg.video.caption) messageData.caption = msg.video.caption;
                        }

                        await this.messageHandler(messageData);
                    }
                }
            }
        }
    }

    async resolveMediaUrl(mediaId) {
        if (!mediaId || !this.accessToken) return null;
        try {
            const graphUrl = `https://graph.facebook.com/${API_VERSION}/${mediaId}`;
            const response = await axios.get(graphUrl, {
                headers: { Authorization: `Bearer ${this.accessToken}` }
            });
            return response.data?.url;
        } catch (error) {
            console.error(`[WA-Media] Error resolving ${mediaId}:`, error.response?.data || error.message);
            return null;
        }
    }

    _extractText(msg) {
        if (msg.text) return msg.text.body;
        if (msg.image) return msg.image.caption || '';
        if (msg.video) return msg.video.caption || '';
        if (msg.interactive?.button_reply) return msg.interactive.button_reply.id;
        if (msg.button) return msg.button.text;
        return '';
    }

    async sendMessage(userId, text, options = {}) {
        // Strip HTML for WhatsApp
        const body = this._stripHTML(text || '');

        // Media handling
        if (options.media_url) {
            if (options.media_type === 'multiple') {
                try {
                    const mediaArray = JSON.parse(options.media_url);
                    // WhatsApp standard API doesnt support MediaGroup like Telegram.
                    // We send them one by one.
                    for (const m of mediaArray) {
                        await this._sendMedia(userId, m.url, m.type, body);
                    }
                    return { success: true };
                } catch (e) {
                    console.error("WhatsApp multiple media failed:", e);
                }
            } else {
                return this._sendMedia(userId, options.media_url, options.media_type || 'photo', body);
            }
        }

        return this._apiCall({
            messaging_product: 'whatsapp',
            to: userId,
            type: 'text',
            text: { body },
        });
    }

    async _sendMedia(userId, url, type, caption) {
        const mediaType = type === 'video' ? 'video' : 'image';
        const payload = {
            messaging_product: 'whatsapp',
            to: userId,
            type: mediaType,
            [mediaType]: {
                link: url,
                caption: caption || undefined
            }
        };
        return this._apiCall(payload);
    }

    async sendInteractive(userId, text, buttons = []) {
        if (buttons.length > 3) {
            // Use LIST message for more than 3 buttons (up to 10)
            return this._apiCall({
                messaging_product: 'whatsapp',
                to: userId,
                type: 'interactive',
                interactive: {
                    type: 'list',
                    body: { text: this._stripHTML(text) },
                    action: {
                        button: 'Options',
                        sections: [{
                            title: 'Menu',
                            rows: buttons.slice(0, 10).map((b, i) => ({
                                id: b.id || `btn_${i}`,
                                title: b.title.substring(0, 24),
                                description: b.description ? b.description.substring(0, 72) : undefined
                            }))
                        }]
                    }
                }
            });
        }

        const sliced = buttons.slice(0, 3);
        return this._apiCall({
            messaging_product: 'whatsapp',
            to: userId,
            type: 'interactive',
            interactive: {
                type: 'button',
                body: { text: this._stripHTML(text) },
                action: {
                    buttons: sliced.map((b) => ({
                        type: 'reply',
                        reply: { id: b.id, title: b.title.substring(0, 20) },
                    })),
                },
            },
        });
    }

    async sendTemplate(userId, templateName, lang, components = []) {
        return this._apiCall({
            messaging_product: 'whatsapp',
            to: userId,
            type: 'template',
            template: {
                name: templateName,
                language: { code: lang || 'fr' },
                components,
            },
        });
    }

    isInSessionWindow(userId) {
        const last = this.sessionCache.get(userId);
        return last && (Date.now() - last) < SESSION_WINDOW_MS;
    }

    async _apiCall(payload) {
        try {
            await axios.post(`${this.baseUrl}/messages`, payload, {
                headers: {
                    Authorization: `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json',
                },
            });
            return { success: true };
        } catch (error) {
            const errData = error.response?.data?.error;
            const result = { success: false, error: errData?.message || error.message };
            if (errData?.code === 131047) result.blocked = true;
            return result;
        }
    }

    _touchSession(userId) {
        this.sessionCache.set(userId, Date.now());
        if (this.sessionCache.size > 10000) {
            const cutoff = Date.now() - SESSION_WINDOW_MS;
            for (const [k, v] of this.sessionCache) {
                if (v < cutoff) this.sessionCache.delete(k);
            }
        }
    }

    _stripHTML(text) {
        return text.replace(/<[^>]*>/g, '');
    }

    getCapabilities() {
        return {
            hasSessionWindow: true,
            supportsHTML: false,
            supportsInlineKeyboard: false,
            supportsInteractiveButtons: true,
        };
    }
}

module.exports = { WhatsAppChannel };
