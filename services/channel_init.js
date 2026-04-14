const { registry } = require('../channels/ChannelRegistry');
const { TelegramChannel } = require('../channels/TelegramChannel');
const { WhatsAppChannel } = require('../channels/WhatsAppChannel');
const { WhatsAppSessionChannel } = require('../channels/WhatsAppSessionChannel');

async function initChannels() {
    console.log('📦 Initialisation des canaux...');

    // 1. Telegram
    const tgToken = process.env.BOT_TOKEN;
    if (tgToken) {
        const tg = new TelegramChannel(tgToken);
        await tg.initialize();
        registry.register(tg);
    }

    // 2. WhatsApp (Official Cloud API)
    const waPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const waToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const waVerify = process.env.WHATSAPP_VERIFY_TOKEN;

    if (waPhoneId && waToken) {
        const wa = new WhatsAppChannel({
            phoneNumberId: waPhoneId,
            accessToken: waToken,
            verifyToken: waVerify
        });
        await wa.initialize();
        registry.register(wa);
    }

    // 3. WhatsApp (Session / TCT style)
    const waSessionId = process.env.WHATSAPPD_SESSION_ID || process.env.WHATSAPP_SESSION_ID;
    if (waSessionId || process.env.SESSION_ID) {
        const sid = waSessionId || process.env.SESSION_ID || process.env.WHATSAPPD_SESSION_ID;
        const was = new WhatsAppSessionChannel({ sessionId: sid });
        await was.initialize();
        registry.register(was);
    }

    // Démarrage de tous les canaux
    await registry.startAll();
    console.log('✅ Canaux opérationnels !');
}

module.exports = { initChannels };
