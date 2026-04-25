
require('dotenv').config();
const { getProducts } = require('../services/database');

async function run() {
    try {
        const products = await getProducts(true);
        console.log('--- LE PLUG IDF ALL PRODUCTS ---');
        products.forEach(p => {
            console.log(`ID: ${p.id} | Name: ${p.name} | Price: ${p.price} (${typeof p.price}) | Unit Val: ${p.unit_value} | HasDisc: ${p.has_discounts} | IsMP: ${p.is_mp}`);
            if (p.has_discounts && p.discounts_config) {
                console.log(`  Discounts: ${JSON.stringify(p.discounts_config)}`);
            }
        });

        const { data: mp } = await require('../config/supabase').supabase.from('supplier_marketplace').select('*');
        console.log('--- MARKETPLACE DIRECT CHECK ---');
        mp.forEach(p => {
            console.log(`ID: ${p.id} | Name: ${p.name} | Price: ${p.price} | Valid: ${p.is_validated} | Active: ${p.is_active}`);
        });
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}

run();
