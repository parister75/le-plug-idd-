-- 🤖 SETUP SQL FOR monshopbot (monshopbot)
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. BOT USERS
CREATE TABLE IF NOT EXISTS bot_users (
    id TEXT PRIMARY KEY,
    platform TEXT,
    platform_id TEXT,
    type TEXT,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    language_code TEXT,
    phone TEXT,
    date_inscription TIMESTAMPTZ,
    last_active TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    is_active BOOLEAN DEFAULT TRUE,
    is_blocked BOOLEAN DEFAULT FALSE,
    blocked_at TIMESTAMPTZ,
    is_approved BOOLEAN DEFAULT FALSE,
    is_admin BOOLEAN DEFAULT FALSE,
    referred_by TEXT REFERENCES bot_users(id),
    referral_count INT DEFAULT 0,
    order_count INT DEFAULT 0,
    points FLOAT DEFAULT 0,
    wallet_balance FLOAT DEFAULT 0,
    is_livreur BOOLEAN DEFAULT FALSE,
    is_available BOOLEAN DEFAULT FALSE,
    current_city TEXT,
    data JSONB DEFAULT '{}',
    referral_code TEXT UNIQUE,
    tracked_messages JSONB DEFAULT '[]',
    last_menu_id TEXT
);

-- 2. PRODUCTS
CREATE TABLE IF NOT EXISTS bot_products (
    id TEXT PRIMARY KEY,
    name TEXT,
    description TEXT,
    price FLOAT,
    unit TEXT DEFAULT 'Pièce',
    unit_value TEXT DEFAULT '1',
    promo TEXT,
    image_url TEXT,
    category TEXT,
    city TEXT,
    stock INT DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    is_bundle BOOLEAN DEFAULT FALSE,
    bundle_config JSONB DEFAULT '{}',
    has_discounts BOOLEAN DEFAULT FALSE,
    discounts_config JSONB DEFAULT '[]',
    supplier_id TEXT,
    is_mp BOOLEAN DEFAULT FALSE,
    priority INT DEFAULT 0,
    marketplace_product_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. ORDERS
CREATE TABLE IF NOT EXISTS bot_orders (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES bot_users(id),
    items TEXT,
    cart JSONB DEFAULT '[]',
    total_price FLOAT,
    address TEXT,
    city TEXT,
    postal_code TEXT,
    district TEXT,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    scheduled_at TIMESTAMPTZ,
    livreur_id TEXT REFERENCES bot_users(id),
    livreur_name TEXT,
    feedback_rating INT,
    feedback_text TEXT,
    help_requests JSONB DEFAULT '[]',
    chat_count INT DEFAULT 0,
    client_reply TEXT,
    payment_method TEXT,
    points_awarded BOOLEAN DEFAULT FALSE,
    notif_1h_sent BOOLEAN DEFAULT FALSE,
    notif_30m_sent BOOLEAN DEFAULT FALSE,
    first_name TEXT, -- encrypted
    username TEXT, -- encrypted
    supplier_notified BOOLEAN DEFAULT FALSE,
    supplier_ready_at TIMESTAMPTZ,
    supplier_prep_time TEXT,
    supplier_id TEXT,
    delivered_at TIMESTAMPTZ,
    is_priority BOOLEAN DEFAULT FALSE,
    livreur_name TEXT
);

-- 4. SETTINGS
CREATE TABLE IF NOT EXISTS bot_settings (
    id TEXT PRIMARY KEY DEFAULT 'default',
    bot_name TEXT,
    welcome_message TEXT,
    welcome_message_enabled BOOLEAN DEFAULT TRUE,
    admin_password TEXT,
    admin_telegram_id TEXT,
    list_moderators TEXT,
    dashboard_url TEXT,
    private_contact_url TEXT,
    private_contact_wa_url TEXT,
    channel_url TEXT,
    bot_description TEXT,
    bot_short_description TEXT,
    payment_modes TEXT,
    maintenance_mode BOOLEAN DEFAULT FALSE,
    maintenance_message TEXT,
    maintenance_contact TEXT,
    accent_color TEXT,
    languages TEXT,
    payment_modes_config TEXT DEFAULT '[]',
    force_subscribe BOOLEAN DEFAULT FALSE,
    force_subscribe_channel_id TEXT,
    default_wa_name TEXT,
    enable_abandoned_cart_notifications BOOLEAN DEFAULT FALSE,
    msg_abandoned_cart TEXT,
    msg_welcome_back TEXT,
    msg_order_notif_livreur TEXT,
    msg_order_received_admin TEXT,
    msg_order_confirmed_client TEXT,
    enable_telegram BOOLEAN DEFAULT TRUE,
    enable_whatsapp BOOLEAN DEFAULT TRUE,
    enable_marketplace BOOLEAN DEFAULT TRUE,
    enable_fidelity BOOLEAN DEFAULT TRUE,
    enable_referral BOOLEAN DEFAULT TRUE,
    enable_help_menu BOOLEAN DEFAULT TRUE,
    dashboard_title TEXT,
    label_catalog_title TEXT,
    priority_delivery_enabled BOOLEAN DEFAULT FALSE,
    priority_delivery_price FLOAT DEFAULT 0,
    auto_approve_new BOOLEAN DEFAULT FALSE,
    notify_on_approval BOOLEAN DEFAULT FALSE,
    label_catalog TEXT,
    ui_icon_catalog TEXT,
    label_my_orders TEXT,
    ui_icon_orders TEXT,
    label_contact TEXT,
    ui_icon_contact TEXT,
    label_profile TEXT,
    ui_icon_profile TEXT,
    label_livreur_space TEXT,
    ui_icon_livreur TEXT,
    label_admin_bot TEXT,
    ui_icon_admin TEXT,
    label_admin_web TEXT,
    ui_icon_web TEXT,
    label_channel TEXT,
    ui_icon_channel TEXT,
    label_welcome TEXT,
    ui_icon_welcome TEXT,
    label_support TEXT,
    ui_icon_support TEXT,
    label_reviews TEXT,
    ui_icon_leave_review TEXT,
    ui_icon_view_reviews TEXT,
    label_users TEXT,
    label_info TEXT,
    ui_icon_info TEXT,
    status_pending_label TEXT,
    ui_icon_pending TEXT,
    status_taken_label TEXT,
    ui_icon_taken TEXT,
    status_delivered_label TEXT,
    ui_icon_success TEXT,
    status_cancelled_label TEXT,
    ui_icon_error TEXT,
    msg_auto_timer TEXT,
    msg_choose_qty TEXT,
    msg_search_livreur TEXT,
    msg_order_success TEXT,
    msg_help_intro TEXT,
    msg_status_taken TEXT,
    msg_status_delivered TEXT,
    msg_delay_report TEXT,
    msg_arrival_soon TEXT,
    msg_review_prompt TEXT,
    msg_review_thanks TEXT,
    msg_thanks_participation TEXT,
    msg_your_answer TEXT,
    points_exchange INT DEFAULT 100,
    points_ratio FLOAT DEFAULT 1,
    ref_bonus FLOAT DEFAULT 5,
    points_credit_value FLOAT DEFAULT 10,
    fidelity_wallet_max_pct INT DEFAULT 50,
    fidelity_min_spend FLOAT DEFAULT 50,
    fidelity_bonus_thresholds TEXT DEFAULT '5,10,15,20',
    fidelity_bonus_amount FLOAT DEFAULT 10,
    show_broadcasts_btn BOOLEAN DEFAULT TRUE,
    show_reviews_btn BOOLEAN DEFAULT TRUE,
    btn_back_menu TEXT,
    btn_back_menu_nav TEXT,
    btn_cart_resume TEXT,
    btn_client_mode TEXT,
    btn_back_generic TEXT,
    btn_verify_sub TEXT,
    btn_back_to_cart TEXT,
    btn_back_to_qty TEXT,
    btn_back_to_address TEXT,
    btn_back_to_options TEXT,
    btn_back_quick_menu TEXT,
    btn_back_to_livreur_menu TEXT,
    btn_back_main_menu_alt TEXT,
    btn_cancel TEXT,
    btn_cancel_alt TEXT,
    btn_cancel_order TEXT,
    btn_cancel_my_order TEXT,
    btn_abandon_delivery TEXT,
    btn_dont_use_credit TEXT,
    btn_send_now TEXT,
    btn_set_available TEXT,
    btn_leave_review TEXT,
    btn_view_reviews TEXT,
    btn_confirm_review TEXT,
    btn_supplier_ready TEXT,
    btn_supplier_my_sales TEXT,
    btn_supplier_menu TEXT,
    btn_supplier_prep_time TEXT,
    msg_supplier_new_order TEXT,
    msg_supplier_ready TEXT
);

-- 5. BROADCASTS
CREATE TABLE IF NOT EXISTS bot_broadcasts (
    id TEXT PRIMARY KEY,
    message TEXT,
    target_platform TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    start_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    status TEXT DEFAULT 'pending',
    success INT DEFAULT 0,
    failed INT DEFAULT 0,
    blocked INT DEFAULT 0,
    previously_blocked INT DEFAULT 0,
    blocked_names TEXT,
    poll_data JSONB DEFAULT '{}',
    badge TEXT,
    media_count INT DEFAULT 0,
    total_target INT DEFAULT 0,
    media_urls JSONB DEFAULT '[]',
    options JSONB DEFAULT '{}'
);

-- 6. STATS
CREATE TABLE IF NOT EXISTS bot_stats (
    id TEXT PRIMARY KEY DEFAULT 'global',
    total_users INT DEFAULT 0,
    total_orders INT DEFAULT 0,
    total_ca FLOAT DEFAULT 0,
    total_referrals INT DEFAULT 0
);

-- 7. REFERRALS
CREATE TABLE IF NOT EXISTS bot_referrals (
    id TEXT PRIMARY KEY,
    referrer_id TEXT REFERENCES bot_users(id),
    referred_id TEXT REFERENCES bot_users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. DAILY STATS
CREATE TABLE IF NOT EXISTS bot_daily_stats (
    id TEXT PRIMARY KEY,
    date DATE,
    new_users INT DEFAULT 0,
    new_orders INT DEFAULT 0,
    ca FLOAT DEFAULT 0
);

-- 9. REVIEWS
CREATE TABLE IF NOT EXISTS bot_reviews (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES bot_users(id),
    rating INT,
    text TEXT,
    first_name TEXT,
    username TEXT,
    is_public BOOLEAN DEFAULT TRUE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 10. SUPPLIERS
CREATE TABLE IF NOT EXISTS bot_suppliers (
    id TEXT PRIMARY KEY,
    name TEXT,
    telegram_id TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 11. MARKETPLACE PRODUCTS
CREATE TABLE IF NOT EXISTS supplier_marketplace (
    id TEXT PRIMARY KEY,
    supplier_id TEXT REFERENCES bot_suppliers(id),
    name TEXT,
    price FLOAT,
    stock INT DEFAULT 0,
    stock INTEGER DEFAULT 100,
    category TEXT,
    description TEXT,
    image_url TEXT,
    is_available BOOLEAN DEFAULT TRUE,
    is_validated BOOLEAN DEFAULT FALSE,
    unit VARCHAR(20) DEFAULT 'unit',
    priority INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    bundle_config JSONB DEFAULT '[]',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 12. MARKETPLACE ORDERS
CREATE TABLE IF NOT EXISTS supplier_market_orders (
    id TEXT PRIMARY KEY,
    supplier_id TEXT REFERENCES bot_suppliers(id),
    admin_id TEXT DEFAULT 'admin',
    products JSONB, -- list of objects
    total_price FLOAT,
    status TEXT DEFAULT 'pending',
    delivery_type TEXT,
    address TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 13. SUPPORT LOGS
CREATE TABLE IF NOT EXISTS bot_support_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT,
    staff_id TEXT,
    message TEXT,
    type TEXT DEFAULT 'text',
    direction TEXT DEFAULT 'out',
    staff_role TEXT DEFAULT 'admin',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 14. BOT STATE (For WA Sessions & Locks)
CREATE TABLE IF NOT EXISTS bot_state (
    id TEXT PRIMARY KEY,
    namespace TEXT,
    user_key TEXT,
    value JSONB DEFAULT '{}',
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- INITIAL DATA
-- ─────────────────────────────────────────────────────────────────────────────

-- Global Stats
INSERT INTO bot_stats (id, total_users, total_orders, total_ca, total_referrals) 
VALUES ('global', 0, 0, 0, 0)
ON CONFLICT (id) DO NOTHING;

-- Default Settings (Partial insertion, app will auto-repair missing fields)
INSERT INTO bot_settings (id, bot_name, dashboard_title, admin_password) 
VALUES ('default', 'monshopbot', 'monshopbot', 'admin0123456789')
ON CONFLICT (id) DO NOTHING;

-- Storage Bucket (Must be done via UI or SQL if supported)
-- INSERT INTO storage.buckets (id, name, public) VALUES ('uploads', 'uploads', true) ON CONFLICT (id) DO NOTHING;
