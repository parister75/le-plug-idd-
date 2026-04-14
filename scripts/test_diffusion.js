require('dotenv').config();
const { Telegraf } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function testDiffusion() {
    console.log('📢 Lancement du test de diffusion...');

    // 1. Récupérer les utilisateurs (on filtre ceux qui ont un ID plateforme)
    const { data: users, error } = await supabase
        .from('bot_users')
        .select('id, first_name, platform')
        .eq('is_blocked', false)
        .limit(10);

    if (error) {
        console.error('❌ Erreur récupération users:', error.message);
        return;
    }

    if (!users || users.length === 0) {
        console.warn('⚠️ Aucun utilisateur trouvé pour le test.');
        return;
    }

    console.log(`👥 ${users.length} cibles trouvées.`);

    const message = "🚀 <b>TEST DE DIFFUSION - monshopbot</b>\n\nCeci est un message de test pour valider que le système de broadcast fonctionne correctement.\n\nMerci de votre confiance !";

    let success = 0;
    let failed = 0;

    for (const user of users) {
        // On n'envoie qu'à Telegram pour ce test script simplifié
        if (user.platform !== 'telegram') continue;

        const telegramId = user.id.replace('tg_', '');
        try {
            await bot.telegram.sendMessage(telegramId, message, { parse_mode: 'HTML' });
            console.log(`✅ Message envoyé à ${user.first_name} (${telegramId})`);
            success++;
        } catch (err) {
            console.error(`❌ Échec pour ${user.first_name} (${telegramId}):`, err.message);
            failed++;
        }
    }

    console.log(`\n📊 Résultat : ${success} succès, ${failed} échecs.`);
}

testDiffusion();
