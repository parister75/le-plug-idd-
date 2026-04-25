
require('dotenv').config();
console.log('Using SUPABASE_URL:', process.env.SUPABASE_URL);
const { supabase } = require('../config/supabase');

async function run() {
    try {
        const { data, error } = await supabase.from('bot_products').select('name, price, unit_value');
        if (error) throw error;
        console.log('--- ALL NAMES ---');
        data.forEach(p => console.log(`"${p.name}" | Price: ${p.price} | Unit: ${p.unit_value}`));
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}

run();
