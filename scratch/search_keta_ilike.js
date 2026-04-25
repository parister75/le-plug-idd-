
require('dotenv').config();
const { supabase } = require('../config/supabase');

async function run() {
    try {
        const { data, error } = await supabase.from('bot_products').select('name').ilike('name', '%Keta%');
        if (error) throw error;
        console.log('--- KETA MATCHES ---');
        data.forEach(p => console.log(`"${p.name}"`));
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}

run();
