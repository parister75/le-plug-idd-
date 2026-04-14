/**
 * MARKETPLACE FOURNISSEURS
 *
 * Mini Uber Eats interne : chaque fournisseur = un magasin
 * - Fournisseur : gère ses produits, stock, prix, photos via Telegram
 * - Admin : parcourt les magasins, commande des produits
 * - Notifications Telegram pour les commandes
 */

const { Markup } = require('telegraf');
const {
    getSupplierByTelegramId, getSuppliers, getSupplier,
    getMarketplaceProducts, getMarketplaceProduct, getAvailableMarketplaceProducts,
    saveMarketplaceProduct, deleteMarketplaceProduct, updateMarketplaceStock,
    createMarketplaceOrder, getMarketplaceOrders, getMarketplaceOrder, updateMarketplaceOrderStatus,
    getAppSettings, uploadMediaFromUrl, getOrder, updateOrderStatus, getSupplierDeliveryMode
} = require('../services/database');
const { safeEdit, esc, trackIntermediateMessage } = require('../services/utils');
const { notifyAdmins, sendMessageToUser, notifyLivreurs } = require('../services/notifications');
const { createPersistentMap } = require('../services/persistent_map');

// État pour le flow d'ajout de produit fournisseur
const awaitingProductName = new Map();
const awaitingProductPrice = new Map();
const awaitingProductDesc = new Map();
const awaitingProductPhoto = new Map();
const awaitingProductStock = new Map();
const awaitingProductCategory = new Map();
const awaitingProductEdit = new Map();
// Panier admin marketplace
const adminMarketCart = new Map();
// Chat Support Marketplace (Fournisseur -> Admin)
const awaitingSupplierAdminChat = new Map(); 

/**
 * Nettoie TOUS les états "awaiting" d'un utilisateur.
 * Appelé quand l'utilisateur quitte le flow marketplace (main_menu, view_catalog, etc.)
 * pour éviter que ses messages texte soient interceptés par le marketplace.
 */
function clearAllAwaitingMaps(userId) {
    const id = String(userId);
    const hadState = awaitingProductName.has(id) || awaitingProductPrice.has(id) ||
        awaitingProductDesc.has(id) || awaitingProductPhoto.has(id) ||
        awaitingProductStock.has(id) || awaitingProductCategory.has(id) ||
        awaitingProductEdit.has(id) || awaitingSupplierAdminChat.has(id);
    awaitingProductName.delete(id);
    awaitingProductPrice.delete(id);
    awaitingProductDesc.delete(id);
    awaitingProductPhoto.delete(id);
    awaitingProductStock.delete(id);
    awaitingProductCategory.delete(id);
    awaitingProductEdit.delete(id);
    awaitingSupplierAdminChat.delete(id);
    if (hadState) console.log(`[Marketplace] Cleared all awaiting maps for user ${id}`);
}

async function initMarketplaceState() {
    // Les maps sont en mémoire (éphémères) — pas besoin de persistance pour ces flows
    console.log('[Marketplace] État initialisé');
}

