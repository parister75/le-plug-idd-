
require('dotenv').config();
const { supabase } = require('../config/supabase');

async function run() {
    try {
        const { data, error } = await supabase.from('bot_settings').select('key, value');
        if (error) throw error;
        console.log('--- SETTINGS ---');
        data.forEach(s => {
            if (s.key === 'bot_name') console.log(`Bot Name: ${s.value}`);
        });
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}

run();
