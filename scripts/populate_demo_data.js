require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// Setup Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ Missing SUPABASE_URL or SUPABASE_KEY in .env');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Utility functions
const makeId = () => crypto.randomBytes(8).toString('hex');
const randomDate = (start, end) => {
    return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime())).toISOString();
};

async function populate() {
    console.log('🚀 Starting demo data population for monshopbot...');

    // Helper to get columns (robust version)
    const getColumns = async (table) => {
        try {
            const { data, error } = await supabase.from(table).select('*').limit(1);
            if (error) {
                console.warn(`⚠️ Could not fetch columns for ${table}:`, error.message);
                return [];
            }
            if (!data || data.length === 0) {
                console.warn(`⚠️ Table ${table} is empty. Trying a minimal insert to trigger schema...`);
                return [];
            }
            return Object.keys(data[0]);
        } catch (e) {
            return [];
        }
    };

    // 1. Rebranding Settings
    console.log('⚙️ Updating settings...');
    const settingsCols = await getColumns('bot_settings');
    
    const settingsData = {
        id: 'default',
        bot_name: 'monshopbot',
        dashboard_title: 'monshopbot'
    };
    
    // Only add columns that exist
    const finalSettings = {};
    Object.keys(settingsData).forEach(k => {
        if (settingsCols.includes(k) || settingsCols.length === 0) finalSettings[k] = settingsData[k];
    });
    
    // Add other fields if they exist
    const optionalSettings = {
        welcome_message: 'Bienvenue sur monshopbot ! 🚀 Votre service de livraison express.',
        bot_description: 'Service de livraison express monshopbot',
        bot_short_description: 'monshopbot - Livraison express',
        admin_password: process.env.ADMIN_PASSWORD || 'admin0123456789'
    };

    Object.keys(optionalSettings).forEach(k => {
        if (settingsCols.includes(k)) finalSettings[k] = optionalSettings[k];
    });

    const { error: settingsError } = await supabase.from('bot_settings').upsert(finalSettings);
    if (settingsError) console.error('❌ Settings update failed:', settingsError.message);

    // 2. Demo Products (Legal)
    console.log('🍎 Adding legal products...');
    const products = [
        {
            id: 'prod_banana',
            name: 'Bananes Bio (1kg)',
            price: 2.50,
            category: 'Fruits',
            image_url: 'https://images.unsplash.com/photo-1571771894821-ad9902621ec0?auto=format&fit=crop&w=800&q=80',
            description: 'Bananes fraîches et biologiques, parfaites pour vos smoothies.',
            stock: 100,
            unit: 'kg'
        },
        {
            id: 'prod_flour',
            name: 'Farine de Blé T55',
            price: 1.80,
            category: 'Épicerie',
            image_url: 'https://images.unsplash.com/photo-1509440159596-0249088772ff?auto=format&fit=crop&w=800&q=80',
            description: 'Farine de qualité supérieure pour toutes vos pâtisseries.',
            stock: 50,
            unit: 'pièce'
        },
        {
            id: 'prod_milk',
            name: 'Lait Entier Bio (1L)',
            price: 1.45,
            category: 'Frais',
            image_url: 'https://images.unsplash.com/photo-1563636619-e9108b901977?auto=format&fit=crop&w=800&q=80',
            description: 'Lait frais de ferme, pasteurisé et riche en goût.',
            stock: 80,
            unit: 'pièce'
        },
        {
            id: 'prod_eggs',
            name: 'Œufs Frais x12',
            price: 3.20,
            category: 'Frais',
            image_url: 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=800&q=80',
            description: 'Douzaine d\'œufs de poules élevées en plein air.',
            stock: 40,
            unit: 'boîte'
        },
        {
            id: 'prod_bread',
            name: 'Baguette Tradition',
            price: 1.20,
            category: 'Boulangerie',
            image_url: 'https://images.unsplash.com/photo-1509440159596-0249088772ff?auto=format&fit=crop&w=800&q=80',
            description: 'Croustillante et cuite au feu de bois.',
            stock: 30,
            unit: 'pièce'
        }
    ];

    for (const p of products) {
        await supabase.from('bot_products').upsert({ ...p, is_active: true });
    }

    // 3. Demo Users
    console.log('👥 Adding fake clients...');
    const fakeUsers = [
        { id: 'tg_11111', platform: 'telegram', first_name: 'Jean', username: 'jean_demo', is_approved: true, referral_code: 'REF1' },
        { id: 'tg_22222', platform: 'telegram', first_name: 'Marie', username: 'marie_demo', is_approved: true, referral_code: 'REF2' },
        { id: 'tg_33333', platform: 'telegram', first_name: 'Luc', username: 'luc_demo', is_approved: true, referral_code: 'REF3' },
        { id: 'wa_44444', platform: 'whatsapp', first_name: 'Sophie', username: 'sophie_wa', is_approved: true, referral_code: 'REF4' },
        { id: 'wa_55555', platform: 'whatsapp', first_name: 'Thomas', username: 'thomas_wa', is_approved: true, referral_code: 'REF5' }
    ];

    for (const u of fakeUsers) {
        await supabase.from('bot_users').upsert({
            ...u,
            date_inscription: randomDate(new Date(2026, 0, 1), new Date()),
            is_active: true
        });
    }

    // 4. Demo Orders (Populate Charts)
    console.log('📦 Generating orders for analytics...');
    const orderCols = await getColumns('bot_orders');
    
    const statuses = ['delivered', 'delivered', 'delivered', 'delivered', 'cancelled', 'pending'];
    const districts = ['Paris 01', 'Paris 08', 'Paris 16', 'Boulogne', 'Neuilly'];
    
    for (let i = 0; i < 40; i++) {
        const user = fakeUsers[Math.floor(Math.random() * fakeUsers.length)];
        const product = products[Math.floor(Math.random() * products.length)];
        const qty = Math.floor(Math.random() * 3) + 1;
        const total = product.price * qty;
        const status = statuses[Math.floor(Math.random() * statuses.length)];
        const date = randomDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), new Date());

        const orderData = {
            id: `ord_${makeId()}`,
            user_id: user.id,
            total_price: total,
            status: status,
            created_at: date
        };

        // Add optional fields only if we detected them or if detection failed (guessing)
        const tryAdd = (key, val) => {
            if (orderCols.length === 0 || orderCols.includes(key)) orderData[key] = val;
        };

        tryAdd('updated_at', date);
        tryAdd('items', `${product.name} x${qty}`);
        tryAdd('address', `${Math.floor(Math.random() * 100) + 1} Rue de la Demo`);
        tryAdd('city', 'Paris');
        tryAdd('district', districts[Math.floor(Math.random() * districts.length)]);
        tryAdd('platform', user.platform);
        tryAdd('cart', JSON.stringify([{ id: product.id, name: product.name, price: product.price, qty }]));
        tryAdd('product_name', product.name);
        tryAdd('quantity', qty);
        tryAdd('first_name', user.first_name);
        tryAdd('username', user.username);

        const { error } = await supabase.from('bot_orders').insert(orderData);
        if (error) {
            // If it failed and we were guessing (empty table), let's try a VERY minimal insert
            if (orderCols.length === 0) {
                 await supabase.from('bot_orders').insert({
                    id: orderData.id,
                    user_id: orderData.user_id,
                    total_price: orderData.total_price,
                    status: orderData.status,
                    created_at: orderData.created_at
                 });
            }
        }
    }

    console.log('✅ Demo data population complete!');
    console.log('👉 Refresh your dashboard to see the results.');
}

populate();
