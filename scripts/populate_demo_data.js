require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const { encrypt } = require('../services/encryption');

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
    console.log('🚀 Finalizing LE PLUG IDF demo data (Full schema compliance)...');

    // 1. Rebranding Settings
    console.log('⚙️ Updating settings...');
    await supabase.from('bot_settings').upsert({
        id: 'default',
        bot_name: 'LE PLUG IDF',
        dashboard_title: 'LE PLUG IDF',
        welcome_message: 'Bienvenue sur LE PLUG IDF ! 🚀 Votre service de livraison express.',
        admin_password: process.env.ADMIN_PASSWORD || 'admin0123456789'
    });

    // 2. Demo Products (Legal & Stable Pexels Images)
    console.log('🍎 Adding products (compliant with latest schema)...');
    const products = [
        {
            id: 'prod_banana',
            name: 'Bananes Bio (1kg)',
            price: 2.50,
            category: 'Fruits',
            image_url: 'https://images.pexels.com/photos/2870882/pexels-photo-2870882.jpeg?auto=compress&cs=tinysrgb&w=800',
            description: 'Bananes fraîches et biologiques, parfaites pour vos smoothies.',
            stock: 100,
            unit: 'kg',
            priority: 1,
            is_active: true,
            bundle_config: []
        },
        {
            id: 'prod_flour',
            name: 'Farine de Blé T55',
            price: 1.80,
            category: 'Épicerie',
            image_url: 'https://images.pexels.com/photos/5765/agriculture-wheat-flour-grains.jpg?auto=compress&cs=tinysrgb&w=800',
            description: 'Farine de qualité supérieure pour toutes vos pâtisseries.',
            stock: 50,
            unit: 'pièce',
            priority: 2,
            is_active: true,
            bundle_config: []
        },
        {
            id: 'prod_milk',
            name: 'Lait Entier Bio (1L)',
            price: 1.45,
            category: 'Frais',
            image_url: 'https://images.pexels.com/photos/248412/pexels-photo-248412.jpeg?auto=compress&cs=tinysrgb&w=800',
            description: 'Lait frais de ferme, pasteurisé et riche en goût.',
            stock: 80,
            unit: 'pièce',
            priority: 3,
            is_active: true,
            bundle_config: []
        },
        {
            id: 'prod_eggs',
            name: 'Œufs Frais x12',
            price: 3.20,
            category: 'Frais',
            image_url: 'https://images.pexels.com/photos/162712/egg-white-food-protein-162712.jpeg?auto=compress&cs=tinysrgb&w=800',
            description: 'Douzaine d\'œufs de poules élevées en plein air.',
            stock: 40,
            unit: 'boîte',
            priority: 4,
            is_active: true,
            bundle_config: []
        },
        {
            id: 'prod_bread',
            name: 'Baguette Tradition',
            price: 1.20,
            category: 'Boulangerie',
            image_url: 'https://images.pexels.com/photos/1775043/pexels-photo-1775043.jpeg?auto=compress&cs=tinysrgb&w=800',
            description: 'Croustillante et cuite au feu de bois.',
            stock: 30,
            unit: 'pièce',
            priority: 5,
            is_active: true,
            bundle_config: []
        }
    ];

    await supabase.from('bot_orders').delete().neq('id', 'void');
    await supabase.from('bot_products').delete().neq('id', 'void');

    for (const p of products) {
        // We use a safe upsert approach to avoid errors on missing columns if migration hasn't run yet
        const { error } = await supabase.from('bot_products').insert(p);
        if (error) {
            console.warn(`[DB-WARN] Failed to insert ${p.name}: ${error.message}. Retrying without bundle_config...`);
            const fallback = { ...p };
            delete fallback.bundle_config;
            await supabase.from('bot_products').insert(fallback);
        }
    }

    // 3. Demo Users (ENCRYPTED)
    console.log('👥 Restoring users (Encrypted)...');
    const usersToRestore = [
        { id: 'telegram_1183134641', platform: 'telegram', platform_id: '1183134641', first_name: 'Gazolina94', username: 'Gazolina94', type: 'user' },
        { id: 'telegram_user1', platform: 'telegram', platform_id: '1', first_name: 'Jean', username: 'jean_demo', type: 'user' },
        { id: 'telegram_user2', platform: 'telegram', platform_id: '2', first_name: 'Marie', username: 'marie_demo', type: 'user' },
        { id: 'whatsapp_user4', platform: 'whatsapp', platform_id: '4', first_name: 'Sophie', username: 'sophie_wa', type: 'user' }
    ];

    await supabase.from('bot_users').delete().neq('id', 'void');

    for (const u of usersToRestore) {
        const encryptedUser = {
            id: u.id,
            platform: u.platform,
            platform_id: u.platform_id,
            type: u.type,
            first_name: encrypt(u.first_name),
            username: encrypt(u.username),
            date_inscription: randomDate(new Date(2026, 0, 1), new Date()),
            is_active: true,
            is_blocked: false,
            is_approved: true
        };
        await supabase.from('bot_users').insert(encryptedUser);
    }

    // 4. Demo Orders (Populate Charts)
    console.log('📦 Generating orders...');
    const statuses = ['delivered', 'delivered', 'delivered', 'delivered', 'cancelled', 'pending'];
    
    for (let i = 0; i < 40; i++) {
        const user = usersToRestore[Math.floor(Math.random() * usersToRestore.length)];
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
            created_at: date,
            is_priority: Math.random() > 0.8,
            livreur_name: 'Thomas (Livreur Demo)',
            cart: JSON.stringify([{ id: product.id, name: product.name, price: product.price, qty }]),
            product_name: product.name,
            quantity: qty,
            platform: user.platform
        };
        await supabase.from('bot_orders').insert(orderData);
    }

    console.log('✅ Restoration complete! Schema is being handled.');
}

populate();
