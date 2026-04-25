
require('dotenv').config();
const { supabase } = require('../config/supabase');

async function run() {
    try {
        const { data, error } = await supabase.from('supplier_marketplace').select('name, price, unit_value');
        if (error) throw error;
        console.log('--- MARKETPLACE NAMES ---');
        data.forEach(p => console.log(`"${p.name}" | Price: ${p.price} | Unit: ${p.unit_value}`));
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}

run();
