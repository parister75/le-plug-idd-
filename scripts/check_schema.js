require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function check() {
    const tables = ['bot_settings', 'bot_products', 'bot_orders', 'bot_users'];
    for (const t of tables) {
        console.log(`\n--- Table: ${t} ---`);
        const { count, error } = await supabase.from(t).select('*', { count: 'exact', head: true });
        if (error) {
            console.error(`❌ Error fetching ${t}:`, error.message);
        } else {
            console.log(`✅ Total rows: ${count}`);
            const { data } = await supabase.from(t).select('*').limit(1);
            if (data && data.length > 0) {
                 console.log(`📊 Columns: ${Object.keys(data[0]).join(', ')}`);
            }
        }
    }
}

check();
