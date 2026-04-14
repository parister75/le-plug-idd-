const translations = {
    en: {
        // Main Menu & Buttons
        'menu_main': '🏠 <b>Main Menu</b>',
        'btn_catalog': '🛍 Catalog',
        'btn_cart': '🛒 Cart',
        'btn_orders': '📦 Orders',
        'btn_support': 'Support',
        'btn_contact': 'Contact',
        'btn_referral': 'Referral',
        'btn_channel': 'Channel',
        'btn_settings': 'Settings',
        'btn_admin': 'Admin Panel',
        'btn_back': '◀️ Back',
        'btn_back_menu': '🏠 Main Menu',

        // Welcome Messages
        'msg_welcome': '✨ <b>Welcome to {bot_name}, {first_name} !</b>',
        'msg_welcome_back': '👋 <b>Glad to see you back, {first_name} !</b>',
        'msg_access_denied': '🛑 <b>ACCESS RESTRICTED</b>\n\nTo access the bot, you must first contact the administrator.',
        'msg_language_choice': '🌐 <b>LANGUAGE CHOICE</b>\n\nSelect your preferred language:',

        // Livreur (Delivery)
        'btn_avail_on': '🟢 Available',
        'btn_avail_off': '🔴 Unavailable',
        'btn_deliveries_active': '🚚 ACTIVE DELIVERIES 🔥',
        'btn_planned': '🗓 Planned',
        'btn_history': '📈 History',
        'btn_client_mode': '🛍 Client Mode',
        'msg_livreur_welcome': '🚴 <b>Welcome, {first_name} !</b>',
        'msg_livreur_city': '📍 Area: <b>{city}</b>',
        'msg_livreur_status': '🔘 Status: <b>{status}</b>',

        // Order System & Cart
        'msg_order_cart_summary': '🛒 <b>Order Summary</b>',
        'msg_order_confirmed': '✅ <b>Order Registered!</b>',
        'msg_min_order': '⚠️ <b>Minimum order not reached</b>',
        'msg_session_expired': '❌ Session expired.',
        'msg_confirm_order': 'Confirm your order?',
        'msg_cart_empty': '📭 Your cart is empty.',
        'msg_prompt_address': '📍 <b>DELIVERY ADDRESS</b>\n\nPlease enter your full address (Number, Street, City) or send your live location:',
        'btn_checkout': '💳 Checkout ({total}€)',
        'btn_clear_cart': '🗑 Clear Cart',
        'btn_add_more': '➕ Add Products',
        'btn_back_to_cart': '◀️ Back to Cart',
        'payment_cash': 'Cash',
        'payment_card': 'Credit Card',
        'payment_crypto': 'Cryptocurrency',

        // New Menu Items
        'msg_client_mode': '🛒 <b>Client Mode</b>\n\nYou can now order as a normal client.',
        'msg_help_center': '❓ <b>HELP CENTER</b>\n\nHow can we help you?',
        'btn_where_is_order': '⏳ Where is my order?',
        'msg_track_order': '📦 <b>ORDER TRACKING</b>',
        'msg_chat_active': '💬 <b>ACTIVE CONVERSATION</b>\n\nYou are talking to an admin.',
        'btn_end_chat': '🛑 END CONVERSATION',

        // Livreur Status
        'label_available': 'AVAILABLE',
        'label_unavailable': 'UNAVAILABLE',
        'btn_active_deliveries_label': '🚚 MY ACTIVE DELIVERIES 🔥',
        'btn_orders_available_label': '📦 Orders',
        'btn_planned_orders_label': '🗓 Planned',
        'btn_history_orders_label': '📈 History',
        'btn_client_mode_label': '🛍 Client Mode',

        // Catalog & Qty
        'msg_catalog_choice': 'Choose a product:',
        'label_unit_price': 'Unit Price:',
        'label_choose_qty': 'Choose your quantity:',
        'btn_cancel': '❌ Cancel',
        'msg_added_to_cart_notif': 'Added to cart! 🛒',
        'msg_product_added': '✅ Product added!',
        'msg_cart_count': 'Your cart contains <b>{count}</b> article(s).',
        'btn_continue': '🛍️ Continue',
        'btn_cart_view': '💳 Cart',
        'btn_clear': '❌ Clear',
        'msg_selection': '🛒 Selection: {qty}x {name}',
        'label_price_total': 'Price:',
        'msg_what_to_do': 'What would you like to do?',
        'btn_add_to_cart': '🛒 Add to cart',
        'btn_checkout_now': '💳 Checkout now',
        'btn_review': '⭐️ Review / Comment',
        'label_total_price': 'TOTAL:',
        'btn_pay': '💳 Order',
        'msg_min_order_error': '⚠️ <b>Minimum order not reached</b>\n\nWe do not deliver below <b>{min}€</b>.\nYour current total: <b>{total}€</b>\n\nPlease add more products to your cart.',
        'btn_add_products': '🛍️ Add products',
        'btn_back_to_cart_label': '🛒 Back to Cart',
        'msg_step_address': '🏁 <b>Step 1: Delivery Address</b>',
        'msg_postal_code_required': '⚠️ <i>Postal code is mandatory.</i>',
        'msg_address_example': '💬 <i>Example: 45 rue de la Paix, 75002 Paris</i>',
        'msg_cart_items': '🛒 <b>Your Cart:</b>',
        'msg_amount_label': '💰 Amount:',
        'msg_choose_address': '👇 Choose a known address or send a new one:',
        'msg_send_precise_address': 'Please send your <b>precise address</b> including the <b>postal code</b> (Number, Street, ZIP, City).\n\n',
        'btn_back_cart_label': '◀️ Back to Cart',
        'btn_cancel_order_label': '❌ Cancel Order',

        // Scheduling
        'msg_when_delivery': '🕒 <b>When do you want to be delivered?</b>\n\nChoose if you want to be delivered as soon as possible or schedule a specific time.',
        'btn_priority_delivery': '🚀 Priority Delivery (+{price}€)',
        'btn_asap': '🏃 As soon as possible',
        'btn_schedule': '🕒 Schedule',
        'msg_choose_moment': '📅 <b>Choose delivery time:</b>',
        'label_today': 'Today ({date})',
        'label_tomorrow': 'Tomorrow ({date})',
        'msg_what_hour': '🕒 <b>At what time?</b>\n\nSelect a time slot:',
        'btn_skip_step': '⏭ Skip this step',
        'msg_delivery_details': '🏢 <b>Delivery Details (Optional)</b>\n\nIndicate your <b>door code, building code, floor, apartment number</b> or any useful info for the courier.\n\nOtherwise, click the button below:',
        'btn_modify_address': '◀️ Modify address',

        // Orders History
        'msg_my_orders': '📦 <b>My Orders</b>',
        'label_profile': '👤 Profile:',
        'label_wallet': '💰 Wallet:',
        'label_loyalty': '🏆 Loyalty:',
        'msg_active_orders': '<b>🏃 Ongoing Orders:</b>',
        'msg_past_orders': '📋 <b>Past Orders:</b>',
        'label_delivered': '✅ Delivered',
        'label_cancelled': '❌ Cancelled',
        'label_taken': '🚚 In delivery',
        'label_pending': '⏳ Pending',
        'btn_manage_order': '🔍 Manage #{id}',

        // Order Summary & Payment
        'msg_order_cart_summary': '🛒 <b>Order Summary</b>',
        'label_address': '📍 Address:',
        'label_scheduled_for': '🕒 Scheduled for:',
        'label_delivery_asap': '🚀 Delivery: ASAP',
        'label_priority_option': '🚀 <b>Priority Option: +{fee}€</b>',
        'label_subtotal': '💰 Subtotal:',
        'label_credit_discount': '🎁 Credit Discount:',
        'label_total_to_pay': '💵 <b>TOTAL TO PAY: {total}€</b>',
        'msg_confirm_order': 'Do you confirm the order?',
        'btn_confirm_order_pm': '✅ Confirm order ({label})',

        // Courier (Livreur) System
        'msg_delivery_welcome': '🚴 <b>Welcome to the delivery team!</b>\n\nYou are now registered as a courier.\n\n<b>Use the menu below to manage your deliveries:</b>',
        'btn_livreur_menu_back': '◀️ Courier Menu',
        'msg_live_tracking': '<b>Live Tracking</b>\n\nFor the customer to follow your arrival:\n\n1. Click on the paperclip (📎) or (+) in this conversation\n2. Select <b>Location</b> or <b>Position</b>\n3. Choose <b>Share my live location</b> (Live Location)\n4. Select the duration (e.g., 1 hour)\n\nThe bot will automatically detect your movement to inform the customer.',
        'msg_livreur_status': '📢 <b>Current Status:</b> {status}\n\nDo you want to change your status?',
        'btn_available_label': '✅ Available',
        'btn_unavailable_label': '😴 Unavailable',
        'msg_quit_livreur_confirm_text': '⚠️ <b>Are you sure?</b>\n\nYou will no longer receive order alerts and your courier profile will be deactivated.',
        'btn_quit_livreur_final_label': '✅ Yes, leave the team',
        'msg_quit_livreur_success_text': '✅ <b>Profile successfully deactivated.</b>\nYou are no longer part of the delivery team.',
        'msg_update_pos_usage_text': '❌ Usage: /ma_position [city]',
        'msg_pos_updated_text': '📍 Sector updated: {city}',
        'msg_sector_selection_text': '📍 <b>SECTOR SELECTION</b>\n\nChoose your primary delivery zone:',
        'btn_sector_manual_label': '⌨️ Other (Manual entry)',
        'msg_sector_manual_prompt_text': '⌨️ <b>Manual Entry</b>\n\nPlease send the name of your city or sector (e.g., London, Paris...):',
        'msg_order_asap_available_text': '🚀 <b>Available Orders (ASAP)</b>\n\n',
        'msg_no_asap_orders_text': '📭 No immediate (ASAP) orders available.',
        'msg_no_planned_orders_text': '📭 No planned orders available at the moment.',
        'msg_order_mission_details_text': '📦 <b>Mission Details #{id}</b>\n\n',
        'btn_accept_mission_label': '🔥 ACCEPT MISSION 🔥',

        // Feedback & Confirmation
        'msg_order_registered': '✅ <b>Order registered!</b>\n\n📦 Product: {product_list}\n📍 Address: {address}\n{delivery_time}\n💰 Total: <b>{total}€</b>\n\n{success_icon} Searching for a courier...',
        'label_ongoing_orders_btn': '📦 My ongoing orders',
        'msg_first_order_welcome': '👋 <b>First order!</b>\nContact the admin to validate: {contact}',
        'msg_order_notif_livreur_template': '🆕 <b>NEW ORDER!</b>\n\n📦 {product_list}\n📍 {address}\n{scheduled}\n💰 <b>{total}€ ({pay_icon} {pay_label})</b>',
        'msg_order_received_admin_template': '🚨 <b>NEW ORDER!</b>\n{badge}\n👤 {client_name} (@{username})\n📦 {product_list}\n📍 {address}\n💰 {total}€ ({pay_icon} {pay_label})\n🔑 ID : <code>{order_id}</code>',

        // Marketplace & Supplier
        'label_my_shop': '🏪 <b>My Shop</b>',
        'label_marketplace_products': '📦 Marketplace Products',
        'label_retail_bot_products': '🛒 Bot Client Products',
        'msg_not_supplier': '❌ You are not registered as a supplier.',
        'label_shop_guide': '📖 <b>SHOP GUIDE</b>',
        'label_shop_guide_wholesale': '📦 <b>Wholesale Products</b>: Your bulk stocks offered to the administration.',
        'label_shop_guide_retail': '🛒 <b>Retail Products</b>: General catalog products linked to you.',
        'label_shop_guide_orders': '📋 <b>Orders</b>: Track sales and validate when a product is "Ready".',
        'label_shop_guide_settings': '⚙️ <b>Settings</b>: Enable/Disable Pickup or Delivery.',
        'msg_quit_shop_confirm_text': '⚠️ <b>Are you sure?</b>\n\nYour shop will no longer be visible and you will no longer receive orders.',
        'msg_quit_shop_success_text': '✅ <b>Supplier profile successfully deleted.</b>',
        'label_my_products_wholesale': '📦 <b>My Wholesale Products ({count})</b>',
        'label_my_products_retail': '🛒 <b>My Retail Products ({count})</b>',
        'label_stats_revenue': '💰 <b>Revenue: {total}€</b>',
        'label_stats_commission': '📈 Commission ({pct}%): {total}€',
        'btn_add_marketplace': '➕ Add Marketplace',
        'btn_propose_retail': '🤝 Propose (Bot)',
        'btn_shop_settings': '⚙️ Settings',
        'btn_shop_stats': '📊 Stats',
        'btn_shop_guide': '❓ Shop Guide',
        'msg_shop_empty': '📭 Your shop is empty.\nAdd your first product!',
        'msg_guide_chat_desc': 'Open a direct chat with the main administrator.',
        'msg_guide_stats_desc': 'View your revenue and history.',
        'btn_back_to_shop': '◀️ Return to Shop',
        'btn_confirm_quit': '✅ Yes, leave',
        'msg_wholesale_desc': 'These products are intended for the administration.\n\n',
        'label_price_unit': '💰 Price:',
        'label_on_sale': '✅ On sale',
        'label_out_of_stock': '❌ Hidden/Out of stock',
        'msg_retail_pause_hint': 'You can pause this product if it is out of stock.',
        'btn_pause_label': '⏸ Pause',
        'btn_resume_label': '▶️ Resume',
        'btn_back_list': '◀️ Back to List',
        'btn_shop_home': '🏠 Shop Menu',

        // Admin Console
        'label_admin_console': '🛠 <b>Telegram Administration Console</b>',
        'msg_admin_welcome': 'Welcome to your integrated manager.',
        'btn_admin_stats': '📊 Statistics',
        'btn_admin_orders': '📦 Orders',
        'btn_admin_livreurs': '🚴 Couriers',
        'btn_admin_users': '👥 Users',
        'btn_admin_broadcast': '🔔 Broadcast',
        'btn_admin_marketplace': '🏪 Marketplace',
        'btn_admin_settings': '⚙️ Settings',
        'btn_admin_features': '✨ Bot Guide',
        'btn_support_queue': '💬 Pending Support',
        'msg_support_queue_empty': '📭 No pending support requests.',
        'btn_quit_console': '◀️ Exit Console',

        // Admin extra
        'label_total_users': 'Users:',
        'label_total_ca': 'Total Sales:',
        'msg_admin_choose_section': 'Choose a section to manage your bot:',
        'btn_livreur_settings': '⚙️ Settings',
        'btn_back_quick_menu': '◀️ Menu',

        // Supplier/Marketplace extra
        'label_orders_plural': 'order(s)',
        'label_pickup': 'Pickup',
        'label_delivery': 'Delivery',
        'msg_manage_shop_from_tg': 'Manage your shop directly from Telegram',
        'label_mp_products_btn': '📦 Market Products',
        'label_bot_products_btn': '🛒 Bot Products',
        'label_orders_btn': 'Orders',
        'label_admin_chat_btn': '💬 Admin Support',
        'btn_quit_shop': '🚪 Leave Shop',
        'btn_quit_livreur': '🚪 Leave Delivery Team',
        'msg_help_menu': '❓ <b>HELP MENU</b>\n\nHow can we help you?',
        'btn_help_track': '📦 Track my order',
        'btn_help_chat': '💬 Chat with an admin',
        'btn_faq': '❓ FAQ',

        // Order management
        'msg_order_detail': '📦 <b>Order #{id}</b>',
        'label_status': '🔘 Status:',
        'label_payment': '💳 Payment:',
        'label_livreur': '🚴 Courier:',
        'label_details': '📝 Details:',
        'btn_cancel_my_order': '❌ Cancel Order',
        'msg_no_orders': '📭 No orders found.',
        'msg_confirm_cancel_order': '⚠️ <b>Cancel this order?</b>\n\nThis action is irreversible.',
        'btn_yes_cancel': '✅ Yes, cancel',
        'btn_no_cancel': '❌ No, keep',

        // User settings
        'msg_settings': '⚙️ <b>MY SETTINGS</b>',
        'btn_change_lang': '🌐 Change Language',
        'btn_saved_addresses': '📍 My Addresses',
        'btn_my_referral': '🎁 Referral Code',
        'label_referral_code': '🎁 Your code: <code>{code}</code>',
        'msg_referral_info': '👥 <b>REFERRAL PROGRAM</b>\n\nShare your code and earn rewards for each friend who joins!',

        // Catalog empty / not found
        'msg_catalog_empty': '📭 The catalog is currently empty.',
        'msg_product_not_found': '❌ Product not found.',

        // Address selection
        'label_use_address': '📌 {address}',
        'btn_enter_new_address': '✏️ Enter new address',

        // Livreur delivery actions
        'btn_start_delivery': '🚀 Start Delivery',
        'btn_finish_delivery': '✅ Mark as Delivered',
        'btn_contact_client': '📱 Contact Client',
        'msg_delivery_accepted': '✅ <b>Mission accepted!</b>\n\nPlease contact the client and confirm pickup.',
        'msg_no_active_deliveries': '📭 No active deliveries.',
        'msg_delivery_finished': '✅ <b>Delivery marked as complete.</b>',
    },
    fr: {
        // Defaults to settings, but can be used as fallback
    }
};

function t(ctxOrUser, key, defaultText = null, variables = {}) {
    // Determine the user object from ctx or direct object
    const user = (ctxOrUser && ctxOrUser.state && ctxOrUser.state.user) ? ctxOrUser.state.user : ctxOrUser;
    const lang = user?.language_code || user?.data?.language || 'fr';
    
    if (lang === 'fr') {
        let text = defaultText || key;
        for (const [k, v] of Object.entries(variables)) {
            text = text.replace(new RegExp(`{${k}}`, 'g'), v);
        }
        return text;
    }
    
    if (translations[lang] && translations[lang][key]) {
        let text = translations[lang][key];
        for (const [k, v] of Object.entries(variables)) {
            text = text.replace(new RegExp(`{${k}}`, 'g'), v);
        }
        return text;
    }
    
    let text = defaultText || key;
    for (const [k, v] of Object.entries(variables)) {
        text = text.replace(new RegExp(`{${k}}`, 'g'), v);
    }
    return text;
}

module.exports = { t, translations };
