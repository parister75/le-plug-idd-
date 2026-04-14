require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function check() {
    const tables = ['bot_settings', 'bot_products', 'bot_orders', 'bot_users'];
    for (const t of tables) {
        console.log(`\n--- Table: ${t} ---`);
        const { data, error } = await supabase.from(t).select('*').limit(1);
        if (error) {
            console.error(`❌ Error fetching ${t}:`, error.message);
        } else if (data && data.length > 0) {
            console.log(`✅ Found ${data.length} rows.`);
            console.log(`📊 Columns: ${Object.keys(data[0]).join(', ')}`);
        } else {
            console.log(`⚠️ Table is empty.`);
            // Try to get columns anyway if we can (PostgREST might not allow this easily without data)
        }
    }
}

check();
