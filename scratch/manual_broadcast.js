const { supabase, COL_USERS, getAllUsersForBroadcast } = require('../services/database');
const { Telegraf } = require('telegraf');
require('dotenv').config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const bot = new Telegraf(BOT_TOKEN);

async function startBroadcast() {
    console.log('🚀 DÉMARRAGE DE LA DIFFUSION DE RÉCUPÉRATION');
    const message = "Voici le nouveau lien du bot : http://t.me/Lepdgidfbot";

    // 1. Débloquer tout le monde
    console.log('[1/3] Déblocage des utilisateurs en base de données...');
    const { error: unblockError } = await supabase.from(COL_USERS).update({ 
        is_blocked: false, 
        blocked_at: null 
    }).eq('is_blocked', true);

    if (unblockError) {
        console.error('❌ Erreur déblocage:', unblockError);
    } else {
        console.log('✅ Déblocage terminé.');
    }

    // 2. Récupérer tous les utilisateurs Telegram
    console.log('[2/3] Récupération des cibles...');
    const users = await getAllUsersForBroadcast(null, 'user');
    const telegramUsers = users.filter(u => u.platform === 'telegram' || !u.platform_id.includes('@'));
    console.log(`[2/3] ${telegramUsers.length} cibles Telegram trouvées.`);

    // 3. Envoi séquentiel avec délai pour éviter le flood
    console.log('[3/3] Envoi des messages...');
    let success = 0;
    let failed = 0;
    let blocked = 0;

    for (let i = 0; i < telegramUsers.length; i++) {
        const user = telegramUsers[i];
        const chatId = user.platform_id.replace('telegram_', '');
        
        try {
            await bot.telegram.sendMessage(chatId, message, { parse_mode: 'HTML' });
            success++;
            if (success % 10 === 0) console.log(`   Progress: ${success} succès...`);
        } catch (err) {
            const desc = (err.description || '').toLowerCase();
            if (desc.includes('blocked') || desc.includes('chat not found') || desc.includes('kicked')) {
                blocked++;
            } else {
                failed++;
                console.error(`   Error for ${chatId}:`, desc);
            }
        }
        
        // Délai de 50ms entre chaque message (20 messages/sec)
        await new Promise(r => setTimeout(r, 50));
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 RÉSULTAT DE LA DIFFUSION');
    console.log(`✅ Succès: ${success}`);
    console.log(`🚫 Bloqués: ${blocked}`);
    console.log(`❌ Échecs: ${failed}`);
    console.log(`Total: ${telegramUsers.length}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    process.exit(0);
}

startBroadcast().catch(err => {
    console.error('FATAL ERROR:', err);
    process.exit(1);
});
