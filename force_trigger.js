const { processPendingBroadcasts } = require('./services/broadcast');
const { initChannels } = require('./services/channel_init');

async function forceTrigger() {
    console.log('⚡ Force triggering pending broadcasts...');
    
    // Bypass lock by setting environment variable if supported, 
    // or just try and wait the 30s lock wait.
    process.env.FORCE_BROADCAST = 'true'; 
    
    try {
        await initChannels();
        console.log('📡 Channels initialized. Processing pending broadcasts...');
        await processPendingBroadcasts();
        console.log('✅ Finished processing.');
        process.exit(0);
    } catch (e) {
        console.error('❌ Error:', e);
        process.exit(1);
    }
}

forceTrigger();
