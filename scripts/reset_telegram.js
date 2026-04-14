require('dotenv').config();
const axios = require('axios');

async function resetBot() {
    const token = process.env.TELEGRAM_TOKEN || '8680853121:AAEwhgDRHuK7kdsoTzGCdGpdAxc4lQHwbHA';
    console.log(`🧹 Tentative de nettoyage pour le bot...`);
    
    try {
        // 1. Supprimer le webhook (force long polling clean)
        const res = await axios.get(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=true`);
        console.log('✅ Webhook supprimé & updates en attente vidées:', res.data);
        
        // 2. Vérifier le statut
        const status = await axios.get(`https://api.telegram.org/bot${token}/getMe`);
        console.log('🤖 Bot identifié:', status.data.result.username);
        
        console.log('\n🚀 C\'est prêt. Vous pouvez redémarrer le bot sur Railway maintenant.');
    } catch (e) {
        console.error('❌ Erreur lors du reset:', e.response?.data || e.message);
    }
}

resetBot();