function setupMarketplaceHandlers(bot) {

    // ======================================================================
    //                    CÔTÉ FOURNISSEUR — GESTION PRODUITS
    // ======================================================================

    // Menu principal magasin fournisseur
    bot.action('mp_my_shop', async (ctx) => {
        await ctx.answerCbQuery();
        const userId = `telegram_${ctx.from.id}`;
        const user = await require('../services/database').getUser(userId);
        const supplier = await getSupplierByTelegramId(String(ctx.from.id));
        if (!supplier) return safeEdit(ctx, t(user, 'msg_not_supplier', '❌ Vous n\'êtes pas enregistré comme fournisseur.'), Markup.inlineKeyboard([[Markup.button.callback(t(user, 'btn_back_quick_menu', '◀️ Menu'), 'main_menu')]]));

        const [products, retailProducts, orders] = await Promise.all([
            getMarketplaceProducts(supplier.id),
            require('../services/database').getSupplierProducts(supplier.id),
            getMarketplaceOrders(supplier.id, 10)
        ]);
        const available = products.filter(p => p.is_available && p.stock > 0);
        const pendingOrders = orders.filter(o => ['pending', 'accepted'].includes(o.status));

        let text = t(user, 'label_my_shop', `🏪 <b>Mon Magasin</b>`) + `\n\n`;
        text += `👤 <b>${esc(supplier.name)}</b>\n`;
        text += t(user, 'label_marketplace_products', `📦 Marketplace`) + ` : ${products.length} produit(s) | ${available.length} dispo\n`;
        text += t(user, 'label_retail_bot_products', `🛒 Bot Client`) + ` : ${retailProducts.length} produit(s)\n`;
        if (pendingOrders.length > 0) text += `🔔 <b>${pendingOrders.length} ` + t(user, 'label_orders_plural', `commande(s)`) + ` marketplace !</b>\n`;
        
        const pickupIcon = supplier.allow_pickup !== false ? '✅' : '❌';
        const deliveryIcon = supplier.allow_delivery !== false ? '✅' : '❌';
        text += `\n📍 ` + t(user, 'label_pickup', `Retrait`) + ` : ${pickupIcon} | 🚚 ` + t(user, 'label_delivery', `Livraison`) + ` : ${deliveryIcon}\n`;
        text += `\n<i>` + t(user, 'msg_manage_shop_from_tg', `Gérez votre boutique directement depuis Telegram`) + `</i>`;

        await safeEdit(ctx, text, Markup.inlineKeyboard([
            [Markup.button.callback(t(user, 'label_mp_products_btn', '📦 Produits Marché'), 'mp_my_products'), Markup.button.callback(t(user, 'btn_add_marketplace', '➕ Ajouter Marketplace'), 'mp_add_product')],
            [Markup.button.callback(t(user, 'label_bot_products_btn', '🛒 Produits Bot'), 'mp_retail_products'), Markup.button.callback(t(user, 'btn_propose_retail', '🤝 Propose (Bot)'), 'mp_add_retail_product')],
            [Markup.button.callback(`📋 ` + t(user, 'label_orders_btn', 'Commandes') + `${pendingOrders.length ? ' ('+pendingOrders.length+')' : ''}`, 'mp_my_orders'), Markup.button.callback(t(user, 'btn_shop_settings', '⚙️ Réglages'), 'mp_shop_settings')],
            [Markup.button.callback(t(user, 'label_admin_chat_btn', '💬 Support Admin'), 'help_chat_admin')],
            [Markup.button.callback(t(user, 'btn_shop_stats', '📊 Stats'), 'mp_my_stats'), Markup.button.callback(t(user, 'btn_shop_guide', '❓ Guide Shop'), 'mp_shop_guide')],
            [Markup.button.callback(t(user, 'btn_back_menu', '◀️ Retour Menu'), 'main_menu')]
        ]));
    });

    bot.on('text', async (ctx, next) => {
        const id = String(ctx.from.id);
        const text = ctx.message.text ? ctx.message.text.trim() : '';

        if (text === '/guide') {
            await ctx.deleteMessage().catch(() => {});
            return showShopGuide(ctx);
        }
        return next();
    });

    bot.action('mp_shop_guide', async (ctx) => {
        await ctx.answerCbQuery();
        return showShopGuide(ctx);
    });

    async function showShopGuide(ctx) {
        const userId = `telegram_${ctx.from.id}`;
        const user = await require('../services/database').getUser(userId);
        const text = t(user, 'label_shop_guide', `📖 <b>GUIDE DES BOUTONS (SHOP)</b>`) + `\n\n` +
            t(user, 'label_shop_guide_wholesale', `📦 <b>Produits Marché</b> : Vos stocks en <b>GROS</b> que vous proposez à l'administration.`) + `\n` +
            t(user, 'label_shop_guide_retail', `🛒 <b>Produits Bot</b> : Les produits du menu client général qui vous sont liés.`) + `\n\n` +
            t(user, 'label_shop_guide_orders', `📋 <b>Commandes</b> : Suivre vos ventes et valider quand un produit est "Prêt".`) + `\n` +
            t(user, 'label_shop_guide_settings', `⚙️ <b>Réglages</b> : Activer ou désactiver le Retrait / la Livraison.`) + `\n\n` +
            t(user, 'label_admin_chat_btn', `💬 <b>Support Admin</b>`) + ` : ` + t(user, 'msg_guide_chat_desc', `Ouvrir un chat Direct avec l'administrateur principal.`) + `\n` +
            t(user, 'btn_shop_stats', `📊 <b>Stats</b>`) + ` : ` + t(user, 'msg_guide_stats_desc', `Voir votre chiffre d'affaires et historique.`);

        return safeEdit(ctx, text, Markup.inlineKeyboard([
            [Markup.button.callback(t(user, 'btn_back_to_shop', '◀️ Retour au Magasin'), 'mp_my_shop')]
        ]));
    }

    bot.action('mp_quit_confirm', async (ctx) => {
        await ctx.answerCbQuery();
        const userId = `telegram_${ctx.from.id}`;
        const user = await require('../services/database').getUser(userId);
        await safeEdit(ctx, t(user, 'msg_quit_shop_confirm_text', '⚠️ <b>Êtes-vous sûr ?</b>\n\nVotre boutique ne sera plus visible et vous ne recevrez plus de commandes.'), Markup.inlineKeyboard([
            [Markup.button.callback(t(user, 'btn_confirm_quit', '✅ Oui, quitter'), 'mp_quit_final')],
            [Markup.button.callback(t(user, 'btn_back', '◀️ Retour'), 'mp_my_shop')]
        ]));
    });

    bot.action('mp_quit_final', async (ctx) => {
        await ctx.answerCbQuery('Profil supprimé');
        const supplier = await getSupplierByTelegramId(String(ctx.from.id));
        if (supplier) {
            const { deleteSupplier } = require('../services/database');
            await deleteSupplier(supplier.id);
        }
        await safeEdit(ctx, '✅ <b>Profil de fournisseur supprimé avec succès.</b>', Markup.inlineKeyboard([
            [Markup.button.callback('◀️ Menu Principal', 'main_menu')]
        ]));
        await notifyAdmins(bot, `🚪 <b>DÉPART FOURNISSEUR</b>\n\n👤 ${ctx.from.first_name} a quitté le marketplace.`);
    });

    // Liste des produits du fournisseur
    bot.action('mp_my_products', async (ctx) => {
        await ctx.answerCbQuery();
        const userId = `telegram_${ctx.from.id}`;
        const user = await require('../services/database').getUser(userId);
        const supplier = await getSupplierByTelegramId(String(ctx.from.id));
        if (!supplier) return safeEdit(ctx, '❌ DENIED');

        const products = await getMarketplaceProducts(supplier.id);
        if (products.length === 0) {
            return safeEdit(ctx, t(user, 'msg_shop_empty', '📭 Votre magasin est vide.\nAjoutez votre premier produit !'), Markup.inlineKeyboard([
                [Markup.button.callback(t(user, 'btn_add_product', '➕ Ajouter un Produit'), 'mp_add_product')],
                [Markup.button.callback(t(user, 'btn_back', '◀️ Retour'), 'mp_my_shop')]
            ]));
        }

        let text = t(user, 'label_my_products_wholesale', `📦 <b>Mes Produits Marché ({count})</b>`, { count: products.length }) + `\n\n`;
        text += t(user, 'msg_wholesale_desc', `Ces produits sont destinés à l'administration.\n\n`);
        
        const chunk = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (v, i) => arr.slice(i * size, i * size + size));
        const productRows = chunk(products, 2);
        
        const buttons = productRows.map(row => row.map(p => {
            return Markup.button.callback(`✏️ ${p.name.substring(0, 18)}`, `mp_edit_${p.id}`);
        }));
        buttons.push([Markup.button.callback(t(user, 'btn_add', '➕ Ajouter'), 'mp_add_product'), Markup.button.callback(t(user, 'btn_back', '◀️ Retour'), 'mp_my_shop')]);

        await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
    });

    // Liste des produits RETAIL (bot client) assignés au fournisseur
    bot.action('mp_retail_products', async (ctx) => {
        await ctx.answerCbQuery();
        const supplier = await getSupplierByTelegramId(String(ctx.from.id));
        if (!supplier) return safeEdit(ctx, '❌ Accès refusé.');

        const products = await require('../services/database').getSupplierProducts(supplier.id);
        if (products.length === 0) {
            return safeEdit(ctx, '📭 Aucun produit du catalogue client ne vous est assigné.', Markup.inlineKeyboard([
                [Markup.button.callback('◀️ Retour', 'mp_my_shop')]
            ]));
        }

        let text = `🛒 <b>Mes Produits Client (${products.length})</b>\n\n`;
        text += `Ces produits apparaissent dans le catalogue général du bot.\n\n`;
        
        const chunk = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (v, i) => arr.slice(i * size, i * size + size));
        const productRows = chunk(products, 2);
        
        const buttons = productRows.map(row => row.map(p => {
             return Markup.button.callback(`${p.name.substring(0, 18)}`, `mp_retail_view_${p.id}`);
        }));
        buttons.push([Markup.button.callback('◀️ Retour', 'mp_my_shop')]);

        await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
    });

    // Vue simplifiée d'un produit retail
    bot.action(/^mp_retail_view_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const userId = `telegram_${ctx.from.id}`;
        const user = await require('../services/database').getUser(userId);
        const pId = ctx.match[1];
        const { getProducts } = require('../services/database');
        const all = await getProducts(true); // include inactive
        const p = all.find(x => String(x.id) === String(pId));
        
        if (!p) return safeEdit(ctx, '❌ NOT FOUND', Markup.inlineKeyboard([[Markup.button.callback(t(user, 'btn_back', '◀️ Retour'), 'mp_retail_products')]]));

        const is_active = p.is_active !== false && (typeof p.stock !== 'number' || p.stock > 0);
        let text = `🛒 <b>${esc(p.name)}</b> (Catalogue Bot)\n\n`;
        text += t(user, 'label_price_unit', `💰 Prix:`) + ` ${p.price}€\n`;
        text += t(user, 'label_availability', `📦 Disponibilité:`) + ` ${is_active ? t(user, 'label_on_sale', '✅ En vente') : t(user, 'label_out_of_stock', '❌ Masqué/Rupture')}\n`;
        text += t(user, 'label_category', `🏷 Catégorie:`) + ` ${esc(p.category || 'Aucune')}\n\n`;
        text += `<i>` + t(user, 'msg_retail_pause_hint', `Vous pouvez mettre en pause ce produit s\'il est en rupture de stock.`) + `</i>`;

        await safeEdit(ctx, text, Markup.inlineKeyboard([
             [Markup.button.callback(is_active ? t(user, 'btn_pause_label', '⏸ Mettre en pause') : t(user, 'btn_resume_label', '▶️ Remettre en vente'), `mp_retail_toggle_${p.id}`)],
             [Markup.button.callback(t(user, 'btn_back_list', '◀️ Retour Liste'), 'mp_retail_products'), Markup.button.callback(t(user, 'btn_shop_home', '🏠 Menu Magasin'), 'mp_my_shop')]
        ]));
    });

    bot.action(/^mp_retail_toggle_(.+)$/, async (ctx) => {
        const pId = ctx.match[1];
        const { getProducts, saveProduct } = require('../services/database');
        const all = await getProducts(true);
        const p = all.find(x => String(x.id) === String(pId));
        if (!p) return ctx.answerCbQuery('Produit introuvable.');

        const newStatus = (p.is_active === false) ? true : false;
        await saveProduct({ id: p.id, is_active: newStatus });
        
        await ctx.answerCbQuery(`Produit ${newStatus ? 'activé' : 'désactivé'} !`);
        // Re-afficher la vue
        ctx.match = [null, p.id];
        const handler = bot.actions.find(a => a.re instanceof RegExp && a.re.test(`mp_retail_view_${p.id}`));
        // Simplement relancer mp_retail_view
        const trigger = `mp_retail_view_${p.id}`;
        // Fallback: manually call
        return bot.handleUpdate(ctx); // Bit hacky but should work if we let telegraf handle it
    });

    // Réglages boutique fournisseur
    bot.action('mp_shop_settings', async (ctx) => {
        await ctx.answerCbQuery();
        const supplier = await getSupplierByTelegramId(String(ctx.from.id));
        if (!supplier) return;

        const pickupIcon = supplier.allow_pickup !== false ? '✅' : '❌';
        const deliveryIcon = supplier.allow_delivery !== false ? '✅' : '❌';

        let text = `⚙️ <b>Paramètres de votre Boutique</b>\n\n`;
        text += `Gérez ici les options de retrait et de livraison que vous proposez.\n\n`;
        text += `📍 Retrait sur place: ${pickupIcon}\n`;
        text += `🚚 Livraison à l'admin: ${deliveryIcon}\n`;

        await safeEdit(ctx, text, Markup.inlineKeyboard([
            [Markup.button.callback(`${pickupIcon} Retrait sur place`, 'mp_toggle_pickup')],
            [Markup.button.callback(`${deliveryIcon} Livraison possible`, 'mp_toggle_delivery')],
            [Markup.button.callback('◀️ Retour', 'mp_my_shop')]
        ]));
    });

    bot.action('mp_toggle_pickup', async (ctx) => {
        const supplier = await getSupplierByTelegramId(String(ctx.from.id));
        if (!supplier) return;
        supplier.allow_pickup = (supplier.allow_pickup === false);
        await require('../services/database').saveSupplier(supplier);
        await ctx.answerCbQuery(`Retrait sur place: ${supplier.allow_pickup ? 'ACTI' : 'DÉSACTI'}VÉ`);
        // Refresh settings view
        ctx.match = ['mp_shop_settings'];
        const triggerHandler = bot.actions.get('mp_shop_settings');
        if (triggerHandler) await triggerHandler(ctx);
    });

    bot.action('mp_toggle_delivery', async (ctx) => {
        const supplier = await getSupplierByTelegramId(String(ctx.from.id));
        if (!supplier) return;
        supplier.allow_delivery = (supplier.allow_delivery === false);
        await require('../services/database').saveSupplier(supplier);
        await ctx.answerCbQuery(`Livraison: ${supplier.allow_delivery ? 'ACTI' : 'DÉSACTI'}VÉE`);
        // Refresh settings view
        ctx.match = ['mp_shop_settings'];
        const triggerHandler = bot.actions.get('mp_shop_settings');
        if (triggerHandler) await triggerHandler(ctx);
    });

    // Détail + édition d'un produit fournisseur
    bot.action(/^mp_edit_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const productId = ctx.match[1];
        const product = await getMarketplaceProduct(productId);
        if (!product) return safeEdit(ctx, '❌ Produit introuvable.');

        const status = product.is_available && product.stock > 0 ? '✅ En vente' : '❌ Indisponible';
        let text = `📋 <b>Détail Produit</b>\n\n`;
        text += `📛 <b>${esc(product.name)}</b>\n`;
        text += `💰 Prix : <b>${product.price}€</b>\n`;
        text += `📦 Stock : <b>${product.stock || 0}</b>\n`;
        text += `🏷 Catégorie : ${product.category ? esc(product.category) : 'Aucune'}\n`;
        text += `📝 Description : ${product.description ? esc(product.description) : 'Aucune'}\n`;
        text += `📊 Statut : ${status}\n`;
        if (product.image_url) text += `📸 Photo : ✅\n`;

        await safeEdit(ctx, text, {
            ...Markup.inlineKeyboard([
                [Markup.button.callback('💰 Modifier Prix', `mp_chprice_${productId}`), Markup.button.callback('📦 Modifier Stock', `mp_chstock_${productId}`)],
                [Markup.button.callback('📝 Modifier Description', `mp_chdesc_${productId}`), Markup.button.callback('📸 Changer Photo', `mp_chphoto_${productId}`)],
                [Markup.button.callback('🏷 Catégorie', `mp_chcat_${productId}`), Markup.button.callback(product.is_available ? '⏸ Pause' : '▶️ En vente', `mp_toggle_${productId}`)],
                [Markup.button.callback('🗑 Supprimer', `mp_delete_${productId}`), Markup.button.callback('◀️ Retour', 'mp_my_products')]
            ]),
            photo: product.image_url || null
        });
    });

    // Toggle disponibilité
    bot.action(/^mp_toggle_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const product = await getMarketplaceProduct(ctx.match[1]);
        if (!product) return;
        await saveMarketplaceProduct({ id: product.id, is_available: !product.is_available });
        // Re-afficher le détail
        ctx.match = [null, product.id]; // hack pour réutiliser mp_edit
        const handler = bot.listeners?.find?.(l => l.trigger?.source === '^mp_edit_(.+)$');
        // Simplement re-trigger l'action
        return safeEdit(ctx, `${product.is_available ? '⏸' : '▶️'} Produit <b>${esc(product.name)}</b> ${product.is_available ? 'mis en pause' : 'remis en vente'}.`, Markup.inlineKeyboard([
            [Markup.button.callback('◀️ Retour au produit', `mp_edit_${product.id}`)],
            [Markup.button.callback('◀️ Mes Produits', 'mp_my_products')]
        ]));
    });

    // Supprimer un produit
    bot.action(/^mp_delete_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const product = await getMarketplaceProduct(ctx.match[1]);
        if (!product) return;
        await safeEdit(ctx, `⚠️ Supprimer <b>${esc(product.name)}</b> ?\nCette action est irréversible.`, Markup.inlineKeyboard([
            [Markup.button.callback('✅ Oui, supprimer', `mp_confirmdelete_${product.id}`)],
            [Markup.button.callback('❌ Annuler', `mp_edit_${product.id}`)]
        ]));
    });

    bot.action(/^mp_confirmdelete_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery('🗑 Supprimé !');
        await deleteMarketplaceProduct(ctx.match[1]);
        return safeEdit(ctx, '✅ Produit supprimé.', Markup.inlineKeyboard([
            [Markup.button.callback('◀️ Mes Produits', 'mp_my_products')]
        ]));
    });

    // --- MODIFIER PRIX ---
    bot.action(/^mp_chprice_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        awaitingProductEdit.set(String(ctx.from.id), { field: 'price', productId: ctx.match[1] });
        await safeEdit(ctx, '💰 Envoyez le nouveau prix (ex: <b>15.50</b>) :', Markup.inlineKeyboard([
            [Markup.button.callback('❌ Annuler', `mp_edit_${ctx.match[1]}`)]
        ]));
    });

    // --- MODIFIER STOCK ---
    bot.action(/^mp_chstock_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        awaitingProductEdit.set(String(ctx.from.id), { field: 'stock', productId: ctx.match[1] });
        await safeEdit(ctx, '📦 Envoyez la nouvelle quantité en stock (ex: <b>25</b>) :', Markup.inlineKeyboard([
            [Markup.button.callback('❌ Annuler', `mp_edit_${ctx.match[1]}`)]
        ]));
    });

    // --- MODIFIER DESCRIPTION ---
    bot.action(/^mp_chdesc_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        awaitingProductEdit.set(String(ctx.from.id), { field: 'description', productId: ctx.match[1] });
        await safeEdit(ctx, '📝 Envoyez la nouvelle description :', Markup.inlineKeyboard([
            [Markup.button.callback('❌ Annuler', `mp_edit_${ctx.match[1]}`)]
        ]));
    });

    // --- MODIFIER CATÉGORIE ---
    bot.action(/^mp_chcat_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        awaitingProductEdit.set(String(ctx.from.id), { field: 'category', productId: ctx.match[1] });
        await safeEdit(ctx, '🏷 Envoyez la catégorie (ex: <b>Sneakers</b>, <b>Vêtements</b>, <b>Accessoires</b>) :', Markup.inlineKeyboard([
            [Markup.button.callback('❌ Annuler', `mp_edit_${ctx.match[1]}`)]
        ]));
    });

    // --- CHANGER PHOTO ---
    bot.action(/^mp_chphoto_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        awaitingProductEdit.set(String(ctx.from.id), { field: 'photo', productId: ctx.match[1] });
        await safeEdit(ctx, '📸 Envoyez une photo du produit :', Markup.inlineKeyboard([
            [Markup.button.callback('❌ Annuler', `mp_edit_${ctx.match[1]}`)]
        ]));
    });

    // ======= FLOW AJOUT PRODUIT =======

    bot.action(['mp_add_product', 'mp_add_retail_product'], async (ctx) => {
        await ctx.answerCbQuery();
        const supplier = await getSupplierByTelegramId(String(ctx.from.id));
        if (!supplier) return safeEdit(ctx, '❌ Accès refusé.');

        const target = ctx.callbackQuery.data === 'mp_add_retail_product' ? 'retail' : 'marketplace';
        awaitingProductName.set(String(ctx.from.id), { 
            supplierId: supplier.id, 
            supplierName: supplier.name,
            target 
        });
        
        const typeStr = target === 'retail' ? 'Catalogue Bot (Partenariat)' : 'Marketplace (Gros)';
        await safeEdit(ctx, `➕ <b>Nouveau Produit — ${typeStr}</b>\n\n📛 Envoyez le <b>nom</b> du produit :`, Markup.inlineKeyboard([
            [Markup.button.callback('❌ Annuler', 'mp_my_shop')]
        ]));
    });

    // ======= COMMANDES REÇUES (côté fournisseur) =======

    bot.action('mp_my_orders', async (ctx) => {
        await ctx.answerCbQuery();
        const supplier = await getSupplierByTelegramId(String(ctx.from.id));
        if (!supplier) return safeEdit(ctx, '❌ Accès refusé.');

        const [mpOrders, clientOrders] = await Promise.all([
            getMarketplaceOrders(supplier.id, 20),
            require('../services/database').getSupplierOrders(supplier.id, 20)
        ]);

        const activeMp = mpOrders.filter(o => ['pending', 'accepted', 'ready'].includes(o.status));
        const activeClient = clientOrders.filter(o => ['pending', 'livreur_assigned'].includes(o.status));

        if (activeMp.length === 0 && activeClient.length === 0) {
            return safeEdit(ctx, '📭 Aucune commande active.', Markup.inlineKeyboard([
                [Markup.button.callback('📜 Historique Marché', 'mp_orders_history')],
                [Markup.button.callback('◀️ Retour', 'mp_my_shop')]
            ]));
        }

        let text = `📋 <b>Mes Commandes Actives</b>\n\n`;
        
        if (activeMp.length > 0) {
            text += `🏢 <b>COMMANDES MARCHÉ (Admin)</b>\n`;
            activeMp.forEach((o) => {
                const items = Array.isArray(o.products) ? o.products.map(p => `${p.name} x${p.qty}`).join(', ') : 'Produits';
                const statusEmoji = o.status === 'pending' ? '⏳' : (o.status === 'accepted' ? '✅' : '📦');
                text += `${statusEmoji} <b>#${o.id.slice(-6)}</b> | ${o.total_price}€\n`;
                text += `   📦 ${items}\n`;
                text += `   🚚 ${o.delivery_type === 'pickup' ? '🏁 Retrait' : '🚀 Liv: ' + (o.address || 'Standard')}\n\n`;
            });
        }

        if (activeClient.length > 0) {
            text += `👤 <b>COMMANDES CLIENTS (Bot)</b>\n`;
            activeClient.forEach((o) => {
                const products = o.cart || [];
                const items = products.map(p => `${p.productName} x${p.qty}`).join(', ');
                const statusEmoji = o.status === 'pending' ? '⏳' : '🛵';
                text += `${statusEmoji} <b>#${o.id.slice(-5)}</b> | ${o.total}€\n`;
                text += `   📦 ${items}\n`;
                text += `   📍 Adresse: ${esc(o.address || 'Non spécifiée')}\n\n`;
            });
        }

        const buttons = [];
        // Boutons pour Marketplace
        activeMp.forEach(o => {
            const shortId = o.id.slice(-6);
            if (o.status === 'pending') {
                buttons.push([Markup.button.callback(`✅ Accepter #${shortId}`, `mp_accept_${o.id}`), Markup.button.callback(`❌ Refuser #${shortId}`, `mp_reject_${o.id}`)]);
            } else if (o.status === 'accepted') {
                buttons.push([Markup.button.callback(`📦 Prêt #${shortId}`, `mp_ready_${o.id}`), Markup.button.callback(`❌ Refuser #${shortId}`, `mp_reject_${o.id}`)]);
            }
            // Toujours permettre de parler à l'admin qui a commandé
            buttons.push([Markup.button.callback(`💬 Parler à l'Admin (#${shortId})`, `mp_chat_admin_${o.id}`)]);
        });

        // Boutons pour Client Orders (Vue seule pour l'instant)
        activeClient.forEach(o => {
            buttons.push([Markup.button.callback(`📋 Détail Client #${o.id.slice(-5)}`, `mp_client_order_view_${o.id}`)]);
        });

        buttons.push([Markup.button.callback('📜 Historique Marché', 'mp_orders_history')]);
        buttons.push([Markup.button.callback('◀️ Retour', 'mp_my_shop')]);

        await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
    });

    // Vue d'une commande client pour le fournisseur
    bot.action(/^mp_client_order_view_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const oId = ctx.match[1];
        const { getOrder } = require('../services/database');
        const order = await getOrder(oId);
        if (!order) return safeEdit(ctx, '❌ Commande introuvable.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'mp_my_orders')]]));

        let text = `👤 <b>Commande Client #${order.id.slice(-5)}</b>\n\n`;
        text += `📉 Statut : <b>${order.status}</b>\n`;
        text += `📍 Adresse : ${esc(order.address)}\n`;
        text += `💰 Total : <b>${order.total}€</b>\n\n`;
        text += `📦 <b>Produits :</b>\n`;
        (order.cart || []).forEach(p => {
            text += `• ${p.productName} x${p.qty} (${p.price}€)\n`;
        });
        text += `\n<i>Note: Les commandes clients sont gérées globalement par l'admin et les livreurs.</i>`;

        await safeEdit(ctx, text, Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'mp_my_orders')]]));
    });

    // Accepter une commande
    bot.action(/^mp_accept_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery('✅ Commande acceptée !');
        const orderId = ctx.match[1];
        await updateMarketplaceOrderStatus(orderId, 'accepted');
        
        const [order, supplier] = await Promise.all([
            getMarketplaceOrder(orderId),
            getSupplierByTelegramId(String(ctx.from.id))
        ]);

        // Notifier l'admin
        await notifyAdmins(null, `🏪 <b>Marketplace</b>\n\n✅ Commande <b>#${orderId.slice(-6)}</b> acceptée par <b>${supplier?.name || 'Fournisseur'}</b>.`);
        
        // Mettre à jour le message actuel (Alerte ou Liste)
        const shortId = orderId.slice(-6);
        const text = (ctx.message.text || ctx.message.caption || '').replace('⏳ EN ATTENTE', '').replace('📢 NOUVELLE COMMANDE', '✅ COMMANDE ACCEPTÉE');
        
        await safeEdit(ctx, `${text}\n\n✅ <b>Statut : Acceptée</b>`, Markup.inlineKeyboard([
            [Markup.button.callback(`📦 Marquer comme Prête`, `mp_ready_${orderId}`)],
            [Markup.button.callback(`💬 Parler à l'Admin`, `mp_chat_admin_${orderId}`)],
            [Markup.button.callback('📋 Voir mes commandes', 'mp_my_orders')]
        ]));
    });

    // Commande prête
    bot.action(/^mp_ready_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery('📦 Marquée comme prête !');
        const orderId = ctx.match[1];
        await updateMarketplaceOrderStatus(orderId, 'ready');
        
        const [order, supplier] = await Promise.all([
            getMarketplaceOrder(orderId),
            getSupplierByTelegramId(String(ctx.from.id))
        ]);

        const items = Array.isArray(order?.products) ? order.products.map(p => `${p.name} x${p.qty}`).join(', ') : '';
        await notifyAdmins(null, `🏪 <b>Marketplace</b>\n\n📦 Commande <b>#${orderId.slice(-6)}</b> PRÊTE !\n🏪 ${supplier?.name || 'Fournisseur'}\n📋 ${items}\n\n<i>Vous pouvez aller la récupérer.</i>`);

        const text = (ctx.message.text || ctx.message.caption || '').replace('✅ COMMANDE ACCEPTÉE', '📦 COMMANDE PRÊTE').replace('Acceptée', 'Prête');
        
        await safeEdit(ctx, `${text}\n\nL'admin a été notifié.`, Markup.inlineKeyboard([
            [Markup.button.callback(`💬 Parler à l'Admin`, `mp_chat_admin_${orderId}`)],
            [Markup.button.callback('◀️ Mes Commandes', 'mp_my_orders')]
        ]));
    });

    // ========== RETAIL ORDERS (Bot Client) ==========

    bot.action(/^retail_accept_(.+)$/, async (ctx) => {
        const orderId = ctx.match[1].trim();
        await ctx.answerCbQuery('✅ Commande acceptée !');

        const [order, supplier] = await Promise.all([
            getOrder(orderId),
            getSupplierByTelegramId(String(ctx.from.id))
        ]);

        if (!order) return ctx.reply("❌ Commande introuvable.");

        await updateOrderStatus(orderId, 'supplier_accepted');

        // Notifier l'admin
        await notifyAdmins(null, `🏪 <b>${supplier.name}</b>\n✅ Commande <b>#${orderId.slice(-5)}</b> acceptée.\n\nLe client a été notifié.`);

        // Notifier le client
            const alertMsg = `⚠️ <b>RÉCUPÉRATION DE COMPTE</b>\n\nUne demande de réinitialisation du mot de passe a été faite depuis Ma Boutique Telegram.\n\nSouhaitez-vous modifier le mot de passe d'administration ?`;
        await sendMessageToUser(order.user_id, alertMsg);

        // UI Fournisseur
        const text = (ctx.message.text || '').replace('NOUVELLE COMMANDE', 'COMMANDE ACCEPTÉE') + `\n\n✅ <b>Statut : Préparation</b>`;
        await safeEdit(ctx, text, Markup.inlineKeyboard([
            [Markup.button.callback('📦 Marquer comme PRÊTE', `retail_ready_${orderId}`)],
            [Markup.button.callback('📋 Mes Commandes', 'mp_my_orders')]
        ]));
    });

    bot.action(/^retail_ready_(.+)$/, async (ctx) => {
        const orderId = ctx.match[1].trim();
        await ctx.answerCbQuery('📦 Commande prête !');

        const [order, supplier] = await Promise.all([
            getOrder(orderId),
            getSupplierByTelegramId(String(ctx.from.id))
        ]);

        if (!order || !supplier) return ctx.reply("❌ Erreur (Commande ou Fournisseur introuvable).");

        await updateOrderStatus(orderId, 'supplier_ready');

        const deliveryMode = await getSupplierDeliveryMode(supplier.id);

        // Notifier l'admin
        const adminMsg = `🏪 <b>${supplier.name}</b>\n📦 Commande <b>#${orderId.slice(-5)}</b> PRÊTE !\n🚚 Mode : ${deliveryMode === 'admin' ? 'LIVREUR ADMIN' : 'LIVRAISON FOURNISSEUR'}`;
        await notifyAdmins(null, adminMsg);

        if (deliveryMode === 'admin') {
             // Notifier les livreurs
             const dbSettings = await getAppSettings();
             const msgLivreur = `🆕 <b>COMMANDE PRÊTE (#${orderId.slice(-5)})</b>\n\n📍 Récupération : <b>${supplier.name}</b>\n📍 Livraison : ${order.address}\n💰 Total : <b>${order.total_price}€</b>\n\n<i>Cliquez ci-dessous pour lancer la collecte :</i>`;
             await notifyLivreurs(null, msgLivreur, { 
                 reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🛒 Prendre la course', `take_order_${orderId}`)]]).reply_markup 
             });
        } else {
             // Statut passage en "Livreur Fournisseur"
             await updateOrderStatus(orderId, 'taken', { 
                 livreur_name: `Interne (${supplier.name})`,
                 livreur_id: `supplier_${supplier.id}`
             });
        }

        const text = (ctx.message.text || '').replace('COMMANDE ACCEPTÉE', 'COMMANDE PRÊTE') + `\n\n📦 <b>Statut : Prête / En attente collecte</b>`;
        await safeEdit(ctx, text, Markup.inlineKeyboard([[Markup.button.callback('📋 Mes Commandes', 'mp_my_orders')]]));
    });

    bot.action(/^retail_reject_(.+)$/, async (ctx) => {
        const orderId = ctx.match[1].trim();
        await ctx.answerCbQuery('❌ Commande refusée.');
        
        const order = await getOrder(orderId);
        if (order) {
            await updateOrderStatus(orderId, 'cancelled', { notes: 'Refusée par le fournisseur' });
            await sendMessageToUser(order.user_id, `❌ <b>Commande annulée</b>\n\nNous sommes désolés, notre partenaire n'a pas pu valider votre commande <b>#${orderId.slice(-5)}</b>.`);
        }

        await safeEdit(ctx, `❌ <b>Commande #${orderId.slice(-5)} refusée</b>`, Markup.inlineKeyboard([[Markup.button.callback('📋 Mes Commandes', 'mp_my_orders')]]));
    });

    // Rejeter une commande (Marketplace)
    bot.action(/^mp_reject_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const orderId = ctx.match[1];
        await safeEdit(ctx, `⚠️ Refuser la commande <b>#${orderId.slice(-6)}</b> ?`, Markup.inlineKeyboard([
            [Markup.button.callback('✅ Oui, refuser', `mp_confirmreject_${orderId}`)],
            [Markup.button.callback('❌ Non', 'mp_my_orders')]
        ]));
    });

    bot.action(/^mp_confirmreject_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery('❌ Commande refusée');
        const orderId = ctx.match[1];
        await updateMarketplaceOrderStatus(orderId, 'cancelled');
        const supplier = await getSupplierByTelegramId(String(ctx.from.id));
        await notifyAdmins(null, `🏪 <b>Marketplace</b>\n\n❌ Commande <b>#${orderId.slice(-6)}</b> refusée par <b>${supplier?.name || 'Fournisseur'}</b>.`);
        return safeEdit(ctx, `❌ <b>Commande #${orderId.slice(-6)} refusée.</b>\nL'administration a été prévenue.`, Markup.inlineKeyboard([
            [Markup.button.callback('◀️ Mes Commandes', 'mp_my_orders')]
        ]));
    });

    // Historique commandes fournisseur
    bot.action('mp_orders_history', async (ctx) => {
        await ctx.answerCbQuery();
        const supplier = await getSupplierByTelegramId(String(ctx.from.id));
        if (!supplier) return;

        const orders = await getMarketplaceOrders(supplier.id, 20);
        const completed = orders.filter(o => ['ready', 'collected', 'cancelled'].includes(o.status));

        if (completed.length === 0) {
            return safeEdit(ctx, '📭 Pas encore d\'historique.', Markup.inlineKeyboard([
                [Markup.button.callback('◀️ Retour', 'mp_my_orders')]
            ]));
        }

        let text = `📜 <b>Historique (${completed.length})</b>\n\n`;
        completed.slice(0, 10).forEach((o, i) => {
            const statusIcon = o.status === 'cancelled' ? '❌' : o.status === 'collected' ? '✅' : '📦';
            const items = Array.isArray(o.products) ? o.products.map(p => `${p.name} x${p.qty}`).join(', ') : 'Produits';
            text += `${statusIcon} #${o.id.slice(-6)} | ${items} | ${o.total_price}€\n`;
        });

        await safeEdit(ctx, text, Markup.inlineKeyboard([
            [Markup.button.callback('◀️ Retour', 'mp_my_orders')]
        ]));
    });

    // Statistiques fournisseur marketplace
    bot.action('mp_my_stats', async (ctx) => {
        await ctx.answerCbQuery();
        const supplier = await getSupplierByTelegramId(String(ctx.from.id));
        if (!supplier) return;

        const orders = await getMarketplaceOrders(supplier.id, 200);
        const products = await getMarketplaceProducts(supplier.id);
        const completed = orders.filter(o => ['ready', 'collected'].includes(o.status));
        const totalRevenue = completed.reduce((sum, o) => sum + (parseFloat(o.total_price) || 0), 0);
        const pendingCount = orders.filter(o => ['pending', 'accepted'].includes(o.status)).length;

        let text = `📊 <b>Statistiques Magasin</b>\n\n`;
        text += `🏪 <b>${esc(supplier.name)}</b>\n\n`;
        text += `📦 Produits en vente : ${products.filter(p => p.is_available).length}/${products.length}\n`;
        text += `📋 Total commandes : ${orders.length}\n`;
        text += `⏳ En cours : ${pendingCount}\n`;
        text += `✅ Complétées : ${completed.length}\n`;
        text += `❌ Annulées : ${orders.filter(o => o.status === 'cancelled').length}\n\n`;
        text += `💰 <b>Chiffre d'affaires : ${totalRevenue.toFixed(2)}€</b>\n`;
        if (supplier.commission_pct) {
            text += `📈 Commission (${supplier.commission_pct}%) : ${(totalRevenue * supplier.commission_pct / 100).toFixed(2)}€\n`;
        }

        await safeEdit(ctx, text, Markup.inlineKeyboard([
            [Markup.button.callback('◀️ Retour', 'mp_my_shop')]
        ]));
    });

    // ======================================================================
    //                    CÔTÉ ADMIN — PARCOURIR & COMMANDER
    // ======================================================================

    // Liste des magasins
    bot.action('mp_browse', async (ctx) => {
        await ctx.answerCbQuery();
        const suppliers = await getSuppliers();
        const activeSuppliers = suppliers.filter(s => s.is_active);

        if (activeSuppliers.length === 0) {
            return safeEdit(ctx, '📭 Aucun fournisseur actif.', Markup.inlineKeyboard([
                [Markup.button.callback('◀️ Retour', 'admin_menu')]
            ]));
        }

        let text = `🏪 <b>Marketplace — Magasins</b>\n\n`;
        text += `Parcourez les fournisseurs et commandez :\n\n`;

        for (const s of activeSuppliers) {
            const products = await getAvailableMarketplaceProducts(s.id);
            text += `🏪 <b>${esc(s.name)}</b> — ${products.length} produit(s) dispo\n`;
        }

        // Boutons fournisseurs 2x2
        const buttons = [];
        for (let i = 0; i < activeSuppliers.length; i += 2) {
            const row = [Markup.button.callback(`🏪 ${activeSuppliers[i].name}`, `mp_shop_${activeSuppliers[i].id}`)];
            if (i + 1 < activeSuppliers.length) {
                row.push(Markup.button.callback(`🏪 ${activeSuppliers[i+1].name}`, `mp_shop_${activeSuppliers[i+1].id}`));
            }
            buttons.push(row);
        }
        buttons.push([Markup.button.callback('🛒 Mon Panier', 'mp_admin_cart'), Markup.button.callback('📋 Mes Commandes', 'mp_admin_orders')]);
        buttons.push([Markup.button.callback('◀️ Retour Admin', 'admin_menu')]);

        await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
    });

    // Voir un magasin spécifique
    bot.action(/^mp_shop_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const supplierId = ctx.match[1];
        const supplier = await getSupplier(supplierId);
        if (!supplier) return safeEdit(ctx, '❌ Magasin introuvable.');

        const products = await getAvailableMarketplaceProducts(supplierId);

        let text = `🏪 <b>${esc(supplier.name)}</b>\n\n`;
        if (products.length === 0) {
            text += `📭 Aucun produit disponible.`;
        } else {
            products.forEach((p, i) => {
                text += `${i + 1}. <b>${esc(p.name)}</b>\n`;
                text += `   💰 ${p.price}€ | 📦 Stock: ${p.stock}`;
                if (p.category) text += ` | 🏷 ${esc(p.category)}`;
                text += `\n`;
                if (p.description) text += `   <i>${esc(p.description.substring(0, 60))}</i>\n`;
                text += `\n`;
            });
        }

        // Boutons 2x2
        const buttons = [];
        for (let i = 0; i < products.length; i += 2) {
            const row = [Markup.button.callback(`🛒 ${products[i].name.substring(0, 20)} — ${products[i].price}€`, `mp_addcart_${products[i].id}`)];
            if (i + 1 < products.length) {
                row.push(Markup.button.callback(`🛒 ${products[i+1].name.substring(0, 20)} — ${products[i+1].price}€`, `mp_addcart_${products[i+1].id}`));
            }
            buttons.push(row);
        }
        buttons.push([Markup.button.callback('🛒 Mon Panier', 'mp_admin_cart'), Markup.button.callback('📋 Mes Commandes', 'mp_admin_orders')]);
        if (supplier.telegram_id) {
            const targetId = supplier.telegram_id.startsWith('telegram_') ? supplier.telegram_id : `telegram_${supplier.telegram_id}`;
            buttons.push([Markup.button.callback('💬 Contacter le fournisseur', `admin_chat_user_${targetId}`)]);
        }
        buttons.push([Markup.button.callback('◀️ Retour', 'mp_browse')]);

        await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
    });

    // Ajouter au panier admin
    bot.action(/^mp_addcart_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery('✅ Ajouté au panier !');
        const productId = ctx.match[1];
        const product = await getMarketplaceProduct(productId);
        if (!product) return;

        const userId = String(ctx.from.id);
        const cart = adminMarketCart.get(userId) || {};

        if (cart[productId]) {
            cart[productId].qty += 1;
        } else {
            cart[productId] = {
                product_id: productId,
                name: product.name,
                price: product.price,
                qty: 1,
                supplier_id: product.supplier_id
            };
        }
        adminMarketCart.set(userId, cart);

        // Montrer le produit avec boutons quantité
        await safeEdit(ctx, `✅ <b>${esc(product.name)}</b> ajouté au panier !\n\nQuantité : <b>${cart[productId].qty}</b>`, Markup.inlineKeyboard([
            [
                Markup.button.callback('➖', `mp_cartminus_${productId}`),
                Markup.button.callback(`${cart[productId].qty}`, 'noop'),
                Markup.button.callback('➕', `mp_addcart_${productId}`)
            ],
            [Markup.button.callback('🛒 Voir Panier', 'mp_admin_cart')],
            [Markup.button.callback('◀️ Continuer', `mp_shop_${product.supplier_id}`)]
        ]));
    });

    // Diminuer quantité
    bot.action(/^mp_cartminus_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const productId = ctx.match[1];
        const userId = String(ctx.from.id);
        const cart = adminMarketCart.get(userId) || {};

        if (cart[productId]) {
            cart[productId].qty -= 1;
            if (cart[productId].qty <= 0) {
                const supplierId = cart[productId].supplier_id;
                delete cart[productId];
                adminMarketCart.set(userId, cart);
                return safeEdit(ctx, '🗑 Produit retiré du panier.', Markup.inlineKeyboard([
                    [Markup.button.callback('🛒 Voir Panier', 'mp_admin_cart')],
                    [Markup.button.callback('◀️ Retour', `mp_shop_${supplierId}`)]
                ]));
            }
            adminMarketCart.set(userId, cart);
        }

        const product = await getMarketplaceProduct(productId);
        await safeEdit(ctx, `📦 <b>${esc(product?.name || 'Produit')}</b>\n\nQuantité : <b>${cart[productId]?.qty || 0}</b>`, Markup.inlineKeyboard([
            [
                Markup.button.callback('➖', `mp_cartminus_${productId}`),
                Markup.button.callback(`${cart[productId]?.qty || 0}`, 'noop'),
                Markup.button.callback('➕', `mp_addcart_${productId}`)
            ],
            [Markup.button.callback('🛒 Voir Panier', 'mp_admin_cart')],
            [Markup.button.callback('◀️ Continuer', `mp_shop_${product?.supplier_id || ''}`)]
        ]));
    });

    // Noop button
    bot.action('noop', async (ctx) => { await ctx.answerCbQuery(); });

    // Voir panier admin
    bot.action('mp_admin_cart', async (ctx) => {
        await ctx.answerCbQuery();
        const userId = String(ctx.from.id);
        const cart = adminMarketCart.get(userId) || {};
        const items = Object.values(cart);

        if (items.length === 0) {
            return safeEdit(ctx, '🛒 Votre panier est vide.', Markup.inlineKeyboard([
                [Markup.button.callback('◀️ Retour Marketplace', 'mp_browse')]
            ]));
        }

        // Grouper par fournisseur
        const bySupplier = {};
        for (const item of items) {
            if (!bySupplier[item.supplier_id]) bySupplier[item.supplier_id] = [];
            bySupplier[item.supplier_id].push(item);
        }

        let text = `🛒 <b>Mon Panier</b>\n\n`;
        let grandTotal = 0;

        for (const [suppId, products] of Object.entries(bySupplier)) {
            const supplier = await getSupplier(suppId);
            text += `🏪 <b>${supplier ? esc(supplier.name) : 'Fournisseur'}</b>\n`;
            let subtotal = 0;
            products.forEach(p => {
                const lineTotal = p.price * p.qty;
                subtotal += lineTotal;
                text += `  • ${esc(p.name)} x${p.qty} = ${lineTotal.toFixed(2)}€\n`;
            });
            text += `  <b>Sous-total: ${subtotal.toFixed(2)}€</b>\n\n`;
            grandTotal += subtotal;
        }
        text += `💰 <b>TOTAL : ${grandTotal.toFixed(2)}€</b>`;

        const buttons = [];
        // Un bouton commander par fournisseur
        for (const [suppId] of Object.entries(bySupplier)) {
            const supplier = await getSupplier(suppId);
            buttons.push([Markup.button.callback(`📤 Commander chez ${supplier?.name?.substring(0, 20) || 'Fournisseur'}`, `mp_order_${suppId}`)]);
        }
        if (Object.keys(bySupplier).length > 1) {
            buttons.push([Markup.button.callback('📤 Commander TOUT', 'mp_order_all')]);
        }
        buttons.push([Markup.button.callback('🗑 Vider le panier', 'mp_clear_cart')]);
        buttons.push([Markup.button.callback('◀️ Retour Marketplace', 'mp_browse')]);

        await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
    });

    // Vider le panier
    bot.action('mp_clear_cart', async (ctx) => {
        await ctx.answerCbQuery('🗑 Panier vidé');
        adminMarketCart.delete(String(ctx.from.id));
        return safeEdit(ctx, '🗑 Panier vidé.', Markup.inlineKeyboard([
            [Markup.button.callback('◀️ Retour Marketplace', 'mp_browse')]
        ]));
    });

    // Commander chez un fournisseur spécifique
    bot.action(/^mp_order_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const supplierId = ctx.match[1];
        const userId = String(ctx.from.id);
        const cart = adminMarketCart.get(userId) || {};
        const items = Object.values(cart);

        let orderItems;
        if (supplierId === 'all') {
            orderItems = items;
        } else {
            orderItems = items.filter(i => i.supplier_id === supplierId);
        }

        if (orderItems.length === 0) {
            return safeEdit(ctx, '❌ Panier vide pour ce fournisseur.');
        }

        // Grouper par fournisseur pour créer les commandes
        const bySupplier = {};
        for (const item of orderItems) {
            if (!bySupplier[item.supplier_id]) bySupplier[item.supplier_id] = [];
            bySupplier[item.supplier_id].push(item);
        }

        const createdOrders = [];
        for (const [sId, products] of Object.entries(bySupplier)) {
            const total = products.reduce((sum, p) => sum + (p.price * p.qty), 0);
            const order = await createMarketplaceOrder({
                supplier_id: sId,
                admin_id: `telegram_${ctx.from.id}`,
                products: products.map(p => ({ product_id: p.product_id, name: p.name, price: p.price, qty: p.qty })),
                total_price: total
            });
            createdOrders.push({ order, supplier_id: sId });

            // Notifier le fournisseur par Telegram
            const supplier = await getSupplier(sId);
            if (supplier && supplier.telegram_id) {
                const itemsList = products.map(p => `• ${p.name} x${p.qty} (${(p.price * p.qty).toFixed(2)}€)`).join('\n');
                
                let orderDetails = `📢 <b>NOUVELLE COMMANDE ADMIN</b>\n\n`;
                orderDetails += `🛒 Commande <b>#${order.id.slice(-6)}</b>\n`;
                orderDetails += `🚚 Mode : ${order.delivery_type === 'pickup' ? '🏁 Click & Collect' : '🚀 Livraison'}\n`;
                if (order.address) orderDetails += `📍 Adresse : ${esc(order.address)}\n`;
                orderDetails += `\n${itemsList}\n`;
                orderDetails += `\n💰 <b>Total : ${total.toFixed(2)}€</b>\n\n`;
                orderDetails += `⏳ <b>Statut : EN ATTENTE</b>`;

                const targetId = supplier.telegram_id.startsWith('telegram_') ? supplier.telegram_id : `telegram_${supplier.telegram_id}`;
                await sendMessageToUser(targetId,
                    orderDetails,
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '✅ Accepter', callback_data: `mp_accept_${order.id}` }],
                                [{ text: '❌ Refuser', callback_data: `mp_reject_${order.id}` }],
                                [{ text: '📋 Voir commandes', callback_data: 'mp_my_orders' }]
                            ]
                        }
                    }
                );
            }
        }

        // Nettoyer le panier des items commandés
        for (const item of orderItems) {
            delete cart[item.product_id];
        }
        adminMarketCart.set(userId, cart);
        if (Object.keys(cart).length === 0) adminMarketCart.delete(userId);

        const orderIds = createdOrders.map(o => `#${o.order.id.slice(-6)}`).join(', ');
        await safeEdit(ctx, `✅ <b>Commande(s) passée(s) !</b>\n\n📋 ${orderIds}\n\nLes fournisseurs ont été notifiés par Telegram.`, Markup.inlineKeyboard([
            [Markup.button.callback('📋 Mes Commandes', 'mp_admin_orders')],
            [Markup.button.callback('◀️ Retour Marketplace', 'mp_browse')]
        ]));
    });

    // Commandes admin (historique)
    bot.action('mp_admin_orders', async (ctx) => {
        await ctx.answerCbQuery();
        const orders = await getMarketplaceOrders(null, 30);

        if (orders.length === 0) {
            return safeEdit(ctx, '📭 Aucune commande marketplace.', Markup.inlineKeyboard([
                [Markup.button.callback('◀️ Retour Marketplace', 'mp_browse')]
            ]));
        }

        let text = `📋 <b>Commandes Marketplace</b>\n\n`;
        for (const o of orders.slice(0, 15)) {
            const supplier = await getSupplier(o.supplier_id);
            const statusIcon = { pending: '⏳', accepted: '✅', ready: '📦', collected: '🏁', cancelled: '❌' }[o.status] || '❓';
            const items = Array.isArray(o.products) ? o.products.map(p => `${p.name} x${p.qty}`).join(', ') : '';
            text += `${statusIcon} <b>#${o.id.slice(-6)}</b> | 🏪 ${supplier?.name || '?'}\n`;
            text += `   ${items} | ${o.total_price}€\n\n`;
        }

        const activeOrders = orders.filter(o => o.status === 'ready');
        const buttons = activeOrders.map(o => [
            Markup.button.callback(`🏁 Récupérée #${o.id.slice(-6)}`, `mp_collected_${o.id}`)
        ]);
        buttons.push([Markup.button.callback('◀️ Retour Marketplace', 'mp_browse')]);

        await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
    });

    // Marquer comme récupérée
    bot.action(/^mp_collected_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery('✅ Récupérée !');
        await updateMarketplaceOrderStatus(ctx.match[1], 'collected');
        return safeEdit(ctx, '✅ Commande marquée comme récupérée.', Markup.inlineKeyboard([
            [Markup.button.callback('◀️ Retour Commandes', 'mp_admin_orders')]
        ]));
    });

    // --- CHAT FOURNISSEUR -> ADMIN (Marketplace) ---
    bot.action(/^mp_chat_admin_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const orderId = ctx.match[1];
        awaitingSupplierAdminChat.set(String(ctx.from.id), orderId);
        return safeEdit(ctx, `💬 <b>Discussion avec l'Admin</b>\n\nEnvoyez votre message pour la commande <b>#${orderId.slice(-6)}</b>.\n\nL'admin recevra votre message et pourra vous répondre.`, Markup.inlineKeyboard([
            [Markup.button.callback('❌ Annuler', 'mp_my_orders')]
        ]));
    });

    // ======= GESTION DES MESSAGES TEXTE (flows) =======

    // Cette fonction est appelée par le middleware principal pour gérer les messages texte
    // liés aux flows marketplace
    function handleMarketplaceText(ctx) {
        const userId = String(ctx.from.id);
        const text = ctx.message?.text?.trim();

        // Chat Fournisseur -> Admin
        if (awaitingSupplierAdminChat.has(userId)) {
            const orderId = awaitingSupplierAdminChat.get(userId);
            if (text && text.startsWith('/')) {
                awaitingSupplierAdminChat.delete(userId);
                return false;
            }
            awaitingSupplierAdminChat.delete(userId);
            return relaySupplierMessageToAdmin(ctx, orderId, text);
        }

        // Flow édition produit
        if (awaitingProductEdit.has(userId)) {
            const edit = awaitingProductEdit.get(userId);
            awaitingProductEdit.delete(userId);
            return handleProductEdit(ctx, edit, text);
        }

        // Flow ajout produit - étapes
        if (awaitingProductName.has(userId)) {
            const data = awaitingProductName.get(userId);
            awaitingProductName.delete(userId);
            data.name = text;
            awaitingProductPrice.set(userId, data);
            return safeEdit(ctx, `📛 Nom : <b>${esc(text)}</b>\n\n💰 Maintenant envoyez le <b>prix</b> (ex: 25.50) :`, Markup.inlineKeyboard([
                [Markup.button.callback('❌ Annuler', 'mp_my_shop')]
            ]));
        }

        if (awaitingProductPrice.has(userId)) {
            const data = awaitingProductPrice.get(userId);
            awaitingProductPrice.delete(userId);
            const price = parseFloat(text);
            if (isNaN(price) || price <= 0) {
                awaitingProductPrice.set(userId, data);
                return safeEdit(ctx, '❌ Prix invalide. Envoyez un nombre valide (ex: 25.50) :');
            }
            data.price = price;
            awaitingProductStock.set(userId, data);
            return safeEdit(ctx, `📛 ${esc(data.name)} — ${price}€\n\n📦 Envoyez la <b>quantité en stock</b> (ex: 50) :`, Markup.inlineKeyboard([
                [Markup.button.callback('❌ Annuler', 'mp_my_shop')]
            ]));
        }

        if (awaitingProductStock.has(userId)) {
            const data = awaitingProductStock.get(userId);
            awaitingProductStock.delete(userId);
            const stock = parseInt(text);
            if (isNaN(stock) || stock < 0) {
                awaitingProductStock.set(userId, data);
                return safeEdit(ctx, '❌ Stock invalide. Envoyez un nombre (ex: 50) :');
            }
            data.stock = stock;
            awaitingProductDesc.set(userId, data);
            return safeEdit(ctx, `📛 ${esc(data.name)} — ${data.price}€ — Stock: ${stock}\n\n📝 Envoyez une <b>description</b> (ou "skip" pour passer) :`, Markup.inlineKeyboard([
                [Markup.button.callback('⏭ Passer', `mp_skipdesc_${userId}`)],
                [Markup.button.callback('❌ Annuler', 'mp_my_shop')]
            ]));
        }

        if (awaitingProductDesc.has(userId)) {
            const data = awaitingProductDesc.get(userId);
            awaitingProductDesc.delete(userId);
            if (text.toLowerCase() !== 'skip') {
                data.description = text;
            }
            awaitingProductPhoto.set(userId, data);
            return safeEdit(ctx, `📛 ${esc(data.name)} — ${data.price}€\n\n📸 Envoyez une <b>photo</b> du produit (ou "skip" pour passer) :`, Markup.inlineKeyboard([
                [Markup.button.callback('⏭ Passer (sans photo)', `mp_skipphoto_${userId}`)],
                [Markup.button.callback('❌ Annuler', 'mp_my_shop')]
            ]));
        }

        // Si le user tape du texte alors qu'on attend une photo — skip photo
        if (awaitingProductPhoto.has(userId)) {
            const data = awaitingProductPhoto.get(userId);
            awaitingProductPhoto.delete(userId);
            if (text && text.toLowerCase() === 'skip') {
                awaitingProductCategory.set(userId, data);
                return safeEdit(ctx, `🏷 Envoyez une <b>catégorie</b> (ex: Sneakers, Textile...) ou "skip" :`, Markup.inlineKeyboard([
                    [Markup.button.callback('⏭ Passer', `mp_skipcat_${userId}`)],
                    [Markup.button.callback('❌ Annuler', 'mp_my_shop')]
                ]));
            }
            // Si c'est pas "skip", traiter comme une URL d'image potentielle
            if (text && (text.startsWith('http://') || text.startsWith('https://'))) {
                data.image_url = text;
            }
            awaitingProductCategory.set(userId, data);
            return safeEdit(ctx, `🏷 Envoyez une <b>catégorie</b> (ex: Sneakers, Textile...) ou "skip" :`, Markup.inlineKeyboard([
                [Markup.button.callback('⏭ Passer', `mp_skipcat_${userId}`)],
                [Markup.button.callback('❌ Annuler', 'mp_my_shop')]
            ]));
        }

        if (awaitingProductCategory.has(userId)) {
            const data = awaitingProductCategory.get(userId);
            awaitingProductCategory.delete(userId);
            if (text.toLowerCase() === 'skip') {
                return finalizeProduct(ctx, data);
            }
            data.category = text;
            return finalizeProduct(ctx, data);
        }

        return false; // Pas géré par la marketplace
    }

    // Gestion des photos envoyées
    function handleMarketplacePhoto(ctx) {
        const userId = String(ctx.from.id);

        // Chat Fournisseur -> Admin
        if (awaitingSupplierAdminChat.has(userId)) {
            const orderId = awaitingSupplierAdminChat.get(userId);
            awaitingSupplierAdminChat.delete(userId);
            return relaySupplierMessageToAdmin(ctx, orderId, ctx.message.caption || '');
        }

        // Photo pour édition
        if (awaitingProductEdit.has(userId) && awaitingProductEdit.get(userId).field === 'photo') {
            const edit = awaitingProductEdit.get(userId);
            awaitingProductEdit.delete(userId);
            return handlePhotoUpload(ctx, edit.productId);
        }

        // Photo pour nouveau produit
        if (awaitingProductPhoto.has(userId)) {
            const data = awaitingProductPhoto.get(userId);
            awaitingProductPhoto.delete(userId);
            return handleNewProductPhoto(ctx, data);
        }

        return false;
    }

    // Gestion des vidéos envoyées
    function handleMarketplaceVideo(ctx) {
        const userId = String(ctx.from.id);

        // Chat Fournisseur -> Admin
        if (awaitingSupplierAdminChat.has(userId)) {
            const orderId = awaitingSupplierAdminChat.get(userId);
            awaitingSupplierAdminChat.delete(userId);
            return relaySupplierMessageToAdmin(ctx, orderId, ctx.message.caption || '');
        }

        return false;
    }

    /**
     * Relaye un message du fournisseur vers l'admin (Marketplace)
     */
    async function relaySupplierMessageToAdmin(ctx, orderId, text) {
        try {
            const order = await getMarketplaceOrder(orderId);
            const supplier = await getSupplierByTelegramId(String(ctx.from.id));
            if (!order || !supplier) return;

            const adminMsg = `🏪 <b>MESSAGE FOURNISSEUR (Marketplace)</b>\n\n` +
                `📦 Commande : <b>#${orderId.slice(-6)}</b>\n` +
                `🏪 De : <b>${esc(supplier.name)}</b>\n\n` +
                (text ? `<i>"${esc(text)}"</i>` : (ctx.message.photo ? '📸 Photo reçue' : (ctx.message.video ? '🎥 Vidéo reçue' : '')));

            const options = { parse_mode: 'HTML' };
            // L'admin peut répondre directement au fournisseur en utilisant le système de chat client (car le fournisseur est aussi un user)
            const supplierUid = `telegram_${ctx.from.id}`;
            options.reply_markup = {
                inline_keyboard: [[{ text: '💬 Répondre au Fournisseur', callback_data: `admin_chat_user_${supplierUid}` }]]
            };

            if (ctx.message.photo) {
                options.photo = ctx.message.photo[ctx.message.photo.length - 1].file_id;
            } else if (ctx.message.video) {
                options.video = ctx.message.video.file_id;
                options.caption = adminMsg;
            }

            await notifyAdmins(bot, adminMsg, options);
            await ctx.reply(`✅ <b>Votre message a été transmis à l'administration.</b>`, { parse_mode: 'HTML' });
            return true;
        } catch (e) {
            console.error('Error relaying supplier message:', e);
            return true;
        }
    }

    bot.action(/^admin_val_mp_(.+)$/, async (ctx) => {
        if (!ctx.from.id) return;
        const pId = ctx.match[1];
        await require('../services/database').validateMarketplaceProduct(pId, true);
        await ctx.answerCbQuery('Produit validé ✅');
        await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n✅ <b>VALIDÉ !</b>');
    });

    bot.action(/^admin_promote_mp_(.+)$/, async (ctx) => {
        if (!ctx.from.id) return;
        const pId = ctx.match[1];
        try {
            await require('../services/database').promoteMarketplaceProduct(pId);
            await ctx.answerCbQuery('Promu au catalogue client ! 🚀');
            await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n🚀 <b>PROMU AU CATALOGUE !</b>');
        } catch (e) { await ctx.answerCbQuery('Erreur : ' + e.message, { show_alert: true }); }
    });

    async function handlePhotoUpload(ctx, productId) {
        try {
            const photo = ctx.message.photo;
            if (!photo || photo.length === 0) return;
            const fileId = photo[photo.length - 1].file_id;
            const fileUrl = await ctx.telegram.getFileLink(fileId);
            
            // UPLOAD PERSISTANT SUR SUPABASE
            const imageUrl = await uploadMediaFromUrl(fileUrl.toString(), `mp_${productId}_${Date.now()}.jpg`);
            
            await saveMarketplaceProduct({ id: productId, image_url: imageUrl || fileUrl.toString() });
            
            return ctx.reply('✅ <b>Photo mise à jour !</b>', {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour au produit', `mp_edit_${productId}`)]])
            });
        } catch (e) {
            console.error('handlePhotoUpload error:', e);
            return ctx.reply('❌ Erreur lors de l\'upload. Réessayez.');
        }
    }

    async function handleNewProductPhoto(ctx, data) {
        try {
            const photo = ctx.message.photo;
            if (!photo || photo.length === 0) return finalizeProduct(ctx, data);
            
            const fileId = photo[photo.length - 1].file_id;
            const fileUrl = await ctx.telegram.getFileLink(fileId);
            
            // UPLOAD PERSISTANT SUR SUPABASE
            const imageUrl = await uploadMediaFromUrl(fileUrl.toString(), `mp_new_${Date.now()}.jpg`);
            data.image_url = imageUrl || fileUrl.toString();

            // Demander la catégorie
            awaitingProductCategory.set(String(ctx.from.id), data);
            return ctx.reply(`📸 <b>Photo ajoutée !</b>\n\n🏷 Envoyez une <b>catégorie</b> (ex: Sneakers, Textile...) ou "skip" :`, {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('⏭ Passer', `mp_skipcat_${ctx.from.id}`)],
                    [Markup.button.callback('❌ Annuler', 'mp_my_shop')]
                ])
            });
        } catch (e) {
            console.error('handleNewProductPhoto error:', e.message);
            return finalizeProduct(ctx, data);
        }
    }

    async function handleProductEdit(ctx, edit, text) {
        const { field, productId } = edit;
        const update = { id: productId };

        switch (field) {
            case 'price':
                const price = parseFloat(text);
                if (isNaN(price) || price <= 0) return safeEdit(ctx, '❌ Prix invalide.');
                update.price = price;
                break;
            case 'stock':
                const stock = parseInt(text);
                if (isNaN(stock) || stock < 0) return safeEdit(ctx, '❌ Stock invalide.');
                update.stock = stock;
                update.is_available = stock > 0;
                break;
            case 'description':
                update.description = text;
                break;
            case 'category':
                update.category = text;
                break;
            default:
                return;
        }

        await saveMarketplaceProduct(update);
        return safeEdit(ctx, `✅ ${field === 'price' ? 'Prix' : field === 'stock' ? 'Stock' : field === 'description' ? 'Description' : 'Catégorie'} mis à jour !`, Markup.inlineKeyboard([
            [Markup.button.callback('◀️ Retour au produit', `mp_edit_${productId}`)]
        ]));
    }

    // Skip description dans le flow d'ajout
    bot.action(/^mp_skipdesc_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const userId = ctx.match[1];
        const data = awaitingProductDesc.get(userId);
        if (!data) return;
        awaitingProductDesc.delete(userId);
        awaitingProductPhoto.set(userId, data);
        return safeEdit(ctx, `📸 Envoyez une <b>photo</b> du produit (ou passez) :`, Markup.inlineKeyboard([
            [Markup.button.callback('⏭ Passer (sans photo)', `mp_skipphoto_${userId}`)],
            [Markup.button.callback('❌ Annuler', 'mp_my_shop')]
        ]));
    });

    // Skip photo dans le flow d'ajout
    bot.action(/^mp_skipphoto_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const userId = ctx.match[1];
        const data = awaitingProductPhoto.get(userId);
        if (!data) return;
        awaitingProductPhoto.delete(userId);
        awaitingProductCategory.set(userId, data);
        return safeEdit(ctx, `🏷 Envoyez une <b>catégorie</b> (ex: Sneakers, Textile...) ou passez :`, Markup.inlineKeyboard([
            [Markup.button.callback('⏭ Passer', `mp_skipcat_${userId}`)],
            [Markup.button.callback('❌ Annuler', 'mp_my_shop')]
        ]));
    });

    // Skip catégorie dans le flow d'ajout
    bot.action(/^mp_skipcat_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const userId = ctx.match[1];
        const data = awaitingProductCategory.get(userId);
        if (!data) return;
        awaitingProductCategory.delete(userId);
        return finalizeProduct(ctx, data);
    });

    async function finalizeProduct(ctx, data) {
        try {
            const isRetail = data.target === 'retail'; // Nouveau flag pour partenariat
            
            if (isRetail) {
                // Submission pour le catalogue principal (Retail)
                const { saveProduct } = require('../services/database');
                const product = await saveProduct({
                    name: data.name,
                    price: data.price,
                    stock: data.stock || 0,
                    description: data.description || '',
                    image_url: data.image_url || '',
                    category: data.category || '',
                    is_available: false, // EN ATTENTE DE VALIDATION POUR RETAIL
                    supplier_id: data.supplierId
                });

                const adminMsg = `🤝 <b>PROPOSITION PARTENARIAT (Retail)</b>\n\n` +
                    `🏪 Fournisseur : <b>${esc(data.supplierName || 'Inconnu')}</b>\n` +
                    `📦 Produit : <b>${esc(data.name)}</b>\n` +
                    `💰 Prix : <b>${data.price}€</b>\n\n` +
                    `<i>Ce produit est masqué (is_available=false) dans le catalogue client jusqu'à votre validation DNS Ma Boutique Telegram.</i>`;

                await notifyAdmins(bot, adminMsg, {
                    reply_markup: {
                        inline_keyboard: [[{ text: '⚙️ Gérer dans Ma Boutique Telegram', url: process.env.DASHBOARD_URL || 'https://dashboard.example.com' }]]
                    }
                });

                return safeEdit(ctx, `✅ <b>Proposition envoyée !</b>\n\n` +
                    `📛 ${esc(data.name)}\n` +
                    `💰 ${data.price}€\n\n` +
                    `⏳ <b>Votre produit a été soumis pour le catalogue client. L'administrateur doit le valider avant qu'il ne soit visible publiquement.</b>`,
                    Markup.inlineKeyboard([
                        [Markup.button.callback('◀️ Mon Magasin', 'mp_my_shop')]
                    ])
                );
            } else {
                // Marketplace standard : visible par défaut comme avant
                const product = await saveMarketplaceProduct({
                    supplier_id: data.supplierId,
                    name: data.name,
                    price: data.price,
                    stock: data.stock || 0,
                    description: data.description || '',
                    image_url: data.image_url || '',
                    category: data.category || '',
                    is_available: (data.stock || 0) > 0,
                    is_validated: true // Validé par défaut pour le gros
                });

                // Notifier l'admin par courtoisie
                const adminMsg = `🆕 <b>NOUVEAU PRODUIT (Gros)</b>\n\n` +
                    `🏪 Fournisseur : <b>${esc(data.supplierName || 'Inconnu')}</b>\n` +
                    `📦 Produit : <b>${esc(data.name)}</b>\n` +
                    `💰 Prix : <b>${data.price}€</b>`;
                
                await notifyAdmins(bot, adminMsg);

                return safeEdit(ctx, `✅ <b>Produit créé !</b>\n\n` +
                    `📛 ${esc(data.name)}\n` +
                    `💰 ${data.price}€\n\n` +
                    `📦 <i>Votre produit est maintenant visible dans la marketplace des administrateurs.</i>`,
                    Markup.inlineKeyboard([
                        [Markup.button.callback('➕ Ajouter un autre', 'mp_add_product'), Markup.button.callback('📦 Mes Produits', 'mp_my_products')],
                        [Markup.button.callback('◀️ Mon Magasin', 'mp_my_shop')]
                    ])
                );
            }
        } catch (e) {
            console.error('finalizeProduct error:', e);
            return safeEdit(ctx, '❌ Erreur lors de la création. Réessayez.', Markup.inlineKeyboard([
                [Markup.button.callback('◀️ Mon Magasin', 'mp_my_shop')]
            ]));
        }
    }

    return { handleMarketplaceText, handleMarketplacePhoto, handleMarketplaceVideo };
}

module.exports = { setupMarketplaceHandlers, initMarketplaceState, clearAllAwaitingMaps };
