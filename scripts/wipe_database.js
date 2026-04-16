require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function wipe() {
    console.log('🗑 Wiping database for LE PLUG IDF...');

    // Delete in order to respect foreign keys if any
    console.log('📦 Cleaning orders...');
    const { error: err1 } = await supabase.from('bot_orders').delete().neq('id', 'void');
    if (err1) console.error('❌ Orders wipe failed:', err1.message);

    console.log('🍎 Cleaning products...');
    const { error: err2 } = await supabase.from('bot_products').delete().neq('id', 'void');
    if (err2) console.error('❌ Products wipe failed:', err2.message);

    console.log('👥 Cleaning users...');
    const { error: err3 } = await supabase.from('bot_users').delete().neq('id', 'void');
    if (err3) console.error('❌ Users wipe failed:', err3.message);

    console.log('✅ Wiping complete!');
}

wipe();
