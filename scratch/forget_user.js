const { supabase, COL_USERS } = require('../services/database');
const encryption = require('../services/encryption');
require('dotenv').config();

async function forgetUser(targetName) {
    console.log(`🔍 Recherche de l'utilisateur "${targetName}" pour suppression totale...`);

    // 1. Récupérer TOUS les utilisateurs
    const { data: users, error } = await supabase.from(COL_USERS).select('*');
    if (error) {
        console.error('❌ Erreur récupération utilisateurs:', error);
        return;
    }

    let foundUser = null;
    for (const u of users) {
        const decryptedUsername = encryption.decrypt(u.username) || '';
        const decryptedFirstName = encryption.decrypt(u.first_name) || '';
        
        if (decryptedUsername.toLowerCase() === targetName.toLowerCase() || 
            decryptedFirstName.toLowerCase() === targetName.toLowerCase() ||
            (u.username && u.username.toLowerCase() === targetName.toLowerCase()) ||
            (u.id && u.id.toLowerCase().includes(targetName.toLowerCase()))) {
            foundUser = u;
            break;
        }
    }

    if (!foundUser) {
        console.log(`❌ Utilisateur "${targetName}" non trouvé.`);
        return;
    }

    const userId = foundUser.id;
    console.log(`✅ Utilisateur trouvé ! ID: ${userId}`);
    console.log(`🗑 Suppression de toutes les données liées à ${userId}...`);

    const tables = [
        { name: 'bot_orders', field: 'user_id' },
        { name: 'bot_reviews', field: 'user_id' },
        { name: 'bot_referrals', field: 'referrer_id' },
        { name: 'bot_referrals', field: 'referred_id' },
        { name: 'bot_cart', field: 'user_id' },
        { name: 'bot_fidelity', field: 'user_id' },
        { name: 'bot_support_logs', field: 'user_id' },
        { name: 'bot_users', field: 'id' } // L'utilisateur lui-même à la fin
    ];

    for (const table of tables) {
        try {
            const { error: err } = await supabase.from(table.name).delete().eq(table.field, userId);
            if (err) {
                if (err.message.includes('relation') || err.message.includes('not found')) {
                    // Table n'existe pas, on ignore
                } else {
                    console.warn(`⚠️ Erreur sur ${table.name} (${table.field}):`, err.message);
                }
            } else {
                console.log(`   - Données de ${table.name} (${table.field}) nettoyées.`);
            }
        } catch (e) {
            // console.warn(`⚠️ Exception sur ${table.name}:`, e.message);
        }
    }

    console.log(`\n✨ L'utilisateur "${targetName}" (ID: ${userId}) a été totalement effacé.`);
}

const target = 'gazolina94';
forgetUser(target).then(() => process.exit(0));
