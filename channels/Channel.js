/**
 * Classe de base pour les canaux de messaging.
 * Sous-classes doivent implementer :
 *   initialize(), start(), stop(),
 *   sendMessage(userId, text, options),
 *   sendInteractive(userId, text, buttons)
 */
class Channel {
    constructor(type, name) {
        this.type = type;
        this.name = name;
        this.isActive = false;
    }

    async sendTemplate(userId, templateName, lang) {
        return this.sendMessage(userId, `[Template: ${templateName}]`);
    }

    getCapabilities() {
        return {
            hasSessionWindow: false,
            supportsHTML: false,
            supportsInlineKeyboard: false,
            supportsInteractiveButtons: false,
        };
    }
}

module.exports = { Channel };
