/**
 * Registre central de tous les canaux actifs.
 * Permet au broadcast et au dashboard de decouvrir les canaux disponibles.
 */
class ChannelRegistry {
    constructor() {
        this.channels = new Map();
    }

    register(channel) {
        this.channels.set(channel.type, channel);
        console.log(`  Registered channel: ${channel.name} (${channel.type})`);
    }

    /**
     * Recupere un ou plusieurs canaux.
     * @param {string} [type] - Si fourni, retourne ce canal. Sinon retourne tous.
     * @param {{ activeOnly: boolean }} [opts]
     */
    query(type, opts = {}) {
        if (type) return this.channels.get(type);
        const list = Array.from(this.channels.values());
        return opts.activeOnly ? list.filter((c) => c.isActive) : list;
    }

    async _runOnAll(method) {
        const tasks = Array.from(this.channels.values()).map(async (ch) => {
            if (typeof ch[method] === 'function') {
                return ch[method]().catch(e => console.error(`[Registry] ${ch.type}.${method}() failed:`, e.message));
            } else {
                console.warn(`[Registry] ${ch.type} does not have method ${method}`);
            }
        });
        await Promise.all(tasks);
    }

    initializeAll() { return this._runOnAll('initialize'); }
    startAll() { return this._runOnAll('start'); }
    stopAll() { return this._runOnAll('stop'); }
}

const registry = new ChannelRegistry();

module.exports = { ChannelRegistry, registry };
