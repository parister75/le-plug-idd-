/**
 * Simulation Test: Admin-Client Chat Relay (Final Stabilization)
 * Validates search, relay routing, and session management.
 */
const { setupAdminHandlers, adminSearchState, authenticatedAdmins, activeAdminSessions, awaitingAdminChat } = require('./handlers/admin');
const { dispatcher, Dispatcher } = require('./services/dispatcher');

const ADMIN_ID = 999;
const USER_ID = 1001;
const PLATFORM = 'telegram';

// Pre-authenticate admin for simulation
authenticatedAdmins.set(String(ADMIN_ID), true);
activeAdminSessions.set(String(ADMIN_ID), false);

// mock bot
const botMock = {
    actions: [],
    commands: new Map(),
    command: (cmd, handler) => botMock.commands.set(cmd, handler),
    action: (pattern, handler) => botMock.actions.push({ pattern, handler }),
    hears: (pattern, handler) => botMock.actions.push({ pattern, handler }),
    on: (pattern, handler) => botMock.actions.push({ pattern, handler }),
    handleUpdate: async (update) => {
        const platform = update.platform || 'telegram';
        const from = update.message?.from || update.callback_query?.from || update.from || { id: 1001 };
        const msg = update.message || update.callback_query?.message || (update.callback_query ? {} : update);
        if (!msg.message_id && !update.callback_query) msg.message_id = Math.floor(Math.random() * 1000000);

        const ctx = {
            update,
            from,
            chat: msg.chat || { id: from.id, type: 'private' },
            message: msg,
            callbackQuery: update.callback_query,
            platform,
            state: { settings: {} },
            session: {},
            answerCbQuery: async () => console.log('   [Mock] answerCbQuery'),
            reply: async (text, extra) => {
               console.log(`   [Mock Bot Output] -> ${text}`);
               return { message_id: 999 };
            },
            telegram: {
                getFileLink: async () => ({ href: 'http://mock-link' })
            }
        };

        if (update.callback_query) {
            const action = botMock.actions.find(a => 
                (typeof a.pattern === 'string' && update.callback_query.data.startsWith(a.pattern)) ||
                (a.pattern instanceof RegExp && a.pattern.test(update.callback_query.data))
            );
            if (action) {
                ctx.match = action.pattern instanceof RegExp ? update.callback_query.data.match(action.pattern) : [update.callback_query.data];
                return action.handler(ctx);
            }
        }

        // Simulate Telegraf chain
        let handled = false;
        const next = async () => { handled = true; };

        // 1. Check commands
        if (msg.text?.startsWith('/')) {
            const cmd = msg.text.split(' ')[0].slice(1);
            if (botMock.commands.has(cmd)) {
                await botMock.commands.get(cmd)(ctx);
                return;
            }
        }

        // 2. Dispatcher (registered via bot.on in real app)
        await dispatcher.handleUpdate({ type: platform }, msg);

        // 3. Generic handlers (hears, on)
        for (const h of botMock.actions) {
            if (h.types && h.types.includes('text') && msg.text) {
                 await h.handler(ctx, next);
                 return;
            }
            if (!h.types && !h.pattern && typeof h.handler === 'function') {
                 // Generic bot.on handler
                 await h.handler(ctx, next);
                 return;
            }
        }
    }
};

// Mock dependencies
require('./services/database').registerUser = async (u) => console.log(`   [Mock DB] User registered: ${u.id}`);
require('./services/database').searchUsers = async (q) => {
    console.log(`   [Mock DB] Searching users for: ${q}`);
    return [{ id: 'telegram_1001', first_name: 'TestUser', username: 'testuser' }];
};
require('./services/notifications').sendMessageToUser = async (platformId, text) => {
    console.log(`   [Mock Relay] Sending to ${platformId}: ${text}`);
};

// Initialize handlers
setupAdminHandlers(botMock);

async function runSimulation() {
    console.log('--- START RELAY SIMULATION (STABILIZATION) ---');

    console.log('\nSTEP 1: User sends support request');
    // In a real scenario, this would trigger some user-side handler
    // We just ensure dispatcher doesn't crash
    await botMock.handleUpdate({
        platform: PLATFORM,
        message: {
            message_id: 1,
            text: '/support',
            from: { id: USER_ID, first_name: 'TestUser' }
        }
    });

    console.log('\nSTEP 2: Admin initiates search');
    // Simulate admin entering name
    adminSearchState.set(ADMIN_ID, true);
    await botMock.handleUpdate({
        platform: 'telegram',
        message: {
            message_id: 2,
            text: 'testuser',
            from: { id: ADMIN_ID, username: 'admin' }
        }
    });

    console.log('\nSTEP 3: Admin clicks "Répondre" (Simulated Callback)');
    // The actual button triggers admin_chat_user_telegram_1001
    await botMock.handleUpdate({
        callback_query: {
            data: 'admin_chat_user_telegram_1001',
            from: { id: ADMIN_ID }
        }
    });

    console.log('\nSTEP 4: Admin sends relay message');
    await botMock.handleUpdate({
        platform: 'telegram',
        message: {
            message_id: 3,
            text: 'Hello from Admin',
            from: { id: ADMIN_ID }
        }
    });

    console.log('\nSTEP 5: End session');
    await botMock.handleUpdate({
        platform: 'telegram',
        message: {
            message_id: 4,
            text: '/end',
            from: { id: ADMIN_ID }
        }
    });

    console.log('\n--- SIMULATION COMPLETE ---');
}

runSimulation().catch(err => {
    console.error('SIMULATION FAILED:', err);
    process.exit(1);
});
