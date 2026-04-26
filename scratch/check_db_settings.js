const { supabase } = require('../services/database');

async function checkTokens() {
    const { data, error } = await supabase.from('bot_settings').select('*').limit(1);
    if (error) {
        console.error('Error:', error);
    } else {
        console.log('Settings:', JSON.stringify(data, null, 2));
    }
}

checkTokens();
