const { registerUser, incrementDailyStat, getAppSettings } = require('../services/database');

const userState = new Map();

/**
 * Gère les messages entrants du canal WhatsApp.
 * Module adaptatif - réduit la pollution visuelle
 */
async function handleWhatsAppMessage(channel, msg) {
    try {
        const { from, name, text, type } = msg;
        const settings = await getAppSettings();

        let referrerId = null;
        if (text && text.toLowerCase().startsWith('ref_')) {
            const parts = text.split('_');
            if (parts.length >= 3) {
                referrerId = parts[2];
            }
        }

        const platformUser = {
            id: from,
            first_name: name,
            username: from,
            language_code: 'fr',
        };

        const { isNew, user: registeredUser } = await registerUser(platformUser, 'whatsapp', referrerId);
        await incrementDailyStat('whatsapp_messages');

        // Gestion des boutons interactifs (réponses aux boutons précédents)
        if (text && ['menu', 'contact', 'channel', 'referrals', 'catalog', 'orders'].includes(text)) {
            return handleWhatsAppAction(channel, from, name, text, settings, registeredUser);
        }

        // Commande menu explicite
        if (text && text.toLowerCase() === 'menu') {
            return sendWhatsAppMenu(channel, from, settings);
        }

        if (isNew) {
            // Nouveau utilisateur - message de bienvenue concis
            const welcomeMsg = `✨ *Bienvenue sur ${settings.bot_name}, ${name} !*\n\n` +
                `${settings.welcome_message}\n\n` +
                `🔗 *Votre lien de parrainage :*\n` +
                `https://wa.me/${channel.phoneNumberId}?text=${registeredUser.referral_code}`;

            await channel.sendInteractive(from, welcomeMsg, [
                { id: 'menu', title: '🏠 Menu' }
            ]);
        } else {
            // Utilisateur existant - message simple
            const backMsg = `👋 *Ravi de vous revoir, ${name} !*\n\nTapez "menu" pour commander.`;
            await channel.sendMessage(from, backMsg);
        }
    } catch (error) {
        console.error('❌ Erreur WhatsApp handler:', error);
    }
}

/**
 * Gère les actions du menu WhatsApp de manière contextuelle
 */
async function handleWhatsAppAction(channel, from, name, action, settings, user) {
    switch (action) {
        case 'menu':
            return sendWhatsAppMenu(channel, from, settings);
            
        case 'contact':
            return channel.sendMessage(from, `📱 *Contact privé :*\n${settings.private_contact_url}`);
            
        case 'channel':
            return channel.sendMessage(from, `📢 *Canal :*\n${settings.channel_url}`);
            
        case 'referrals':
            const refLink = `https://wa.me/${channel.phoneNumberId}?text=${user.referral_code}`;
            const refBonus = settings.ref_bonus || 5;
            return channel.sendMessage(from, 
                `🎁 *Parrainage*\n\n` +
                `Gagnez ${refBonus}€ pour chaque ami qui commande !\n\n` +
                `Votre lien : ${refLink}`
            );
            
        case 'catalog':
            return channel.sendMessage(from, 
                `👟 *Catalogue*\n\n` +
                `Pour voir nos produits, utilisez notre bot Telegram :\n` +
                `${settings.channel_url || '@Lejardinidf'}`
            );
            
        case 'orders':
            return channel.sendMessage(from, 
                `📦 *Vos commandes*\n\n` +
                `Contactez-nous pour voir vos commandes en cours.`
            );
            
        default:
            return sendWhatsAppMenu(channel, from, settings);
    }
}

/**
 * Menu principal WhatsApp - Simplifié pour réduire la pollution visuelle
 */
async function sendWhatsAppMenu(channel, from, settings) {
    const menuMsg = `📋 *Menu - ${settings.bot_name}*\n\nQue souhaitez-vous ?`;
    await channel.sendInteractive(from, menuMsg, [
        { id: 'catalog', title: '👟 Commander' },
        { id: 'orders', title: '📦 Mes commandes' },
        { id: 'contact', title: '📱 Contact' }
    ]);
}

module.exports = { handleWhatsAppMessage };
