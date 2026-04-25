
require('dotenv').config();
const { supabase } = require('../config/supabase');

async function run() {
    try {
        const { data, error } = await supabase.from('bot_products').select('name, id');
        if (error) throw error;
        console.log('--- SEARCHING FOR NEEDLES ---');
        data.forEach(p => {
            if (p.name.toLowerCase().includes('needle') || p.name.toLowerCase().includes('keta')) {
                console.log(`MATCH: "${p.name}" | ID: ${p.id}`);
            }
        });
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}

run();
