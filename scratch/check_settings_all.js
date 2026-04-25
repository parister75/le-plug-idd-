
require('dotenv').config();
const { supabase } = require('../config/supabase');

async function run() {
    try {
        const { data, error } = await supabase.from('bot_settings').select('*');
        if (error) throw error;
        console.log('--- SETTINGS ---');
        console.log(JSON.stringify(data[0], null, 2));
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}

run();
