const { Markup } = require('telegraf');
const {
    getProducts, getProduct, updateProduct, createOrder, getUser, setLivreurStatus,
    updateLivreurPosition, getAvailableOrders, updateOrderStatus,
    getOrder, getAppSettings, setLivreurAvailability,
    incrementOrderCount, getAllLivreurs, _userCache,
    getClientActiveOrders, logHelpRequest, saveClientReply, incrementChatCount,
    getAndClearPendingFeedback, saveFeedback, addMessageToTrack,
    saveReview, uploadMediaFromUrl,
    getSupplierByTelegramId, getSupplierProducts, getSupplierOrders, markOrderSupplierReady,
    getSupplier, markOrderSupplierNotified,
    getOrdersByUser
} = require('../services/database');
const { safeEdit, debugLog, trackIntermediateMessage, setActiveMediaGroup, clearActiveMediaGroup, getActiveMediaGroup, esc } = require('../services/utils');
const { createPersistentMap } = require('../services/persistent_map');
const { notifyAdmins, notifyLivreurs, notifySuppliers, sendTelegramMessage } = require('../services/notifications');
const { clearAllAwaitingMaps } = require('./supplier_marketplace');
const { t } = require('../services/i18n');

// ======= ÉTAT PERSISTANT (survit aux redémarrages via Supabase) =======
const userCarts = createPersistentMap('userCarts');
const pendingOrders = createPersistentMap('pendingOrders');
const awaitingAddressDetails = createPersistentMap('awaitingAddress');
const pendingOrderConfirmation = createPersistentMap('pendingConfirm');
const awaitingDelayReason = createPersistentMap('awaitingDelay');
const awaitingChatReply = createPersistentMap('awaitingChat');
const awaitingReviewText = createPersistentMap('awaitingReview');
// État éphémère (pas besoin de persister)
const userLastActivity = new Map();

/**
 * Helper to extract a single valid media URL from product data.
 * Handles JSON arrays, plain strings, and trims whitespace.
 */
function getMediaUrl(product) {
    const all = getAllMediaUrls(product);
    return all.length > 0 ? all[0].url : null;
}

/**
 * Retourne TOUTES les URLs média d'un produit sous forme [{url, type}].
 */
function getAllMediaUrls(product) {
    if (!product) return [];
    let raw = product.image_url;
    if (!raw) return [];

    if (typeof raw === 'string') {
        raw = raw.trim();
        if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.substring(1, raw.length - 1);
    }

    const videoExtRegex = /\.(mp4|mov|avi|wmv|webm|mkv)(\?.*)?$/i;

    // Handle JSON array format: [{"url":"...", "type":"photo"}, ...]
    if (typeof raw === 'string' && raw.startsWith('[') && raw.endsWith(']')) {
        try {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr) && arr.length > 0) {
                return arr.map(item => {
                    const url = typeof item === 'string' ? item : (item.url || item.image_url);
                    const type = typeof item === 'object' && item.type ? item.type : (url && url.match(videoExtRegex) ? 'video' : 'photo');
                    return { url, type };
                }).filter(m => m.url);
            }
        } catch (e) { }
    }

    // Handle single JSON object format
    if (typeof raw === 'string' && raw.startsWith('{') && raw.endsWith('}')) {
        try {
            const obj = JSON.parse(raw);
            const url = obj.url || obj.image_url;
            const type = obj.type || (url && url.match(videoExtRegex) ? 'video' : 'photo');
            return url ? [{ url, type }] : [];
        } catch (e) {}
    }

    // Plain URL string
    const type = raw.match(videoExtRegex) ? 'video' : 'photo';
    return raw ? [{ url: raw, type }] : [];
}

async function initOrderState() {
    await Promise.all([
        userCarts.load(), pendingOrders.load(), awaitingAddressDetails.load(),
        pendingOrderConfirmation.load(), awaitingDelayReason.load(),
        awaitingChatReply.load(), awaitingReviewText.load()
    ]);
    console.log('[State] Tous les états order_system chargés');
}

function setupOrderSystem(bot) {
    // Helper universel pour relayer un message à tous les admins
    // (Désormais géré par services/notifications.js)

    // Helper pour envoyer les notifications de feedback
    async function sendFeedbackNotifications(orderId, rate, text, ctx) {
        try {
            const [settings, order] = await Promise.all([getAppSettings(), getOrder(orderId)]);
            if (!settings || !order) return;

            const stars = '⭐'.repeat(parseInt(rate));
            const feedbackMsg = `💬 <b>NOUVEAU FEEDBACK !</b>\n\n` +
                `👤 Client : ${esc(ctx.from.first_name)}\n` +
                `🔑 Commande ID : <code>${esc(orderId)}</code>\n` +
                `🌟 Note : ${stars} (${rate}/5)\n` +
                `📝 Commentaire : <i>${esc(text)}</i>`;

            // Notifier les admins via service central
            await notifyAdmins(bot, feedbackMsg);

            // Notifier le livreur
            if (order.livreur_id) {
                await sendTelegramMessage(order.livreur_id,
                    `👏 <b>Félicitations !</b>\n\nUn client a laissé une note pour votre livraison :\n\n${stars}\n"<i>${text}</i>"`
                );
            }
        } catch (e) { console.error("Error notifying feedback:", e); }
    }

    // ========== CATALOGUE & COMMANDE ==========

    async function displayCatalog(ctx) {
        const [products, settings] = await Promise.all([
            getProducts(),
            ctx.state?.settings ? Promise.resolve(ctx.state.settings) : getAppSettings()
        ]);
        const user = ctx.state?.user || await getUser(`${ctx.platform}_${ctx.from.id}`);
        if (!products || products.length === 0) {
            return safeEdit(ctx, t(user, 'msg_catalog_empty', settings.msg_catalog_empty || '📭 Le catalogue est actuellement vide.'), Markup.inlineKeyboard([[Markup.button.callback(settings.btn_back_generic || '◀️ Retour', 'main_menu')]]));
        }
        const catalogIcon = settings.ui_icon_catalog || '📦';
        const botName = settings.bot_name || 'Bot';
        const catalogTitle = settings.label_catalog_title || `${catalogIcon} <b>Catalogue ${botName}</b>`;
        let text = `${catalogTitle}\n\n` + t(user, 'msg_catalog_choice', 'Choisissez un produit :');

        // Chunking function pour garantir le 2 par 2
        const chunk = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (v, i) => arr.slice(i * size, i * size + size));
        
        const productRows = chunk(products, 2);
        const buttons = productRows.map(row => row.map(p => {
            const badge = p.is_bundle ? '🎁 ' : (p.promo ? '🔥 ' : '');
            return Markup.button.callback(`${badge}${p.name} - ${p.price}€`, `product_${p.id}`);
        }));

        buttons.push([Markup.button.callback(t(user, 'btn_back_menu', settings.btn_back_menu || '◀️ Retour Menu'), 'main_menu')]);

        await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
    }

    bot.action('view_catalog', async (ctx) => {
        await ctx.answerCbQuery();
        // Nettoyer les états marketplace pour éviter l'interception des messages
        clearAllAwaitingMaps(ctx.from.id);
        // Quitter le contexte produit → libérer le media group pour le cleanup
        clearActiveMediaGroup(`${ctx.platform}_${ctx.from.id}`);
        await displayCatalog(ctx);
    });

    bot.action(/^product_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        // Nettoyer les états marketplace pour éviter l'interception des messages
        clearAllAwaitingMaps(ctx.from.id);
        const productId = ctx.match[1];
        const product = await getProduct(productId);
        const settings = ctx.state?.settings || await getAppSettings();

        if (!product) return safeEdit(ctx, settings.msg_product_not_found || '❌ Produit non trouvé.', [Markup.button.callback(settings.btn_back_menu || '◀️ Retour Menu', 'view_catalog')]);

        let promoText = "";
        if (product.is_bundle) {
            promoText = `\n🎁 <b>OFFRE BUNDLE : 1 ACHETÉ = 1 OFFERT !</b>\n<i>(Le produit offert est inclus automatiquement dans votre commande)</i>\n`;
        } else if (product.promo) {
            promoText = `\n🔥 <b>PROMO : ${product.promo}</b>\n`;
        }

        // NOUVEAU: Affichage des prix dégressifs
        if (product.has_discounts && product.discounts_config && product.discounts_config.length > 0) {
            promoText += `\n📉 <b>PRIX DÉGRESSIFS :</b>\n`;
            const unitSuffix = (product.unit && product.unit.toLowerCase() !== 'unité') ? ` ${product.unit}` : ' unités';
            product.discounts_config.forEach(d => {
                const discountTotal = d.total || d.total_price;
                promoText += `• ${d.qty}${unitSuffix} : <b>${discountTotal}€</b> (au lieu de ${(product.price * d.qty).toFixed(2)}€)\n`;
            });
        }

        const user = ctx.state?.user || await getUser(`${ctx.platform}_${ctx.from.id}`);
        let text = `🌟 <b>${esc(product.name)}</b> 🌟\n\n` +
            t(user, 'label_unit_price', '💰 Prix Unitaire :') + ` <b>${product.price}€</b>\n` +
            (promoText ? `${promoText}\n` : "") +
            (product.description ? `\n<i>${product.description}</i>\n` : "") +
            `\n💎 ` + t(user, 'label_choose_qty', '<b>Choisissez votre quantité :</b>');

        const qtyOptions = [1, 2, 3, 4, 5, 10];
        const qtyRows = [];
        const unit = product.unit || '';
        const unitDisplay = (unit && unit.toLowerCase() !== 'unité' && unit.toLowerCase() !== 'pieces') ? unit : '';

        for (let i = 0; i < qtyOptions.length; i += 2) {
            const label1 = `${qtyOptions[i]}${unitDisplay}`;
            const row = [Markup.button.callback(label1, `qty_${productId}_${qtyOptions[i]}`)];
            
            if (i + 1 < qtyOptions.length) {
                const label2 = `${qtyOptions[i+1]}${unitDisplay}`;
                row.push(Markup.button.callback(label2, `qty_${productId}_${qtyOptions[i+1]}`));
            }
            qtyRows.push(row);
        }
        qtyRows.push([Markup.button.callback(t(user, 'btn_cancel', '❌ Annuler'), 'view_catalog')]);
        const keyboard = Markup.inlineKeyboard(qtyRows);

        const userId = `${ctx.platform}_${ctx.from.id}`;
        // On désactive le media group complexe pour privilégier l'affichage photo+caption professionnel
        clearActiveMediaGroup(userId);
        
        const allMedia = getAllMediaUrls(product);
        const firstPhoto = allMedia.length > 0 ? allMedia[0].url : null;
        const isVideo = allMedia.length > 0 && allMedia[0].type === 'video';

        await safeEdit(ctx, text, {
            ...keyboard,
            photo: isVideo ? null : firstPhoto,
            video: isVideo ? firstPhoto : null
        });
    });

    bot.action(/^qty_(.+)_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const userId = `${ctx.platform}_${ctx.from.id}`;
        const productId = ctx.match[1];
        const qty = parseInt(ctx.match[2]);
        const product = await getProduct(productId);
        const settings = (ctx.state?.settings || await getAppSettings());

        if (!product) {
            console.error(`❌ Product not found: ${productId}. Available:`, products.map(p => p.id).join(', '));
            return safeEdit(ctx, settings.msg_product_not_found || '❌ Produit non trouvé.', Markup.inlineKeyboard([[Markup.button.callback(settings.btn_back_generic || '◀️ Retour', 'view_catalog')]]));
        }

        // Calcul du prix avec gestion des paliers dégressifs
        let totalPriceValue = product.price * qty;
        if (product.has_discounts && product.discounts_config && product.discounts_config.length > 0) {
            const sortedDiscounts = [...product.discounts_config].sort((a, b) => b.qty - a.qty);
            const bestDiscount = sortedDiscounts.find(d => qty >= d.qty);
            if (bestDiscount) {
                totalPriceValue = bestDiscount.total_price + (qty - bestDiscount.qty) * product.price;
            }
        }
        const totalPrice = totalPriceValue.toFixed(2);

        let bundleText = "";
        if (product.is_bundle) {
            const config = product.bundle_config || { trigger_qty: 1, offered_qty: 1, offered_id: null };
            const trigger = config.trigger_qty || 1;
            const offered = config.offered_qty || 1;
            const numGifts = Math.floor(qty / trigger) * offered;

            if (numGifts > 0) {
                if (config.offered_id) {
                    const offeredProd = products.find(p => p.id === String(config.offered_id));
                    bundleText = ` (+ ${numGifts} ${offeredProd ? offeredProd.name : 'cadeau'} offert(s) 🎁)`;
                } else {
                    bundleText = ` (+ ${numGifts} offert(s) 🎁)`;
                }
            }
        }

        pendingOrders.set(userId, {
            productId,
            qty,
            totalPrice,
            productName: product.name + bundleText,
            is_bundle: product.is_bundle,
            supplier_id: product.supplier_id // IMPORTANT pour la notification fournisseur
        });

        if (product.unit && product.unit.length > 0 && !(['unité', 'unite', 'piece', 'pce'].includes(product.unit.toLowerCase()))) {
            return askUnit(ctx, product, qty);
        }

        await showAddToCartChoice(ctx, product, qty, totalPrice);
    });

    async function showAddToCartChoice(ctx, product, qty, totalPrice, unitAmount = null) {
        const userId = `${ctx.platform}_${ctx.from.id}`;
        const settings = ctx.state?.settings || await getAppSettings();
        const pending = pendingOrders.get(userId);
        if (!pending) return safeEdit(ctx, settings.msg_session_expired || "❌ Session expirée.", Markup.inlineKeyboard([[Markup.button.callback(settings.btn_back_quick_menu || '◀️ Menu', 'main_menu')]]));
        if (unitAmount) pending.chosen_unit_amount = unitAmount;

        const user = ctx.state?.user || await getUser(userId);
        const text = t(user, 'msg_selection', '🛒 <b>Sélection : {qty}x {name}</b>', { qty, name: product.name }) + (unitAmount ? ` (${unitAmount})` : '') + '\n' +
            t(user, 'label_price_total', '💰 Prix :') + ` <b>${totalPrice}€</b>\n\n` +
            t(user, 'msg_what_to_do', 'Que voulez-vous faire ?');

        const buttons = [
            [
                Markup.button.callback(t(user, 'btn_add_to_cart', '🛒 Ajouter au panier'), 'add_to_cart'),
                Markup.button.callback(t(user, 'btn_checkout_now', '💳 Régler maintenant'), 'checkout_now')
            ],
            [
                Markup.button.callback(t(user, 'btn_review', '⭐️ Avis / Comment'), 'leave_review'),
                Markup.button.callback(t(user, 'btn_back', settings.btn_back_generic || '◀️ Retour'), `product_${product.id}`)
            ]
        ];

        // Si un media group est actif (multi-images), pas de photo dans safeEdit
        // sinon le media group reste visible au-dessus et safeEdit édite juste le texte+boutons
        const hasActiveGroup = getAllMediaUrls(product).length > 1;
        await safeEdit(ctx, text, {
            ...Markup.inlineKeyboard(buttons),
            photo: hasActiveGroup ? null : getMediaUrl(product)
        });
    }

    bot.action('add_to_cart', async (ctx) => {
        const userId = `${ctx.platform}_${ctx.from.id}`;
        const user = ctx.state?.user || await getUser(userId);
        await ctx.answerCbQuery(t(user, 'msg_added_to_cart_notif', 'Ajouté au panier ! 🛒'));
        clearActiveMediaGroup(userId); // Quitter le contexte produit
        const settings = ctx.state?.settings || await getAppSettings();
        const pending = pendingOrders.get(userId);
        if (!pending) return safeEdit(ctx, settings.msg_session_expired || "❌ Session expirée.", Markup.inlineKeyboard([[Markup.button.callback(settings.btn_back_quick_menu || '◀️ Menu', 'main_menu')]]));

        let cart = userCarts.get(userId) || [];
        cart.push(pending);
        userCarts.set(userId, cart);
        userLastActivity.set(userId, Date.now()); // Update activity
        pendingOrders.delete(userId);

        const products = await getProducts();
        const text = t(user, 'msg_product_added', '✅ Produit ajouté !') + '\n\n' + t(user, 'msg_cart_count', 'Votre panier contient <b>{count}</b> article(s).', { count: cart.length });
        const buttons = [
            [Markup.button.callback(t(user, 'btn_continue', '🛍️ Continuer'), 'view_catalog'), Markup.button.callback(t(user, 'btn_cart_view', '💳 Panier'), 'view_cart')],
            [Markup.button.callback(t(user, 'btn_clear', settings.btn_clear_cart || '❌ Vider le panier'), 'clear_cart')]
        ];
        await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
    });

    bot.action('checkout_now', async (ctx) => {
        await ctx.answerCbQuery();
        const userId = `${ctx.platform}_${ctx.from.id}`;
        clearActiveMediaGroup(userId); // Quitter le contexte produit
        const pending = pendingOrders.get(userId);
        if (!pending) return;

        let cart = userCarts.get(userId) || [];
        cart.push(pending);
        userCarts.set(userId, cart);
        userLastActivity.set(userId, Date.now()); // Update activity
        pendingOrders.delete(userId);

        await startCheckout(ctx);
    });

    async function displayCart(ctx) {
        const userId = `${ctx.platform}_${ctx.from.id}`;
        const user = ctx.state?.user || await getUser(userId);
        const cart = userCarts.get(userId) || [];
        const settings = (ctx.state?.settings || await getAppSettings());
        if (cart.length === 0) {
            return safeEdit(ctx, t(user, 'msg_cart_empty', 'Votre panier est vide 📭'), Markup.inlineKeyboard([[Markup.button.callback(t(user, 'btn_add_more', '🛍️ Retour au Catalogue'), 'view_catalog')]]));
        }

        let total = 0;
        let summary = t(user, 'btn_cart', '🛒 <b>Votre Panier</b>') + `\n\n`;
        const buttons = [];

        cart.forEach((item, idx) => {
            const price = parseFloat(item.totalPrice);
            total += price;
            summary += `${idx + 1}. ${item.productName} (x${item.qty})${item.chosen_unit_amount ? ` [${item.chosen_unit_amount}]` : ''} - <b>${price.toFixed(2)}€</b>\n`;
            // Bouton de suppression individuelle
            buttons.push([Markup.button.callback(`❌ ${t(user, 'btn_back', 'Retirer')} ${item.productName}`, `remove_item_${idx}`)]);
        });
        summary += `\n💰 <b>` + t(user, 'label_total_price', 'TOTAL :') + ` ${total.toFixed(2)}€</b>`;

        buttons.push([Markup.button.callback(t(user, 'btn_checkout', '💳 Commander'), 'start_checkout'), Markup.button.callback(t(user, 'btn_add_more', '🛍️ Continuer'), 'view_catalog')]);
        buttons.push([Markup.button.callback(t(user, 'btn_clear_cart', '❌ Vider'), 'clear_cart'), Markup.button.callback(t(user, 'btn_back_menu', '◀️ Menu'), 'main_menu')]);

        await safeEdit(ctx, summary, Markup.inlineKeyboard(buttons));
    }

    bot.action('view_cart', async (ctx) => {
        await ctx.answerCbQuery();
        await displayCart(ctx);
    });

    bot.action(/^remove_item_(.+)$/, async (ctx) => {
        const idx = parseInt(ctx.match[1]);
        const userId = `${ctx.platform}_${ctx.from.id}`;
        let cart = userCarts.get(userId) || [];
        if (cart[idx]) {
            await ctx.answerCbQuery(`Retiré : ${cart[idx].productName}`);
            cart.splice(idx, 1);
            userCarts.set(userId, cart);
        }
        await displayCart(ctx);
    });

    bot.action('clear_cart', async (ctx) => {
        await ctx.answerCbQuery('Panier vidé 🗑️');
        const settings = (ctx.state?.settings || await getAppSettings());
        const userId = `${ctx.platform}_${ctx.from.id}`;
        userCarts.delete(userId);
        try {
            await displayCatalog(ctx);
        } catch (e) {
            console.error('Error displaying catalog after clear:', e.message);
            await safeEdit(ctx, settings.msg_cart_cleared || '✅ Panier vidé !', Markup.inlineKeyboard([[Markup.button.callback('🛍️ Voir le Catalogue', 'view_catalog')], [Markup.button.callback(settings.btn_back_quick_menu || '◀️ Menu', 'main_menu')]]));
        }
    });

    bot.action('start_checkout', async (ctx) => {
        await ctx.answerCbQuery();
        await startCheckout(ctx);
    });

    async function startCheckout(ctx) {
        const userId = `${ctx.platform}_${ctx.from.id}`;
        const user = ctx.state?.user || await getUser(userId);
        const cart = userCarts.get(userId) || [];
        const settings = ctx.state?.settings || await getAppSettings();
        if (cart.length === 0) return safeEdit(ctx, t(user, 'msg_cart_empty', settings.msg_cart_empty || "📭 Votre panier est vide."), Markup.inlineKeyboard([[Markup.button.callback(settings.btn_back_quick_menu || '◀️ Menu', 'main_menu')]]));

        // settings already defined above
        const minOrder = settings.fidelity_min_spend || 50;
        let total = cart.reduce((acc, item) => acc + parseFloat(item.totalPrice), 0);

        if (total < minOrder) {
            return safeEdit(ctx,
                t(user, 'msg_min_order_error', `⚠️ <b>Minimum de commande non atteint</b>\n\nNous ne livrons pas en dessous de <b>{min}€</b>.\nVotre total actuel : <b>{total}€</b>\n\nVeuillez ajouter d'autres produits à votre panier.`, { min: minOrder, total: total.toFixed(2) }),
                Markup.inlineKeyboard([
                    [Markup.button.callback(t(user, 'btn_add_products', '🛍️ Ajouter des produits'), 'view_catalog')],
                    [Markup.button.callback(t(user, 'btn_back_to_cart_label', '🛒 Retour au Panier'), 'view_cart')]
                ])
            );
        }

        await promptAddressEntry(ctx, total);
    }

    async function promptAddressEntry(ctx, totalPrice) {
        const userId = `${ctx.platform}_${ctx.from.id}`;
        const user = ctx.state?.user || await getUser(userId);
        const settings = ctx.state?.settings || await getAppSettings();
        const cart = userCarts.get(userId) || [];
        const itemsText = cart.map(item => `• ${item.productName} (x${item.qty})${item.chosen_unit_amount ? ` [${item.chosen_unit_amount}]` : ''}`).join('\n');

        // On persiste l'état d'attente d'adresse dans le Map global
        awaitingAddressDetails.set(userId, { step: 1, total: totalPrice });

        const savedAddresses = user?.data?.addresses || [];

        const msg = t(user, 'msg_prompt_address', `📍 <b>ADRESSE DE LIVRAISON</b>\n\nVeuillez saisir votre adresse complète (N°, Rue, Ville) ou en choisir une enregistrée :`);

        const addressButtons = [];
        // Si l'utilisateur a des adresses enregistrées, on en propose max 3
        if (savedAddresses.length > 0) {
            const reversed = [...savedAddresses].reverse().slice(0, 3);
            reversed.forEach((addr, idx) => {
                // On tronque si trop long pour les boutons
                const label = addr.length > 30 ? addr.substring(0, 27) + '...' : addr;
                addressButtons.push([Markup.button.callback(`🏠 ${label}`, `use_addr_idx_${idx}`)]);
            });
        }

        const keyboard = [
            ...addressButtons,
            [Markup.button.callback(t(user, 'btn_back_cart_label', settings.btn_back_to_cart || '◀️ Retour Panier'), 'view_cart')],
            [Markup.button.callback(t(user, 'btn_cancel_order_label', settings.btn_cancel_order || '❌ Annuler la commande'), 'main_menu')]
        ];

        await safeEdit(ctx,
            t(user, 'msg_cart_items', '🛒 <b>Votre Panier :</b>') + `\n${itemsText}\n` +
            t(user, 'label_price_total', '💰 Montant :') + ` <b>${totalPrice.toFixed(2)}€</b>\n\n` +
            t(user, 'msg_step_address', '🏁 <b>Étape 1 : Adresse de livraison</b>') + `\n\n` +
            (savedAddresses.length > 0 ? t(user, 'msg_choose_address', `👇 Choisissez une adresse connue ou envoyez-en une nouvelle :\n\n`) : t(user, 'msg_send_precise_address', `Veuillez envoyer votre <b>adresse précise</b> avec le <b>code postal</b> (Numéro, Rue, CP, Ville).\n\n`)) +
            t(user, 'msg_postal_code_required', `⚠️ <i>Le code postal est obligatoire.</i>\n\n`) +
            t(user, 'msg_address_example', `💬 <i>Exemple : 45 rue de la Paix, 75002 Paris</i>`),
            Markup.inlineKeyboard(keyboard)
        );
    }

    bot.action(/^use_addr_idx_(\d+)$/, async (ctx) => {
        const idx = parseInt(ctx.match[1]);
        const userId = `${ctx.platform}_${ctx.from.id}`;
        
        const { getUser } = require('../services/database');
        const user = await getUser(userId);
        const savedAddresses = user?.data?.addresses || [];
        const reversed = [...savedAddresses].reverse().slice(0, 3);
        const addr = reversed[idx];

        if (!addr) return ctx.answerCbQuery('⚠️ Adresse introuvable.');

        await ctx.answerCbQuery('Adresse sélectionnée !');
        const addrState = awaitingAddressDetails.get(userId);
        
        if (!addrState) return ctx.reply("Session expirée.");

        const cpMatch = addr.match(/\b\d{5}\b/);
        const postalCode = cpMatch ? cpMatch[0] : '';
        let city = '';
        if (postalCode) {
            if (postalCode.startsWith('75')) {
                city = 'PARIS';
            } else {
                const afterCP = addr.substring(addr.indexOf(postalCode) + 5).trim();
                const beforeCP = addr.substring(0, addr.indexOf(postalCode)).trim();
                const extractWords = (str) => str.split(/[,;.\n]+/)[0].trim().split(/\s+/).filter(s => s.length > 1 && !/^\d+$/.test(s) && !['RUE','BOULEVARD','AVENUE','AVE','ALLEE','BAT','BATIMENT'].includes(s.toUpperCase()));
                const afterWords = extractWords(afterCP);
                const beforeWords = extractWords(beforeCP);
                const candidate = afterWords.length > 0 ? afterWords.slice(0, 3).join(' ') : (beforeWords.length > 0 ? beforeWords.slice(-3).join(' ') : '');
                city = candidate.replace(/[^a-zA-Z\u00C0-\u017E\s-]/g, '').trim().toUpperCase();
            }
        }

        addrState.address = addr;
        addrState.city = city;
        addrState.postal_code = postalCode;
        addrState.step = 1.5;
        awaitingAddressDetails.set(userId, addrState);

        const cart = userCarts.get(userId) || [];
        const total = cart.reduce((acc, item) => acc + parseFloat(item.totalPrice || 0), 0);
        pendingOrders.set(userId, { address: addr, city: city, postal_code: postalCode, totalPrice: total, isCart: true });

        return await askScheduling(ctx);
    });

    async function askUnit(ctx, product, qty) {
        const settings = (ctx.state?.settings || await getAppSettings());
        const unit = product.unit;
        // Support comma and remove non-numeric chars for baseVal calculation
        const cleanUnitVal = String(product.unit_value || '1').replace(',', '.');
        const baseVal = parseFloat(cleanUnitVal) || 1;
        const text = `⚖️ <b>Sélecton du format pour ${product.name}</b>\n\n` +
            `L'unité de base est de <b>${baseVal}${unit}</b> au prix de <b>${product.price}€</b>.\n\n` +
            `Choisissez le poids/volume souhaité :`;

        const options = [1, 2, 5, 10, 20].map(m => {
            const amount = baseVal * m;
            return Markup.button.callback(`${amount}${unit}`, `unitselect_${product.id}_${qty}_${amount}`);
        });

        const rows = [];
        for (let i = 0; i < options.length; i += 2) rows.push(options.slice(i, i + 2));
        rows.push([Markup.button.callback(settings.btn_back_to_qty || '◀️ Retour Quantité', `product_${product.id}`)]);
        rows.push([Markup.button.callback(settings.btn_cancel_alt || '❌ Annuler', 'view_catalog')]);

        await safeEdit(ctx, text, {
            ...Markup.inlineKeyboard(rows),
            photo: getMediaUrl(product)
        });
    }

    bot.action(/^unitselect_(.+)_(.+)_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const settings = ctx.state?.settings || await getAppSettings();
        const [pId, qtyStr, amountStr] = ctx.match.slice(1);
        const qty = parseInt(qtyStr);
        const amount = parseFloat(amountStr);
        const products = await getProducts();
        const product = products.find(p => p.id === pId);

        if (!product) return safeEdit(ctx, settings.msg_product_not_found || "❌ Produit non trouvé.", Markup.inlineKeyboard([[Markup.button.callback(settings.btn_back_generic || '◀️ Retour', 'view_catalog')]]));

        // Support comma and remove non-numeric chars for baseVal calculation
        const cleanUnitVal = String(product.unit_value || '1').replace(',', '.');
        const baseVal = parseFloat(cleanUnitVal) || 1;
        const effectiveQty = (amount / baseVal) * qty;

        let totalPriceValue = (product.price / baseVal) * amount * qty;
        if (product.has_discounts && product.discounts_config && product.discounts_config.length > 0) {
            const sortedDiscounts = [...product.discounts_config].sort((a, b) => b.qty - a.qty);
            const bestDiscount = sortedDiscounts.find(d => effectiveQty >= d.qty);
            if (bestDiscount) {
                totalPriceValue = bestDiscount.total_price + (effectiveQty - bestDiscount.qty) * product.price;
            }
        }
        let finalPrice = totalPriceValue.toFixed(2);

        let bundleText = "";
        if (product.is_bundle) {
            bundleText = ` (+ ${qty} offert(s) 🎁)`;
        }

        const userId = `${ctx.platform}_${ctx.from.id}`;
        const pending = pendingOrders.get(userId);
        if (pending) {
            pending.totalPrice = finalPrice;
            pending.chosen_unit_amount = `${amount}${product.unit}${bundleText}`;
            if (product.is_bundle) pending.is_bundle = true;
        }

        await showAddToCartChoice(ctx, product, qty, finalPrice, `${amount}${product.unit}${bundleText}`);
    });

    async function promptAddress(ctx, product, qty, totalPrice) {
        const settings = ctx.state?.settings || await getAppSettings();
        await safeEdit(ctx,
            `✅ <b>${qty}x ${product.name}</b> ajouté au panier.\n` +
            `💰 Total : <b>${totalPrice}€</b>\n\n` +
            `📍 Veuillez nous envoyer votre <b>adresse de livraison</b> précise :`,
            {
                ...Markup.inlineKeyboard([
                    ...(settings.dashboard_url ? [[Markup.button.webApp("📍 Choisir sur la carte", `${settings.dashboard_url.replace('/dashboard', '/address_picker')}`)]] : []),
                    [Markup.button.callback(settings.btn_back_to_qty || '◀️ Retour Quantité', product.unit ? `qty_${product.id}_${qty}` : `product_${product.id}`)],
                    [Markup.button.callback(settings.btn_cancel_alt || '❌ Annuler', 'view_catalog')]
                ]),
                photo: product.image_url || null
            }
        );
    }

    // Capture de l'adresse (message texte)
    bot.on('message', async (ctx, next) => {
        if (!ctx.message.text && !ctx.message.photo && !ctx.message.video) return next();
        const userId = `${ctx.platform}_${ctx.from.id}`;
        


        if (!ctx.message.text || ctx.message.text.startsWith('/')) return next();
        const addrState = awaitingAddressDetails.get(userId);

        // Step 1: Address Validation -> Suite vers SCHEDULING
        if (addrState && addrState.step === 1) {
            const addr = ctx.message.text.trim();
            // Sur WhatsApp, un nombre (1, 2, 10, etc.) = raccourci menu numérique → laisser passer
            if (/^\d+$/.test(addr)) return next();

            const hasNumber = addr.match(/\d/);
            const cpMatch = addr.match(/\b\d{5}\b/);

            if (addr.length < 4 || !hasNumber || !cpMatch) {
                let errorMsg = "❌ <b>Adresse incomplète.</b>\n\n";
                if (!cpMatch) errorMsg += "📍 Veuillez inclure un <b>code postal à 5 chiffres</b>.\n";
                errorMsg += "\nVeuillez renvoyer l'adresse complète (Numéro + Rue + CP + Ville).";

                await ctx.reply(errorMsg, { parse_mode: 'HTML' });
                return;
            }

            // On sauve l'adresse et on passe au Scheduling
            const postalCode = cpMatch[0];
            let city = 'INCONNUE';
            if (postalCode) {
                if (postalCode.startsWith('75')) {
                    city = 'PARIS';
                } else {
                    const afterCP = addr.substring(addr.indexOf(postalCode) + 5).trim();
                    const beforeCP = addr.substring(0, addr.indexOf(postalCode)).trim();
                    const extractWords = (str) => str.split(/[,;.\n]+/)[0].trim().split(/\s+/).filter(s => s.length > 1 && !/^\d+$/.test(s) && !['RUE','BOULEVARD','AVENUE','AVE','ALLEE','BAT','BATIMENT'].includes(s.toUpperCase()));
                    const afterWords = extractWords(afterCP);
                    const beforeWords = extractWords(beforeCP);
                    const candidate = afterWords.length > 0 ? afterWords.slice(0, 3).join(' ') : (beforeWords.length > 0 ? beforeWords.slice(-3).join(' ') : '');
                    city = candidate.replace(/[^a-zA-Z\u00C0-\u017E\s-]/g, '').trim().toUpperCase() || 'INCONNUE';
                }
            }

            addrState.address = addr;
            addrState.city = city;
            addrState.postal_code = postalCode;
            addrState.step = 1.5; // État transitoire
            awaitingAddressDetails.set(userId, addrState);

            // On prépare le pending order pour le scheduling
            const cart = userCarts.get(userId) || [];
            const total = cart.reduce((acc, item) => acc + parseFloat(item.totalPrice), 0);
            pendingOrders.set(userId, { address: addr, city: city, postal_code: postalCode, totalPrice: total, isCart: true });

            await ctx.deleteMessage().catch(() => { });
            return await askScheduling(ctx);
        }

        // Step 2: Details Capture -> FINALISATION
        if (addrState && addrState.step === 2 && !addrState.finalized) {
            const details = ctx.message.text.trim();
            addrState.address += ` (Infos : ${details})`;
            addrState.finalized = true;
            await ctx.deleteMessage().catch(() => { });
            return await finalizeCheckoutFlow(ctx, addrState.address);
        }

        return next();
    });

    bot.action('address_details_skip', async (ctx) => {
        await ctx.answerCbQuery();
        const userId = `${ctx.platform}_${ctx.from.id}`;
        const data = awaitingAddressDetails.get(userId);
        if (!data) return;
        data.finalized = true;
        await finalizeCheckoutFlow(ctx, data.address);
    });

    async function finalizeCheckoutFlow(ctx, fullAddress) {
        const userId = `${ctx.platform}_${ctx.from.id}`;
        const cart = userCarts.get(userId) || [];
        const bagTotal = cart.reduce((acc, item) => acc + parseFloat(item.totalPrice), 0);
        let total = bagTotal;

        const pending = pendingOrders.get(userId);
        const scheduled_at = pending ? pending.scheduled_at : null;
        let priority_fee = 0;
        let is_priority = false;
        
        if (pending && pending.is_priority) {
            is_priority = true;
            priority_fee = parseFloat(pending.priority_fee) || 0;
            total += priority_fee;
        }

        const checkoutData = {
            isCart: true,
            address: fullAddress,
            totalPrice: total,
            bagTotal: bagTotal,
            scheduled_at: scheduled_at,
            is_priority: is_priority,
            priority_fee: priority_fee,
            userId: userId
        };
        pendingOrders.set(userId, checkoutData);

        const settings = (ctx.state?.settings || await getAppSettings());
        const user = await getUser(userId);

        // SI CRÉDIT DISPONIBLE → ON DEMANDE (Step Finale)
        if (user && user.wallet_balance > 0) {
            const maxPct = settings.fidelity_wallet_max_pct || 50;
            const minSpend = settings.fidelity_min_spend || 50;

            // On calcule combien on peut déduire sans descendre sous le minSpend
            const maxAllowedByPct = (total * maxPct) / 100;
            const maxToKeepMinSpend = Math.max(0, total - minSpend);

            const possibleDiscount = Math.min(maxAllowedByPct, user.wallet_balance, maxToKeepMinSpend);

            if (possibleDiscount > 0) {
                pendingOrderConfirmation.set(userId, { ...checkoutData, possibleDiscount });
                return safeEdit(ctx,
                    `💰 <b>Utiliser votre solde ?</b>\n\n` +
                    `Votre solde actuel : <b>${(user.wallet_balance).toFixed(2)}€</b>\n` +
                    `Réduction possible : <b>${possibleDiscount.toFixed(2)}€</b>.\n\n` +
                    `Voulez-vous l'appliquer ?`,
                    Markup.inlineKeyboard([
                        [Markup.button.callback(`✅ Déduire ${possibleDiscount.toFixed(2)}€`, 'confirm_order_use_credit_yes'), Markup.button.callback('❌ Plein tarif', 'confirm_order_use_credit_no')],
                        [Markup.button.callback(settings.btn_back_to_address || '◀️ Retour Adresse', 'start_checkout')]
                    ])
                );
            }
        }

        await showCartSummary(ctx, fullAddress, total, 0, scheduled_at);
    }

    async function askScheduling(ctx) {
        const user = ctx.state?.user || await getUser(`${ctx.platform}_${ctx.from.id}`);
        const settings = ctx.state?.settings || await getAppSettings();
        const text = t(user, 'msg_when_delivery', `🕒 <b>Quand souhaitez-vous être livré ?</b>\n\nChoisissez si vous voulez être livré dès que possible ou planifier un horaire précis.`);
        const buttons = [];
        
        if (settings.priority_delivery_enabled) {
            const price = parseFloat(settings.priority_delivery_price) || 15;
            buttons.push([Markup.button.callback(t(user, 'btn_priority_delivery', `🚀 Livraison Prioritaire (+${price}€)`, { price }), 'scheduling_priority')]);
        }
        
        buttons.push([
            Markup.button.callback(t(user, 'btn_asap', '🏃 Dès que possible'), 'scheduling_now'), 
            Markup.button.callback(t(user, 'btn_schedule', '🕒 Planifier'), 'scheduling_plan')
        ]);
        buttons.push([
            Markup.button.callback(t(user, 'btn_back', settings.btn_back_to_address || '◀️ Retour'), 'back_to_address'), 
            Markup.button.callback(t(user, 'btn_cancel', settings.btn_cancel_alt || '❌ Annuler'), 'view_catalog')
        ]);
        
        await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
    }

    bot.action('scheduling_now', async (ctx) => {
        await ctx.answerCbQuery();
        const userId = `${ctx.platform}_${ctx.from.id}`;
        const pending = pendingOrders.get(userId);
        if (!pending) return ctx.reply("Session expirée.");
        pending.scheduled_at = null;
        pending.is_priority = false;
        pending.priority_fee = 0;

        const addrState = awaitingAddressDetails.get(userId);
        if (addrState) addrState.finalized = true;
        await finalizeCheckoutFlow(ctx, addrState?.address || pending.address);
    });

    bot.action('scheduling_priority', async (ctx) => {
        await ctx.answerCbQuery();
        const settings = ctx.state?.settings || await getAppSettings();
        const userId = `${ctx.platform}_${ctx.from.id}`;
        const pending = pendingOrders.get(userId);
        if (!pending) return ctx.reply("Session expirée.");
        pending.scheduled_at = null;
        pending.is_priority = true;
        pending.priority_fee = parseFloat(settings.priority_delivery_price) || 15;

        const addrState = awaitingAddressDetails.get(userId);
        if (addrState) addrState.finalized = true;
        await finalizeCheckoutFlow(ctx, addrState?.address || pending.address);
    });

    async function promptAddressDetails(ctx) {
        const settings = ctx.state?.settings || await getAppSettings();
        const userId = `${ctx.platform}_${ctx.from.id}`;
        const user = ctx.state?.user || await getUser(userId);
        const addrState = awaitingAddressDetails.get(userId);
        if (addrState) addrState.step = 2;

        const text = t(user, 'msg_delivery_details', `🏢 <b>Détails de livraison (Optionnel)</b>\n\nIndiquez votre <b>digicode, code bâtiment, étage, numéro d'appartement</b> ou toute info utile pour le livreur.\n\nSinon, cliquez sur le bouton ci-dessous :`);
        const buttons = [
            [Markup.button.callback(t(user, 'btn_skip_step', '⏭ Passer cette étape'), 'address_details_skip')]
        ];
        const keyboard = Markup.inlineKeyboard([
            ...buttons,
            [Markup.button.callback(t(user, 'btn_modify_address', '◀️ Modifier l\'adresse'), 'checkout_retry')],
            [Markup.button.callback(t(user, 'btn_cancel_order_label', settings.btn_cancel_order || '❌ Annuler la commande'), 'main_menu')]
        ]);
        return await safeEdit(ctx, text, keyboard);
    }

    bot.action('scheduling_plan', async (ctx) => {
        await ctx.answerCbQuery();
        const settings = ctx.state?.settings || await getAppSettings();
        const text = `📅 <b>Choisissez le moment de livraison :</b>`;
        const buttons = [];

        // On propose des créneaux
        const now = new Date();
        // On propose des créneaux sur 7 jours
        const dates = [];
        for (let i = 0; i < 7; i++) {
            const d = new Date();
            d.setDate(now.getDate() + i);
            dates.push(d);
        }

        dates.forEach((d, idx) => {
            const dateStr = d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
            const dateKey = d.toISOString().split('T')[0];
            let label = "";
            if (idx === 0) label = `Aujourd'hui (${dateStr})`;
            else if (idx === 1) label = `Demain (${dateStr})`;
            else label = `${dateStr}`;

            buttons.push([Markup.button.callback(label, `sched_date_${dateKey}`)]);
        });

        buttons.push([Markup.button.callback(settings.btn_back_to_options || '◀️ Retour aux options', 'back_to_scheduling')]);
        buttons.push([Markup.button.callback(settings.btn_cancel_alt || '❌ Annuler', 'main_menu')]);
        await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
    });

    bot.action(/^sched_date_(.+)$/, async (ctx) => {
        const date = ctx.match[1];
        const settings = ctx.state?.settings || await getAppSettings();
        await ctx.answerCbQuery();
        const text = `🕒 <b>À quelle heure ?</b>\n\nSélectionnez un créneau horaire :`;

        // Génération automatique des créneaux (de 00h à 23h, heures pleines uniquement)
        const slots = [];
        for (let h = 0; h < 24; h++) {
            slots.push(`${h.toString().padStart(2, '0')}h00`);
        }

        const buttons = [];
        for (let i = 0; i < slots.length; i += 4) {
            const row = slots.slice(i, i + 4).map(s => Markup.button.callback(s, `sched_final_${date}_${s}`));
            buttons.push(row);
        }
        buttons.push([Markup.button.callback(settings.btn_back_generic || '◀️ Retour', 'scheduling_plan')]);
        await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
    });

    bot.action(/^sched_final_(.+)_(.+)$/, async (ctx) => {
        const [date, hour] = [ctx.match[1], ctx.match[2]];
        const settings = ctx.state?.settings || await getAppSettings();
        await ctx.answerCbQuery();
        const userId = `${ctx.platform}_${ctx.from.id}`;
        const pending = pendingOrders.get(userId);
        if (!pending) return ctx.reply(settings.msg_session_expired || "Session expirée.");

        pending.scheduled_at = `${date} ${hour}`;

        const addrState = awaitingAddressDetails.get(userId);
        if (addrState) addrState.finalized = true;
        await finalizeCheckoutFlow(ctx, addrState?.address || pending.address);
    });

    bot.action('back_to_address', async (ctx) => {
        await ctx.answerCbQuery();
        await startCheckout(ctx);
    });

    bot.action('back_to_scheduling', async (ctx) => {
        await ctx.answerCbQuery();
        await askScheduling(ctx);
    });



    bot.action('confirm_order_use_credit_yes', async (ctx) => {
        await ctx.answerCbQuery();
        const settings = ctx.state?.settings || await getAppSettings();
        const userId = `${ctx.platform}_${ctx.from.id}`;
        const pending = pendingOrderConfirmation.get(userId);
        if (!pending) return safeEdit(ctx, settings.msg_session_expired || "Sesssion expirée ❌", Markup.inlineKeyboard([[Markup.button.callback(settings.btn_back_quick_menu || '◀️ Menu', 'main_menu')]]));

        const finalPrice = parseFloat(pending.totalPrice) - pending.possibleDiscount;
        await showCartSummary(ctx, pending.address, finalPrice, pending.possibleDiscount, pending.scheduled_at);
    });

    bot.action('confirm_order_use_credit_no', async (ctx) => {
        await ctx.answerCbQuery();
        const settings = ctx.state?.settings || await getAppSettings();
        const userId = `${ctx.platform}_${ctx.from.id}`;
        const pending = pendingOrderConfirmation.get(userId);
        if (!pending) return safeEdit(ctx, settings.msg_session_expired || "Sesssion expirée ❌", Markup.inlineKeyboard([[Markup.button.callback(settings.btn_back_quick_menu || '◀️ Menu', 'main_menu')]]));

        await showCartSummary(ctx, pending.address, parseFloat(pending.totalPrice), 0, pending.scheduled_at);
    });

    async function showMyOrders(ctx) {
        if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => { });
        const userId = `${ctx.platform}_${ctx.from.id}`;
        const user = ctx.state?.user || await getUser(userId);
        const settings = ctx.state?.settings || await getAppSettings();
        const { getOrdersByUser } = require('../services/database');

        try {
            const orders = await getOrdersByUser(userId);
            
            let text = t(user, 'msg_my_orders', `📦 <b>Mes Commandes</b>`) + `\n\n`;
            
            if (user) {
                text += t(user, 'label_profile', `👤 Profil :`) + ` <b>${user.first_name || 'Guest'}</b>\n`;
                text += t(user, 'label_wallet', `💰 Solde :`) + ` <b>${(user.wallet_balance || 0).toFixed(2)}€</b>\n`;
                text += t(user, 'label_loyalty', `🏆 Points :`) + ` <b>${user.loyalty_points || 0} pts</b>\n\n`;
            }

            const activeOrders = orders.filter(o => o.status === 'pending' || o.status === 'taken');
            const pastOrders = orders.filter(o => o.status === 'delivered' || o.status === 'cancelled').slice(0, 5);
            
            const buttons = [];

            if (activeOrders.length > 0) {
                text += t(user, 'msg_active_orders', `<b>🏃 Commandes en cours :</b>`) + `\n`;
                activeOrders.forEach((o) => {
                    const statusIcon = o.status === 'taken' ? '🚚' : '⏳';
                    const statusLabel = o.status === 'taken' ? t(user, 'label_taken', 'En livraison') : t(user, 'label_pending', 'En attente');
                    text += `${statusIcon} #${o.id.slice(-5)} - ${o.product_name} (${statusLabel})\n`;
                    buttons.push([Markup.button.callback(t(user, 'btn_manage_order', `🔍 Gérer #${o.id.slice(-5)}`, { id: o.id.slice(-5) }), `view_order_${o.id}`)]);
                });
                text += `\n`;
            }

            if (pastOrders.length > 0) {
                text += t(user, 'msg_past_orders', `📋 <b>Anciennes Commandes :</b>`) + `\n`;
                pastOrders.forEach((o) => {
                    const date = o.created_at ? new Date(o.created_at).toLocaleDateString(user?.language_code === 'en' ? 'en-US' : 'fr-FR') : 'Inconnue';
                    const statusLabel = o.status === 'delivered' ? t(user, 'label_delivered', '✅ Livrée') : t(user, 'label_cancelled', '❌ Annulée');
                    text += `• #${o.id.slice(-5)} - ${statusLabel} le ${date}\n`;
                });
            }

            buttons.push([Markup.button.callback(t(user, 'btn_back_menu', settings.btn_back_quick_menu || '◀️ Menu'), 'main_menu')]);
            await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
        } catch (e) {
            console.error('Error fetching user orders:', e);
            await safeEdit(ctx, '❌ Error.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu', 'main_menu')]]));
        }
    }

    bot.action('my_orders', async (ctx) => {
        await showMyOrders(ctx);
    });


    async function showCartSummary(ctx, address, finalPrice, discount, scheduledAt = null) {
        const userId = `${ctx.platform}_${ctx.from.id}`;
        const user = ctx.state?.user || await getUser(userId);
        const cart = userCarts.get(userId) || [];
        const pending = pendingOrderConfirmation.get(userId) || pendingOrders.get(userId);

        let cartText = ``;
        cart.forEach((item, idx) => {
            cartText += `📦 <b>${item.productName}</b> (x${item.qty})${item.chosen_unit_amount ? ` [${item.chosen_unit_amount}]` : ''}\n`;
        });

        const priorityFee = pending?.is_priority ? parseFloat(pending.priority_fee) : 0;
        const totalProducts = (finalPrice + discount) - priorityFee;

        const text = t(user, 'msg_order_cart_summary', `🛒 <b>Récapitulatif de Commande</b>`) + `\n\n` +
            cartText +
            t(user, 'label_address', `📍 Adresse :`) + ` ${address}\n` +
            (scheduledAt ? t(user, 'label_scheduled_for', `🕒 Prévue pour :`) + ` <b>${scheduledAt}</b>\n` : t(user, 'label_delivery_asap', `🚀 Livraison : ASAP`) + `\n`) +
            (priorityFee > 0 ? t(user, 'label_priority_option', `🚀 <b>Option Prioritaire : +{fee}€</b>`, { fee: priorityFee.toFixed(2) }) + `\n` : '') +
            t(user, 'label_subtotal', `💰 Sous-total :`) + ` <b>${totalProducts.toFixed(2)}€</b>\n` +
            (discount > 0 ? t(user, 'label_credit_discount', `🎁 Remise Crédit :`) + ` -${discount.toFixed(2)}€\n` : '') +
            t(user, 'label_total_to_pay', `💵 <b>TOTAL À RÉGLER : {total}€</b>`, { total: finalPrice.toFixed(2) }) + `\n\n` +
            t(user, 'msg_confirm_order', `Confirmez-vous la commande ?`);

        const settings = (ctx.state?.settings || await getAppSettings());
        const netToPay = finalPrice.toFixed(2);
        
        const keyboard = [];
        
        let pModes = [];
        try {
            pModes = typeof settings.payment_modes_config === 'string' ? JSON.parse(settings.payment_modes_config) : (settings.payment_modes_config || []);
        } catch(e) { }

        if (!pModes || pModes.length === 0) {
            pModes = [
                { id: 'CASH', label: 'Espèces', icon: '💵' }
            ];
        }

        // Si 1 seul mode, bouton "Confirmer" direct
        if (pModes.length === 1) {
            const pm = pModes[0];
            keyboard.push([Markup.button.callback(t(user, 'btn_confirm_order_pm', `✅ Confirmer la commande ({label})`, { label: pm.label }), `create_order_${pm.id}_${discount > 0 ? 'discount' : 'normal'}`)]);
        } else {
            // Grouper les modes de paiement 2 par 2
            for (let i = 0; i < pModes.length; i += 2) {
                const row = [Markup.button.callback(`${pModes[i].icon} ${pModes[i].label}`, `create_order_${pModes[i].id}_${discount > 0 ? 'discount' : 'normal'}`)];
                if (i + 1 < pModes.length) {
                    row.push(Markup.button.callback(`${pModes[i+1].icon} ${pModes[i+1].label}`, `create_order_${pModes[i+1].id}_${discount > 0 ? 'discount' : 'normal'}`));
                }
                keyboard.push(row);
            }
        }

        keyboard.push([Markup.button.callback('◀️ Modifier', 'back_to_scheduling'), Markup.button.callback(settings.btn_cancel_alt || '❌ Annuler', 'view_catalog')]);

        await safeEdit(ctx, text, {
            ...Markup.inlineKeyboard(keyboard)
        });
    }

    bot.action(/^create_order_(.+)$/, async (ctx) => {
        const userId = `${ctx.platform}_${ctx.from.id}`;
        console.log(`[Checkout] Commande lancée par ${userId}`);
        
        // --- 1. RÉACTION UI IMMÉDIATE ---
        // Enlève le spinner sur le bouton Telegram
        ctx.answerCbQuery().catch(() => {});

        const fullTag = ctx.match[1];
        const parts = fullTag.split('_');
        const useDiscount = parts[parts.length - 1] === 'discount';
        const paymentMethod = parts.slice(0, -1).join('_');
        
        const pending = useDiscount ? pendingOrderConfirmation.get(userId) : pendingOrders.get(userId);
        if (!pending) {
            console.error(`[Checkout] Session expirée pour ${userId}`);
            const settings = ctx.state?.settings || await getAppSettings();
            return safeEdit(ctx, settings.msg_session_expired || '❌ Session expirée.', Markup.inlineKeyboard([[Markup.button.callback(settings.btn_back_quick_menu || '◀️ Menu', 'main_menu')]]));
        }

        const cart = userCarts.get(userId) || [];
        const productList = cart.map(item => `${item.productName} (x${item.qty})${item.chosen_unit_amount ? ` [${item.chosen_unit_amount}]` : ''}`).join(', ');
        const totalQty = cart.reduce((acc, item) => acc + item.qty, 0);
        const discount = useDiscount ? (pending.possibleDiscount || 0) : 0;
        const finalPrice = Math.max(0, parseFloat(pending.totalPrice || 0) - discount);

        const isPriority = pending.is_priority;
        const priorityFee = isPriority ? (parseFloat(pending.priority_fee) || 0) : 0;
        let finalProductList = productList;
        if (isPriority) finalProductList += `\n🚀 Option Livraison Prioritaire (+${priorityFee.toFixed(2)}€)`;

        // --- 2. DÉTERMINATION FOURNISSEUR (Avant création) ---
        const allProducts = await getProducts().catch(() => []);
        let orderSupplierId = null;
        if (cart.length > 0) {
            for (const item of cart) {
                const p = allProducts.find(prod => String(prod.id) === String(item.productId));
                if (p && p.supplier_id) { orderSupplierId = p.supplier_id; break; }
            }
        }

        const orderData = {
            user_id: userId,
            username: ctx.from.username || 'Inconnu',
            first_name: ctx.from.first_name || 'Inconnu',
            product_name: finalProductList,
            quantity: totalQty,
            total_price: finalPrice,
            payment_method: paymentMethod.toLowerCase(),
            address: pending.address,
            city: pending.city || '',
            postal_code: pending.postal_code || '',
            platform: ctx.platform,
            status: orderSupplierId ? 'supplier_pending' : 'pending',
            discount_applied: discount,
            scheduled_at: pending.scheduled_at || null,
        };

        // --- 3. TRAVAIL PARALLÈLE (Vitesse Maximale) ---
        console.log(`[Checkout] Exécution des tâches DB en parallèle...`);
        const startTime = Date.now();

        try {
            // DECREMENT STOCK
            const { saveProduct } = require('../services/database');
            const stockTasks = cart.map(async item => {
                const p = allProducts.find(prod => String(prod.id) === String(item.productId));
                if (p && typeof p.stock === 'number' && p.stock > 0) {
                    const newStock = Math.max(0, p.stock - item.qty);
                    // Si le stock tombe à 0, on peut désactiver si une option globale est cochée (ou par défaut ici pour satisfaire la demande)
                    const updates = { id: p.id, stock: newStock };
                    if (newStock <= 0) {
                        updates.is_active = false;
                        console.log(`[STOCK] Produit ${p.name} épuisé, désactivation automatique.`);
                    }
                    return updateProduct(p.id, updates).catch(e => console.error(`[STOCK-ERR] ${p.id}:`, e.message));
                }
                return Promise.resolve();
            });

            const [createResult, dbSettings] = await Promise.all([
                createOrder(orderData),
                getAppSettings(),
                ...stockTasks
            ]);

            if (createResult.error) throw createResult.error;
            const order = createResult.order;
            
            // On vérifie si c'est la première commande en utilisant l'ID officiel (possiblement fusionné)
            const officialUserId = ctx.state.user?.id || userId;
            const previousOrders = await getOrdersByUser(officialUserId);
            // S'il n'y a qu'1 commande (celle qu'on vient de créer), c'est que c'est bien la première.
            const isFirstOrder = (!previousOrders || previousOrders.length <= 1);

            console.log(`[Checkout] Tâches DB terminées en ${Date.now() - startTime}ms. Confirmation client...`);

            // --- 4. RÉPONSE CLIENT (Priorité #1) ---
            const user = ctx.state?.user || await getUser(userId);
            const confirmedMsgBody = t(user, 'msg_order_registered', dbSettings.msg_order_confirmed_client || `✅ <b>Commande enregistrée !</b>\n\n📦 Produit : {product_list}\n📍 Adresse : {address}\n{delivery_time}\n💰 Total : <b>{total}€</b>\n\n{success_icon} Recherche d'un livreur en cours...`);
            const finalConfirmedMsg = confirmedMsgBody
                .replace('{product_list}', finalProductList)
                .replace('{address}', pending.address)
                .replace('{delivery_time}', (pending.scheduled_at ? t(user, 'label_scheduled_for', `🕒 Prévu pour :`) + ` <b>${pending.scheduled_at}</b>` : t(user, 'label_delivery_asap', `🚀 Livraison : Dès que possible`)))
                .replace('{total}', finalPrice.toFixed(2))
                .replace('{success_icon}', dbSettings.ui_icon_success || '✅');

            await safeEdit(ctx, finalConfirmedMsg, Markup.inlineKeyboard([
                [Markup.button.callback(t(user, 'label_ongoing_orders_btn', '📦 Mes commandes en cours'), 'my_orders')],
                [Markup.button.callback(t(user, 'btn_back_menu', dbSettings.btn_back_menu || '◀️ Retour Menu'), 'main_menu')]
            ]));

            // Nettoyage rapide
            userCarts.delete(userId);
            pendingOrders.delete(userId);
            pendingOrderConfirmation.delete(userId);
            awaitingAddressDetails.delete(userId);

            // --- 5. TRAITEMENT ARRIÈRE-PLAN (Notifications) ---
            (async () => {
                // Notif Nouveau Client
                if (isFirstOrder) {
                    const adminContact = dbSettings.private_contact_url || 'https://t.me/leplugidf75';
                    ctx.reply(t(user, 'msg_first_order_welcome', `👋 <b>Première commande !</b>\nContactez l'admin pour valider : {contact}`, { contact: adminContact }), { parse_mode: 'HTML' }).catch(() => {});
                }

                // Alerte Admin & Livreurs
                let pModes = [];
                try { pModes = typeof dbSettings.payment_modes_config === 'string' ? JSON.parse(dbSettings.payment_modes_config) : (dbSettings.payment_modes_config || []); } catch(e) {}
                if (!pModes.length) pModes = [{ id: 'CASH', label: 'Espèces', icon: '💵' }];

                const payIcon = pModes.find(m => m.id === paymentMethod.toLowerCase())?.icon || '💰';
                const payLabel = pModes.find(m => m.id === paymentMethod.toLowerCase())?.label || paymentMethod;

                const platformIcon = ctx.platform === 'whatsapp' ? '📱 [WHATSAPP]' : '✈️ [TELEGRAM]';

                const baseNotifLivreur = (dbSettings.msg_order_notif_livreur || `🆕 <b>NOUVELLE COMMANDE !</b>\n\n🌐 Plateforme : {platform}\n📦 {product_list}\n📍 {address}\n{scheduled}\n💰 <b>{total}€ ({pay_icon} {pay_label})</b>`)
                    .replace('{platform}', platformIcon)
                    .replace('{product_list}', esc(finalProductList))
                    .replace('{address}', esc(pending.address))
                    .replace('{scheduled}', (pending.scheduled_at ? `🕒 <b>Prévu pour : ${esc(pending.scheduled_at)}</b>` : `🕒 Dès que possible`))
                    .replace('{total}', finalPrice.toFixed(2))
                    .replace('{pay_icon}', payIcon)
                    .replace('{pay_label}', payLabel);

                const badge = isFirstOrder ? `\n🔥 <b>[ NOUVEAU CLIENT ]</b> 🔥\n` : '';
                const baseNotifAdmin = (dbSettings.msg_order_received_admin || `🚨 <b>NOUVELLE COMMANDE !</b>\n{badge}\n🌐 Plateforme : {platform}\n👤 {client_name} (@{username})\n📦 {product_list}\n📍 {address}\n💰 {total}€ ({pay_icon} {pay_label})\n🔑 ID : <code>{order_id}</code>`)
                    .replace('{badge}', badge)
                    .replace('{platform}', platformIcon)
                    .replace('{client_name}', esc(ctx.from.first_name))
                    .replace('{username}', (ctx.from.username ? esc(ctx.from.username) : 'Inconnu'))
                    .replace('{product_list}', esc(finalProductList))
                    .replace('{address}', esc(pending.address))
                    .replace('{total}', finalPrice.toFixed(2))
                    .replace('{pay_icon}', payIcon)
                    .replace('{pay_label}', payLabel)
                    .replace('{order_id}', order.id);

                const adminBtns = Markup.inlineKeyboard([
                    [Markup.button.callback('🤝 ASSIGNER', `ao_l_${order.id}`)],
                    [Markup.button.callback('⚙️ GÉRER', `ao_v_${order.id}`)]
                ]).reply_markup;

                // Envois réels
                notifyAdmins(bot, baseNotifAdmin, { reply_markup: adminBtns }).catch(e => console.error("Admin Notif Error:", e.message));
                
                // SI FOURNISSEUR -> ON ATTEND SON FEU VERT (Pas de notif livreur immédiate)
                if (orderSupplierId) {
                    notifySuppliers(bot, cart, order.id, pending.address, dbSettings, isFirstOrder).catch(e => console.error("Supplier Notif Error:", e.message));
                } else {
                    notifyLivreurs(bot, baseNotifLivreur, { reply_markup: Markup.inlineKeyboard([[Markup.button.callback('📦 Voir Commandes', 'show_available_orders')]]).reply_markup }).catch(e => console.error("Livreur Notif Error:", e.message));
                }

            })().catch(e => console.error("Background processing crash:", e.message));

        } catch (err) {
            console.error(`[Checkout] Erreur fatale pour ${userId}:`, err.message);
            const settings = ctx.state?.settings || await getAppSettings();
            return safeEdit(ctx, `❌ Erreur.\n<i>${err.message}</i>`, Markup.inlineKeyboard([[Markup.button.callback(settings.btn_back_quick_menu || '◀️ Menu', 'main_menu')]]));
        }
    });

    // ========== SYSTEME LIVREUR ==========

    bot.command('livreur_start', async (ctx) => {
        const userId = `${ctx.platform}_${ctx.from.id}`;
        const user = ctx.state?.user || await getUser(userId);
        const settings = ctx.state?.settings || await getAppSettings();
        await setLivreurStatus(ctx.from.id, 'telegram', true);
        await safeEdit(ctx,
            t(user, 'msg_delivery_welcome', '🚴 <b>Bienvenue dans l\'équipe de livraison !</b>\n\nVous êtes maintenant enregistré comme livreur.\n\n<b>Utilisez le menu ci-dessous pour gérer vos livraisons :</b>'),
            Markup.inlineKeyboard([[Markup.button.callback(t(user, 'btn_livreur_menu_back', settings.btn_back_to_livreur_menu || '◀️ Menu Livreur'), 'livreur_menu')]])
        );
    });

    // Helper menu livreur additionnel si besoin
    bot.action('tracking_info', async (ctx) => {
        await ctx.answerCbQuery();
        const userId = `${ctx.platform}_${ctx.from.id}`;
        const user = ctx.state?.user || await getUser(userId);
        const settings = ctx.state?.settings || await getAppSettings();
        await safeEdit(ctx,
            `${settings.ui_icon_livreur} ` + t(user, 'msg_live_tracking', `<b>Suivi en direct</b>\n\nPour que le client puisse suivre votre arrivée :\n\n1. Cliquez sur le trombone (📎) ou (+) dans cette conversation\n2. Sélectionnez <b>Lieu</b> ou <b>Position</b>\n3. Choisissez <b>Partager ma position en direct</b> (Live Location)\n4. Sélectionnez la durée (ex: 1 heure)\n\nLe bot détectera automatiquement vos déplacements pour informer le client.`),
            Markup.inlineKeyboard([[Markup.button.callback(t(user, 'btn_back', settings.btn_back_generic || '◀️ Retour'), 'livreur_menu')]])
        );
    });

    bot.command('dispo', async (ctx) => {
        const userId = `${ctx.platform}_${ctx.from.id}`;
        const user = await getUser(userId);
        const settings = ctx.state?.settings || await getAppSettings();
        if (!user || !user.is_livreur) return safeEdit(ctx, t(user, 'msg_not_livreur', settings.msg_not_livreur || '❌ Vous n\'êtes pas livreur.'), Markup.inlineKeyboard([[Markup.button.callback(t(user, 'btn_back', settings.btn_back_generic || '◀️ Retour'), 'main_menu')]]));

        const statusLabel = user.is_available ? t(user, 'label_available', '✅ DISPONIBLE') : t(user, 'label_unavailable', '😴 INDISPONIBLE');

        await safeEdit(ctx,
            t(user, 'msg_livreur_status', `📢 <b>Statut actuel :</b> {status}\n\nVoulez-vous changer votre statut ?`, { status: statusLabel }),
            Markup.inlineKeyboard([
                [Markup.button.callback(t(user, 'btn_available_label', '✅ Disponible'), 'set_dispo_true'), Markup.button.callback(t(user, 'btn_unavailable_label', '😴 Indisponible'), 'set_dispo_false')],
                [Markup.button.callback(t(user, 'btn_back_menu', settings.btn_back_quick_menu || '◀️ Menu'), 'main_menu')]
            ])
        );
    });

    bot.action(/^set_dispo_(true|false)$/, async (ctx) => {
        const isAvailable = ctx.match[1] === 'true';
        const docId = `${ctx.platform}_${ctx.from.id}`;

        // 1. Toast immédiat
        await ctx.answerCbQuery(`Statut : ${isAvailable ? 'DISPONIBLE ✅' : 'INDISPONIBLE 😴'}`);

        // 2. Update DB
        await setLivreurAvailability(docId, isAvailable);

        // 3. Invalidation Cache
        if (_userCache) _userCache.delete(docId);

        // 4. Force l'affichage local (Sans attendre la DB / Cache)
        const settings = await getAppSettings();
        let user = await getUser(docId);

        // On écrase manuellement les valeurs locales pour l'interface
        if (user) {
            user.is_available = isAvailable;
            if (!user.data) user.data = {};
            user.data.is_available = isAvailable;
        }

        const { getLivreurMenuKeyboard } = require('./start');
        const city = user?.current_city || user?.data?.current_city || 'Non défini';
        const text = `${settings.ui_icon_livreur} <b>${settings.label_livreur || 'Espace Livreur'}</b>\n\n` +
            `👤 ${user ? (user.first_name || 'Inconnu') : ctx.from.first_name}\n` +
            `📍 Secteur : <b>${city.toUpperCase()}</b>\n` +
            `🔘 Statut : <b>${isAvailable ? (settings.ui_icon_success || '✅') + ' DISPONIBLE' : (settings.ui_icon_error || '❌') + ' INDISPONIBLE'}</b>\n\n` +
            `Que voulez-vous faire ?`;

        const keyboard = await getLivreurMenuKeyboard(ctx, settings, user || { is_available: isAvailable, data: { is_available: isAvailable } });
        await safeEdit(ctx, text, keyboard);

        // 5. Cleanup bouton "Démarrer"
        ctx.telegram.setChatMenuButton(ctx.chat.id, { type: 'commands' }).catch(() => { });

        // 6. Relayer à l'admin
        await notifyAdmins(bot, `🔔 <b>STATUT LIVREUR</b>\n\n👤 ${ctx.from.first_name}\n📍 Secteur : ${city.toUpperCase()}\n🔘 ${isAvailable ? '✅ DISPONIBLE' : '❌ INDISPONIBLE'}`);
    });

    // --- QUITTER L'ÉQUIPE ---
    bot.action('quit_livreur_confirm', async (ctx) => {
        await ctx.answerCbQuery();
        const userId = `${ctx.platform}_${ctx.from.id}`;
        const user = ctx.state?.user || await getUser(userId);
        await safeEdit(ctx, t(user, 'msg_quit_livreur_confirm_text', '⚠️ <b>Êtes-vous sûr ?</b>\n\nVous ne recevrez plus les alertes de commande et votre profil de livreur sera désactivé.'), Markup.inlineKeyboard([
            [Markup.button.callback(t(user, 'btn_quit_livreur_final_label', '✅ Oui, quitter l\'équipe'), 'quit_livreur_final')],
            [Markup.button.callback(t(user, 'btn_back', '◀️ Retour'), 'livreur_menu')]
        ]));
    });

    bot.action('quit_livreur_final', async (ctx) => {
        await ctx.answerCbQuery('Profil désactivé');
        const userId = `${ctx.platform}_${ctx.from.id}`;
        await supabase.from(COL_USERS).update({ is_livreur: false, is_available: false, updated_at: ts() }).eq('id', userId);
        
        // Invalider cache
        if (_userCache) _userCache.delete(userId);

        await safeEdit(ctx, '✅ <b>Profil désactivé avec succès.</b>\nVous ne faites plus partie de l\'équipe de livraison.', Markup.inlineKeyboard([
            [Markup.button.callback('◀️ Retour Menu Principal', 'main_menu')]
        ]));
        
        await notifyAdmins(bot, `🚪 <b>DÉPART LIVREUR</b>\n\n👤 ${ctx.from.first_name} a quitté l'équipe.`);
    });

    bot.command('ma_position', async (ctx) => {
        const userId = `${ctx.platform}_${ctx.from.id}`;
        const user = await getUser(userId);
        const settings = ctx.state?.settings || await getAppSettings();
        const city = ctx.message.text.split(' ')[1];
        if (!city) return ctx.reply(t(user, 'msg_update_pos_usage_text', '❌ Usage: /ma_position [ville]'));

        await updateLivreurPosition(userId, city.toLowerCase());
        await ctx.reply(t(user, 'msg_pos_updated_text', `📍 Secteur mis à jour : {city}`, { city: city.toUpperCase() }));
    });

    bot.action('change_city', async (ctx) => {
        const settings = ctx.state?.settings || await getAppSettings();
        await ctx.answerCbQuery();
        const sectors = [
            ['📍 Paris / IDF', 'sector_paris_idf'],
            ['📍 Marseille / PACA', 'sector_marseille_paca'],
            ['📍 Lyon / Rhône-Alpes', 'sector_lyon_ra'],
            ['📍 Lille / HDF', 'sector_lille_hdf'],
            ['📍 Bordeaux / Aquitaine', 'sector_bordeaux_na'],
            ['📍 Toulouse / Occitanie', 'sector_toulouse_occ'],
            ['⌨️ Autre (Saisie libre)', 'sector_manual']
        ];

        const buttons = sectors.map(s => [Markup.button.callback(s[0], s[1])]);
        buttons.push([Markup.button.callback(settings.btn_back_generic || '◀️ Retour', 'livreur_menu')]);

        await safeEdit(ctx,
            `📍 <b>SÉLECTION DU SECTEUR</b>\n\nChoisissez votre zone de livraison principale :`,
            Markup.inlineKeyboard(buttons)
        );
    });

    bot.action(/^sector_(.+)$/, async (ctx) => {
        const choice = ctx.match[1];
        if (choice === 'manual') {
            await ctx.answerCbQuery();
            await safeEdit(ctx,
                '⌨️ <b>Saisie manuelle</b>\n\nVeuillez envoyer le nom de votre ville ou secteur (ex: Bordeaux, Nice...) :',
                Markup.inlineKeyboard([[Markup.button.callback('◀️ Annuler', 'change_city')]])
            );
            ctx.state.awaiting_city = true;
            return;
        }

        const sectorMap = {
            'paris_idf': 'Paris + IDF',
            'marseille_paca': 'Marseille + PACA',
            'lyon_ra': 'Lyon + Rhône-Alpes',
            'lille_hdf': 'Lille + Hauts-de-France',
            'bordeaux_na': 'Bordeaux + Aquitaine',
            'toulouse_occ': 'Toulouse + Occitanie'
        };

        const cityName = sectorMap[choice] || choice;
        await ctx.answerCbQuery(`Secteur : ${cityName} ✅`);

        await updateLivreurPosition(`${ctx.platform}_${ctx.from.id}`, cityName.toLowerCase());

        const settings = await getAppSettings();
        const user = await getUser(`${ctx.platform}_${ctx.from.id}`);
        const { getLivreurMenuKeyboard } = require('./start');

        const city = user?.current_city || user?.data?.current_city || cityName || 'Non défini';
        const isAvail = user?.is_available || user?.data?.is_available;
        const text = `${settings.ui_icon_livreur} <b>${settings.label_livreur || 'Espace Livreur'}</b>\n\n` +
            `👤 ${user?.first_name || ctx.from.first_name}\n` +
            `📍 Secteur : <b>${city.toUpperCase()}</b>\n` +
            `🔘 Statut : <b>${isAvail ? (settings.ui_icon_success || '✅') + ' DISPONIBLE' : (settings.ui_icon_error || '❌') + ' INDISPONIBLE'}</b>\n\n` +
            `Que voulez-vous faire ?`;

        const opts = await getLivreurMenuKeyboard(ctx, settings, user);
        return await safeEdit(ctx, text, opts);
    });

    bot.action('show_available_orders', async (ctx) => {
        await ctx.answerCbQuery();
        const orders = await getAvailableOrders();
        const settings = await getAppSettings();

        // Que les ASAP
        const asap = orders.filter(o => !o.scheduled_at);

        let text = `🚀 <b>Commandes disponibles (ASAP)</b>\n\n`;
        const buttons = [];

        if (asap.length > 0) {
            asap.forEach(o => {
                const addr = o.address ? o.address.substring(0, 15) : '?';
                buttons.push([Markup.button.callback(`🚀 ${o.product_name} - ${o.total_price}€ (${addr}...)`, `view_order_${o.id}`)]);
            });
        } else {
            text = '📭 Aucune commande immédiate (ASAP) disponible.';
        }

        buttons.push([Markup.button.callback('🔄 Rafraîchir', 'show_available_orders')]);
        buttons.push([Markup.button.callback(settings.btn_back_generic || '◀️ Retour', 'livreur_menu')]);

        await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
    });

    bot.action('show_planned_orders', async (ctx) => {
        const settings = ctx.state?.settings || await getAppSettings();
        await ctx.answerCbQuery();
        const orders = await getAvailableOrders();

        const planned = orders.filter(o => o.scheduled_at);

        let text = `🗓 <b>Commandes Planifiées</b>\n\nVoici les créneaux réservés par les clients :\n`;
        const buttons = [];

        if (planned.length > 0) {
            planned.forEach(o => {
                const addr = o.address ? o.address.substring(0, 15) : '?';
                buttons.push([Markup.button.callback(`🗓 ${o.scheduled_at} - ${o.product_name} (${addr}...)`, `view_order_${o.id}`)]);
            });
        } else {
            text = '📭 Aucune commande planifiée disponible pour le moment.';
        }

        buttons.push([Markup.button.callback('🔄 Rafraîchir', 'show_planned_orders')]);
        buttons.push([Markup.button.callback(settings.btn_back_generic || '◀️ Retour', 'livreur_menu')]);

        await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
    });

    bot.action(/^view_order_(.+)$/, async (ctx) => {
        const userId = `${ctx.platform}_${ctx.from.id}`;
        const user = ctx.state?.user || await getUser(userId);
        const orderId = ctx.match[1];
        const order = await getOrder(orderId);
        const settings = ctx.state?.settings || await getAppSettings();
        
        if (!order) return ctx.answerCbQuery('❌ NO ORDER');

        // On vérifie si l'appelant est le livreur (pour le menu de prise en charge) 
        // ou le client (pour le suivi).
        const isLivreurRole = user?.is_livreur;
        
        // Si c'est un livreur qui regarde une commande "pending", on lui montre le menu d'acceptation
        if (isLivreurRole && (order.status === 'pending' || order.status === 'supplier_pending')) {
            await ctx.answerCbQuery();
            const text = t(user, 'msg_order_mission_details_text', `📦 <b>Détails de la mission #${orderId.slice(-5)}</b>\n\n`, { id: orderId.slice(-5) }) +
                t(user, 'label_product', `🛒 Produit :`) + ` <b>${order.product_name}</b>\n` +
                t(user, 'label_address', `📍 Adresse :`) + ` <code>${order.address || 'Non spécifiée'}</code>\n` +
                t(user, 'label_price_total', `💰 Total :`) + ` <b>${order.total_price}€</b>\n` +
                t(user, 'label_scheduled_for', `🕒 Créneau :`) + ` <b>${order.scheduled_at ? order.scheduled_at : t(user, 'label_delivery_asap', 'Dès que possible (ASAP)')}</b>\n\n` +
                t(user, 'msg_accept_confirm', `<i>Voulez-vous prendre en charge cette livraison ?</i>`);

            const buttons = [
                [Markup.button.callback(t(user, 'btn_accept_mission_label', '🔥 ACCEPTER LA MISSION 🔥'), `take_order_${orderId}`)],
                [Markup.button.callback(t(user, 'btn_cancel', settings.btn_cancel || '◀️ Annuler'), 'show_available_orders')]
            ];
            return safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
        }

        // Sinon, c'est la vue CLIENT (suivi de commande)
        await ctx.answerCbQuery();
        let statusEmoji = o => o.status === 'pending' ? '⏳' : (o.status === 'taken' ? '🚚' : (o.status === 'delivered' ? '✅' : '❌'));
        let statusLabel = o => o.status === 'pending' ? t(user, 'label_pending', 'En attente') : (o.status === 'taken' ? t(user, 'label_taken', 'En cours') : (o.status === 'delivered' ? t(user, 'label_delivered', 'Livrée') : t(user, 'label_cancelled', 'Annulée')));

        let text = t(user, 'msg_order_tracking', `📦 <b>Suivi Commande #${orderId.slice(-5)}</b>`, { id: orderId.slice(-5) }) + `\n\n` +
            t(user, 'label_status', `🔹 Statut :`) + ` ${statusEmoji(order)} <b>${statusLabel(order)}</b>\n` +
            t(user, 'label_product', `🛒 Produit :`) + ` <b>${order.product_name}</b>\n` +
            t(user, 'label_price_total', `💰 Prix :`) + ` <b>${order.total_price}€</b>\n` +
            t(user, 'label_address', `📍 Adresse :`) + ` <code>${order.address}</code>\n`;
        
        if (order.livreur_name) {
            text += t(user, 'label_livreur', `👤 Livreur :`) + ` <b>${order.livreur_name}</b>\n`;
        }
        
        const feedbackBtn = order.status === 'delivered' ? [Markup.button.callback(t(user, 'btn_leave_review', '⭐ Laisser un avis'), `rate_order_${orderId}`)] : [];
        const cancelBtn = (order.status === 'pending' || order.status === 'taken' || order.status === 'supplier_pending') ? [Markup.button.callback(t(user, 'btn_cancel_order_label', '❌ Annuler la commande'), `cancel_order_client_${orderId}`)] : [];
        const chatBtn = (order.status === 'taken') ? [Markup.button.callback(t(user, 'btn_chat_livreur', '💬 Parler au livreur'), `chat_livreur_${orderId}`)] : [];

        const buttons = [];
        if (chatBtn.length) buttons.push(chatBtn);
        if (cancelBtn.length) buttons.push(cancelBtn);
        if (feedbackBtn.length) buttons.push(feedbackBtn);
        buttons.push([Markup.button.callback(t(user, 'btn_back_orders', '◀️ Retour mes commandes'), 'my_orders')]);

        await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
    });

    bot.action(/^take_order_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const orderId = ctx.match[1];
        const settings = ctx.state?.settings || await getAppSettings();
        const order = await getOrder(orderId);

        if (!order || order.status !== 'pending') return safeEdit(ctx, settings.msg_order_not_available || '❌ Cette commande n\'est plus disponible.', Markup.inlineKeyboard([[Markup.button.callback(settings.btn_back_generic || '◀️ Retour', 'show_available_orders')]]));

        await updateOrderStatus(orderId, 'taken', {
            livreur_id: `${ctx.platform}_${ctx.from.id}`,
            livreur_name: ctx.from.first_name
        });
        await safeEdit(ctx,
            `${settings.ui_icon_success} <b>Commande #${orderId.slice(-5)} acceptée !</b>\n\n` +
            `📦 Produit : <b>${order.product_name}</b>\n` +
            `📍 Adresse : <code>${order.address}</code>\n` +
            (order.scheduled_at ? `🕒 <b>PRÉVU POUR : ${order.scheduled_at}</b>\n\n` : `🕒 Dès que possible\n\n`) +
            `💰 Total à encaisser : <b>${order.total_price}€</b>\n\n` +
            `💡 <i>Pensez à partager votre position en direct pour notifier le client de votre arrivée.</i>\n\n` +
            `Cliquez sur le bouton ci-dessous une fois livré :`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('⏰ Arrivée -1h', `notify_${orderId}_1h`)],
                    [Markup.button.callback(settings.btn_notify_30min || '⏳ 30 min', `notify_${orderId}_30m`), Markup.button.callback(settings.btn_notify_10min || '⏳ 10 min', `notify_${orderId}_10m`)],
                    [Markup.button.callback('⚡ 5 min', `notify_${orderId}_5m`), Markup.button.callback('📍 Arrivé', `notify_${orderId}_here`)],
                    [Markup.button.callback('⚠️ Signaler un RETARD', `delay_report_${orderId}`)],
                    [Markup.button.callback(`${settings.ui_icon_success} MARQUER COMME LIVRÉE`, `finish_${orderId}`)],
                    [Markup.button.callback('◀️ Retour Menu Livreur', 'livreur_menu')]
                ])
            }
        ).catch(() => { });

        // Notifier le client avec option d'annulation et aide
        if (order.user_id) {
            await sendTelegramMessage(order.user_id,
                `🚚 <b>Bonne nouvelle !</b>\n\n` +
                `Votre commande #${orderId.slice(-5)} est prise en charge par <b>${settings.bot_name || 'notre équipe'}</b>.\n` +
                `⏳ Une estimation du temps d'arrivé vous sera donnée dans quelques minutes.\n\n` +
                `<i>Besoin de parler au livreur ou à l'admin ? Utilisez les boutons ci-dessous.</i>`,
                {
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('💬 Parler au livreur', `chat_livreur_${orderId}`)],
                        [Markup.button.callback(settings.btn_help_support || '❓ Aide & Support', 'help_menu')],
                        [Markup.button.callback(settings.btn_cancel_my_order || '❌ Annuler ma commande', `cancel_order_client_${orderId}`)]
                    ])
                }
            );
        }

        // Relayer à l'admin
        await notifyAdmins(bot, `🚗 <b>COMMANDE ACCEPTÉE</b>\n\n🆔 Commande : <code>#${orderId.slice(-5)}</code>\n👤 Livreur : ${ctx.from.first_name}\n📦 Produit : ${order.product_name}\n📍 Adresse : ${order.address}\n💰 Total : ${order.total_price}€`);
    });

    bot.action(/^notify_(.+)_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery('Notification envoyée ✅');
        const orderId = ctx.match[1];
        const timeCode = ctx.match[2];
        const order = await getOrder(orderId);
        if (!order) return;

        let timeText = "";
        if (timeCode === '1h') timeText = "⏰ dans - d'1h";
        else if (timeCode === '30m') timeText = "⏳ dans 30 min";
        else if (timeCode === '10m') timeText = "⏳ dans 10 min";
        else if (timeCode === '5m') timeText = "⚡ dans 5 min";
        else if (timeCode === 'here') timeText = "📍 Suis arrivé, descends";

        await sendTelegramMessage(order.user_id,
            `🔔 <b>Mise à jour Livraison #${orderId.slice(-5)}</b>\n\n` +
            `Votre livreur vous informe qu'il arrive : <b>${timeText}</b>\n\n` +
            `<i>Restez joignable !</i>`,
            {
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('💬 Répondre au livreur', `chat_livreur_${orderId}`)],
                    [Markup.button.callback('◀️ Menu principal', 'main_menu')]
                ])
            }
        );

        // Relayer à l'admin
        const settings = await getAppSettings();
        await notifyAdmins(bot, `⏳ <b>ETA ENVOYÉ</b>\n\n🆔 Commande : <code>#${orderId.slice(-5)}</code>\n👤 Livreur : ${ctx.from.first_name}\n🕒 ETA : ${timeText}`);
    });

    bot.action(/^delay_report_(.+)$/, async (ctx) => {
        const orderId = ctx.match[1];
        await ctx.answerCbQuery();
        const userId = `${ctx.platform}_${ctx.from.id}`;

        const order = await getOrder(orderId);
        const count = parseInt(order?.chat_count) || 0;
        if (count >= 6) {
            return ctx.reply("⚠️ <b>Limite d'échanges atteinte.</b>\n\nVous avez déjà utilisé les 6 messages autorisés pour cette commande.", { parse_mode: 'HTML' });
        }

        // Nettoyage des autres états
        awaitingChatReply.delete(userId);
        awaitingDelayReason.set(userId, orderId);

        await safeEdit(ctx, `⚠️ <b>SIGNALEMENT DE RETARD (${6 - count} restants)</b>\n\nIndiquez la raison ou le temps estimé (ex: "10 min de retard, bouchons") :`,
            Markup.inlineKeyboard([[Markup.button.callback('◀️ Annuler', `view_active_${orderId}`)]])
        );
    });

    bot.action(/^chat_livreur_(.+)$/, async (ctx) => {
        const orderId = ctx.match[1];
        await ctx.answerCbQuery();
        const userId = `${ctx.platform}_${ctx.from.id}`;

        const order = await getOrder(orderId);
        const count = parseInt(order?.chat_count) || 0;
        const isLivreur = `${ctx.platform}_${ctx.from.id}` === order.livreur_id;

        // Validation stricte du schéma : 1. Client -> 2. Livreur -> 3. Client ... -> 6
        if (count >= 6) {
            return ctx.reply("⚠️ <b>Limite d'échanges atteinte.</b>\n\nLe chat est clôturé (6/6).", { parse_mode: 'HTML' });
        }

        if (count % 2 === 1 && !isLivreur) {
            return ctx.reply(`⏳ <b>Attendez la réponse du livreur.</b> (Message ${count}/6 déjà envoyé)`, { parse_mode: 'HTML' });
        }
        if (count % 2 === 0 && count > 0 && isLivreur) {
            return ctx.reply(`✅ <b>Vous avez déjà répondu.</b>\n\nLe client doit renvoyer un message (${count}/6).`, { parse_mode: 'HTML' });
        }

        // Nettoyage des autres états
        awaitingDelayReason.delete(userId);

        const targetId = isLivreur ? order.user_id : order.livreur_id;
        const targetRole = isLivreur ? "client" : "livreur";

        awaitingChatReply.set(`${ctx.platform}_${ctx.from.id}`, { orderId, targetId, role: targetRole });

        let promptText = `💬 <b>Message (${count + 1}/6)</b>\nEnvoyez votre message :`;
        if (count === 5) promptText = "💬 <b>Dernier message de conclusion (6/6)</b>\nEnvoyez votre message final :";

        await ctx.reply(promptText, { parse_mode: 'HTML' });
    });

    bot.action(/^abandon_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const orderId = ctx.match[1];
        const order = await getOrder(orderId);
        const settings = ctx.state?.settings || await getAppSettings();
        if (!order) return safeEdit(ctx, settings.msg_order_not_found || '❌ Commande introuvable.');

        await updateOrderStatus(orderId, 'validated', { livreur_id: null, livreur_name: null });
        await safeEdit(ctx, `⚠️ <b>COMMANDE ABANDONNÉE</b>\n\nLa commande #${orderId.slice(-5)} a été remise dans le pool.`, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([[Markup.button.callback(settings.btn_back_quick_menu || '◀️ Retour Menu', 'livreur_menu')]])
        });
        await notifyAdmins(bot, `⚠️ <b>LIVREUR ABANDON</b>\n\n🆔 Commande : <code>#${orderId.slice(-5)}</code>\n👤 Par : ${ctx.from.first_name}\nL'ordre est de nouveau disponible.`);
    });

    bot.action(/^finish_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const orderId = ctx.match[1];
        const settings = ctx.state?.settings || await getAppSettings();
        const order = await getOrder(orderId);

        if (!order) {
            return safeEdit(ctx, settings.msg_order_not_found || `❌ Commande introuvable.`, Markup.inlineKeyboard([[Markup.button.callback(settings.btn_back_quick_menu || '◀️ Retour Menu', 'livreur_menu')]]));
        }

        await updateOrderStatus(orderId, 'delivered', {
            livreur_id: `${ctx.platform}_${ctx.from.id}`,
            livreur_name: ctx.from.first_name
        });
        await incrementOrderCount(`${ctx.platform}_${ctx.from.id}`);

        await safeEdit(ctx, `✅ Commande <b>#${orderId.slice(-5)}</b> marquée comme LIVRÉE !\nFélicitations pour votre livraison.`, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([[Markup.button.callback(settings.btn_back_to_livreur_menu || '◀️ Retour Menu Livreur', 'livreur_menu')]])
        });

        // Notifier client + Feedback
        if (order.user_id) {
            const deliveredMsg = settings.msg_status_delivered || `✅ <b>Votre commande #{short_id} a été livrée !</b>\n\nMerci de votre confiance et à bientôt chez ${settings.bot_name} !`;
            const finalDeliveredMsg = deliveredMsg.replace('{short_id}', orderId.slice(-5));

            await sendTelegramMessage(order.user_id,
                finalDeliveredMsg,
                {
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback(settings.btn_back_menu || '◀️ Retour Menu', 'main_menu')]
                    ])
                }
            );
        }

        // Relayer à l'admin
        await notifyAdmins(bot, `✅ <b>COMMANDE LIVRÉE</b>\n\n🆔 Commande : <code>#${orderId.slice(-5)}</code>\n👤 Livreur : ${ctx.from.first_name}\n📦 Produit : ${order.product_name}\n💰 Montant : ${order.total_price}€`);
    });

    // --- Gestion de l'annulation par le client ---
    bot.action(/^cancel_order_client_(.+)$/, async (ctx) => {
        const orderId = ctx.match[1];
        const settings = ctx.state?.settings || await getAppSettings();
        const order = await getOrder(orderId);
        if (!order || order.status === 'delivered' || order.status === 'cancelled') {
            return ctx.answerCbQuery('Action impossible ou déjà effectuée.', true);
        }

        await updateOrderStatus(orderId, 'cancelled');
        await ctx.answerCbQuery('Votre commande a été annulée. ❌', true);

        const shortId = orderId.slice(-5);
        await safeEdit(ctx, `❌ <b>Commande #${shortId} annulée</b>\n\nVotre demande d'annulation a bien été prise en compte.`, Markup.inlineKeyboard([[Markup.button.callback(settings.btn_back_quick_menu || '◀️ Retour Menu', 'main_menu')]]));

        // Notifier Admin
        const alertMsg = `⚠️ <b>ANNULATION CLIENT</b>\n\nLa commande <b>#${shortId}</b> a été annulée par le client.\n👤 Client: ${ctx.from.first_name}`;
        await notifyAdmins(bot, alertMsg);

        // Notifier Livreur
        if (order.livreur_id) {
            await sendTelegramMessage(order.livreur_id, `⚠️ <b>COMMANDE ANNULÉE</b>\n\nLe client a annulé la commande <b>#${shortId}</b>. Ne vous déplacez pas.`);
        }
    });

    // --- Gestion de l'annulation par le livreur ---
    bot.action(/^cancel_order_livreur_(.+)$/, async (ctx) => {
        const orderId = ctx.match[1];
        const settings = ctx.state?.settings || await getAppSettings();
        const order = await getOrder(orderId);
        if (!order || order.status === 'delivered' || order.status === 'cancelled') {
            return ctx.answerCbQuery('Action impossible ou déjà effectuée.', true);
        }

        await updateOrderStatus(orderId, 'cancelled');
        await ctx.answerCbQuery('La commande a été annulée. ❌', true);

        const shortId = orderId.slice(-5);
        await safeEdit(ctx, `🚩 <b>COMMANDE #${shortId} ANNULÉE</b>\n\nL'annulation a bien été effectuée.`, Markup.inlineKeyboard([[Markup.button.callback(settings.btn_back_to_livreur_menu || '◀️ Menu Livreur', 'livreur_menu')]]));

        // Notifier Admin
        const alertMsg = `🚩 <b>ANNULATION LIVREUR</b>\n\nLa commande <b>#${shortId}</b> a été annulée par le livreur.\n👤 Livreur: ${ctx.from.first_name}`;
        await notifyAdmins(bot, alertMsg);

        // Notifier Client
        if (order.client_id) {
            await sendTelegramMessage(order.client_id, `🚩 <b>COMMANDE ANNULÉE</b>\n\nVotre commande <b>#${shortId}</b> a été annulée par le livreur.\nMotif: Incident ou stock indisponible.`);
        }
    });

    bot.action(/^feedback_start_(.+)$/, async (ctx) => {
        const orderId = ctx.match[1];
        const settings = ctx.state?.settings || await getAppSettings();
        await ctx.answerCbQuery();
        await safeEdit(ctx,
            `🌟 <b>Donnez votre avis !</b>\n\n` +
            `Votre satisfaction est notre priorité. Comment s'est passée votre commande ?\n\n` +
            `Choisissez une note ci-dessous :`,
            Markup.inlineKeyboard([
                [Markup.button.callback(settings.btn_rate_5 || '⭐️⭐️⭐️⭐️⭐️ Excellent', `feedback_rate_${orderId}_5`)],
                [Markup.button.callback(settings.btn_rate_4 || '⭐️⭐️⭐️⭐️ Très bien', `feedback_rate_${orderId}_4`)],
                [Markup.button.callback(settings.btn_rate_3 || '⭐️⭐️⭐️ Bien', `feedback_rate_${orderId}_3`)],
                [Markup.button.callback(settings.btn_rate_1 || '⭐️ Moyen / Insatisfait', `feedback_rate_${orderId}_1`)],
                [Markup.button.callback(settings.btn_back_generic || '◀️ Plus tard', 'main_menu')]
            ])
        );
    });

    bot.action(/^feedback_skip_(.+)$/, async (ctx) => {
        const orderId = ctx.match[1];
        await ctx.answerCbQuery();
        const pending = await getAndClearPendingFeedback(`${ctx.platform}_${ctx.from.id}`);
        if (pending) {
            const comment = "Note envoyée sans commentaire";
            await saveFeedback(orderId, parseInt(pending.rate), comment);
            await sendFeedbackNotifications(orderId, pending.rate, comment, ctx);
        }
        const settings = ctx.state?.settings || await getAppSettings();
        await safeEdit(ctx, settings.msg_thanks_for_feedback || "🙏 Merci pour votre note !", Markup.inlineKeyboard([[Markup.button.callback(settings.btn_back_quick_menu || '◀️ Retour Menu', 'main_menu')]]));
    });

    bot.action(/^feedback_rate_(.+)_(.+)$/, async (ctx) => {
        const [, orderId, rate] = ctx.match;
        await ctx.answerCbQuery();

        const { setPendingFeedback } = require('../services/database');
        await setPendingFeedback(`${ctx.platform}_${ctx.from.id}`, orderId, rate);

        const settings = ctx.state?.settings || await getAppSettings();
        await safeEdit(ctx,
            `✍️ <b>Un dernier mot ?</b>\n\nEnvoyez votre commentaire en répondant à ce message (ex: "Livraison rapide, au top !") :\n\n<i>Vous pouvez aussi joindre une photo 📸</i>`,
            Markup.inlineKeyboard([
                [Markup.button.callback(settings.btn_confirm_review || '⏭ Envoyer juste la note', `feedback_skip_${orderId}`)]
            ])
        );
    });

    // --- New Review System ---
    bot.action('leave_review', async (ctx) => {
        const settings = ctx.state?.settings || await getAppSettings();
        await ctx.answerCbQuery();
        await safeEdit(ctx,
            `🏮 <b>Laissez votre avis !</b>\n\nNotez votre expérience globale avec nous :`,
            Markup.inlineKeyboard([
                [Markup.button.callback(settings.btn_rate_5 || '⭐️⭐️⭐️⭐️⭐️ Excellent', 'review_rate_5')],
                [Markup.button.callback(settings.btn_rate_4 || '⭐️⭐️⭐️⭐️ Très bien', 'review_rate_4')],
                [Markup.button.callback(settings.btn_rate_3 || '⭐️⭐️⭐️ Bien', 'review_rate_3')],
                [Markup.button.callback(settings.btn_rate_1 || '⭐️ Moyen', 'review_rate_1')],
                [Markup.button.callback(settings.btn_back_generic || '◀️ Retour', 'main_menu')]
            ])
        );
    });

    bot.action(/^review_rate_(.+)$/, async (ctx) => {
        const rate = parseInt(ctx.match[1]);
        const settings = ctx.state?.settings || await getAppSettings();
        await ctx.answerCbQuery();
        const userId = `${ctx.platform}_${ctx.from.id}`;
        awaitingReviewText.set(userId, { rate, photos: [], step: 'text' });

        await safeEdit(ctx,
            `✍️ <b>Dites-nous en plus !</b>\n\nÉcrivez votre commentaire ci-dessous.\n<i>Vous pourrez ajouter des photos/vidéos ensuite.</i>`,
            Markup.inlineKeyboard([
                [Markup.button.callback('⏭ Envoyer juste la note', 'review_skip')],
                [Markup.button.callback(settings.btn_cancel_alt || '❌ Annuler', 'main_menu')]
            ])
        );
    });

    // Fonction utilitaire pour uploader un média de review
    async function _uploadReviewMedia(ctx, userId, mediaItem, isVideo = false) {
        const ext = isVideo ? '.mp4' : '.jpg';
        if (ctx.platform === 'whatsapp' && mediaItem.isWa) {
            try {
                const { uploadMediaBuffer } = require('../services/database');
                const buffer = await ctx.channel.downloadMedia(mediaItem.msg);
                if (buffer) return await uploadMediaBuffer(buffer, `rev_${Date.now()}${ext}`);
            } catch (e) { console.error('[REVIEW-MEDIA-WA]', e.message); }
        } else if (ctx.platform === 'telegram') {
            try {
                const fileId = isVideo
                    ? (Array.isArray(mediaItem) ? mediaItem[0]?.file_id : mediaItem?.file_id)
                    : (Array.isArray(mediaItem) ? mediaItem[mediaItem.length - 1]?.file_id : mediaItem?.file_id);
                if (fileId) {
                    const link = await ctx.telegram.getFileLink(fileId);
                    return await uploadMediaFromUrl(link.href, `rev_${Date.now()}${ext}`);
                }
            } catch (e) {
                console.warn('[REVIEW-MEDIA-TG] Upload failed, using file_id:', e.message);
                const mediaArr = Array.isArray(mediaItem) ? mediaItem : [mediaItem];
                return mediaArr[mediaArr.length - 1]?.file_id || null;
            }
        }
        return null;
    }

    bot.action('review_skip', async (ctx) => {
        await ctx.answerCbQuery();
        const userId = `${ctx.platform}_${ctx.from.id}`;
        const data = awaitingReviewText.get(userId);

        if (data) {
            awaitingReviewText.delete(userId);
            const { saveReview, getAppSettings } = require('../services/database');

            await saveReview({
                user_id: userId,
                username: ctx.from.username || '?',
                first_name: ctx.from.first_name || 'Anonyme',
                text: data.text || "Note envoyée sans commentaire",
                rating: parseInt(data.rate),
                photos: data.photos || [],
                is_public: true
            });

            const settings = await getAppSettings();
            const stars = '⭐'.repeat(data.rate);
            const mediaCount = (data.photos || []).length;
            await notifyAdmins(bot, `🌟 <b>NOUVEL AVIS GÉNÉRAL !</b>\n\n👤 Client : ${ctx.from.first_name}\n🌟 Note : ${stars}\n💬 Commentaire : ${data.text || '(Sans commentaire)'}${mediaCount > 0 ? `\n🖼 ${mediaCount} média(s) joint(s)` : ''}`);

            await safeEdit(ctx, settings.msg_review_thanks || '✅ <b>Merci !</b> Votre note a été enregistrée. 🏮', {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour Menu', 'main_menu')]])
            });
        } else {
            await safeEdit(ctx, '❌ Session expirée.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu', 'main_menu')]]));
        }
    });

    // Hint button — just tells user to send a photo/video directly
    bot.action('review_add_media_hint', async (ctx) => {
        await ctx.answerCbQuery('📸 Envoyez une photo ou vidéo directement dans le chat !', { show_alert: true });
    });

    // Finaliser l'avis après avoir ajouté les médias
    bot.action('review_submit', async (ctx) => {
        await ctx.answerCbQuery();
        const userId = `${ctx.platform}_${ctx.from.id}`;
        const data = awaitingReviewText.get(userId);

        if (!data) {
            return safeEdit(ctx, '❌ Session expirée.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu', 'main_menu')]]));
        }

        awaitingReviewText.delete(userId);
        const { saveReview, getAppSettings } = require('../services/database');
        const settings = await getAppSettings();

        await saveReview({
            user_id: userId,
            username: ctx.from.username || '?',
            first_name: ctx.from.first_name || 'Anonyme',
            text: data.text || "Note envoyée sans commentaire",
            rating: parseInt(data.rate),
            photos: data.photos || [],
            is_public: true
        });

        const stars = '⭐'.repeat(data.rate);
        const mediaCount = (data.photos || []).length;
        await notifyAdmins(bot, `🌟 <b>NOUVEL AVIS GÉNÉRAL !</b>\n\n👤 Client : ${esc(ctx.from.first_name)}\n🌟 Note : ${stars}\n💬 ${esc(data.text || '(Sans commentaire)')}${mediaCount > 0 ? `\n🖼 ${mediaCount} média(s)` : ''}`);

        await safeEdit(ctx, settings.msg_review_thanks || '✅ <b>Merci !</b> Votre avis a été publié anonymement. 🏮', {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([[Markup.button.callback(settings.btn_back_menu || '◀️ Retour Menu', 'main_menu')]])
        });
    });

    // State for review pagination
    const reviewPagination = new Map();

    bot.action(/^view_reviews(?:_(\d+))?$/, async (ctx) => {
        await ctx.answerCbQuery();
        const settings = ctx.state?.settings || await getAppSettings();
        const { getPublicReviews } = require('../services/database');
        const { esc } = require('../services/utils');

        const index = parseInt(ctx.match[1] || 0);
        const reviews = await getPublicReviews(10); // Get up to 10 latest

        if (reviews.length === 0) {
            return safeEdit(ctx, settings.msg_no_reviews_yet || "📭 Aucun avis pour le moment. Soyez le premier !", Markup.inlineKeyboard([[Markup.button.callback('⭐️ Laisser un avis', 'leave_review')], [Markup.button.callback(settings.btn_back_quick_menu || '◀️ Menu', 'main_menu')]]));
        }

        const r = reviews[index];
        const stars = '⭐'.repeat(r.rating || 0);
        const d = new Date(r.created_at);
        const date = !isNaN(d.getTime()) ? d.toLocaleDateString('fr-FR') : '—';
        const text = `👥 <b>Avis de la famille (${index + 1}/${reviews.length})</b>\n\n` +
            `${stars}\n"<i>${esc(r.text) || 'Sans commentaire'}</i>"\n\n` +
            `👤 <b>Client de la famille</b> - ${date}`;

        // Photo/Video resolution
        let photo = r.photo_file_id || null;
        let video = null;
        if (!photo) {
            let photos = r.photos;
            if (typeof photos === 'string') { try { photos = JSON.parse(photos); } catch (e) { photos = []; } }
            if (!Array.isArray(photos)) photos = photos ? [photos] : [];
            const mediaUrl = photos.find(p => p && !String(p).includes('api.telegram.org/file/')) || null;
            if (mediaUrl) {
                const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
                if (videoExts.some(ext => String(mediaUrl).toLowerCase().includes(ext))) {
                    video = mediaUrl;
                } else {
                    photo = mediaUrl;
                }
            }
        }

        const navButtons = [];
        if (index > 0) navButtons.push(Markup.button.callback(settings.btn_previous || '⬅️ Précédent', `view_reviews_${index - 1}`));
        if (index < reviews.length - 1) navButtons.push(Markup.button.callback(settings.btn_next || 'Suivant ➡️', `view_reviews_${index + 1}`));

        const keyboard = [
            navButtons,
            [Markup.button.callback('⭐️ Laisser un avis', 'leave_review')],
            [Markup.button.callback(settings.btn_back_quick_menu || '◀️ Retour Menu', 'main_menu')]
        ];
        await safeEdit(ctx, text, {
            photo: photo,
            video: video,
            ...Markup.inlineKeyboard(keyboard)
        });
    });

    bot.action(/^view_broadcasts(?:_(\d+))?$/, async (ctx) => {
        await ctx.answerCbQuery();
        const { getBroadcastHistory } = require('../services/database');
        const settings = ctx.state?.settings || await getAppSettings();
        const index = parseInt(ctx.match[1] || 0);
        const broadcasts = await getBroadcastHistory(50, false); // 50 derniers (inclus expirés pour le sondage)

        if (broadcasts.length === 0) {
            return safeEdit(ctx, settings.msg_no_information || "📭 Aucune information à afficher pour le moment.", Markup.inlineKeyboard([[Markup.button.callback(settings.btn_back_quick_menu || '◀️ Menu', 'main_menu')]]));
        }

        const b = broadcasts[index];
        const d = new Date(b.created_at);
        const date = !isNaN(d.getTime()) ? d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

        // Badge / Banderole
        const badgeTxt = b.badge ? `<b>[${b.badge.toUpperCase()}]</b> ` : "";

        // Décoder le message s'il contient des médias
        let fullMsg = b.message || "";
        let photo = null;
        let video = null;
        if (fullMsg.includes("|||MEDIA_URLS|||")) {
            const parts = fullMsg.split("|||MEDIA_URLS|||");
            fullMsg = parts[0];
            try {
                const mediaItems = JSON.parse(parts[1]);
                if (mediaItems && mediaItems.length > 0) {
                    const firstItem = mediaItems[0];
                    // Nouveau format: {url, type} — Ancien format: string URL
                    const mediaUrl = typeof firstItem === 'string' ? firstItem : firstItem.url;
                    let mediaType = typeof firstItem === 'object' ? firstItem.type : null;
                    // Auto-détection par extension si pas de type
                    if (!mediaType && mediaUrl) {
                        const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
                        mediaType = videoExts.some(ext => mediaUrl.toLowerCase().includes(ext)) ? 'video' : 'photo';
                    }
                    if (mediaType === 'video') {
                        video = mediaUrl;
                    } else {
                        photo = mediaUrl;
                    }
                }
            } catch (e) {
                console.error("Error parsing media URLs for broadcast:", e);
            }
        }

        const userId = `${ctx.platform}_${ctx.from.id}`;
        let text = `📣 <b>Informations & Annonces (${index + 1}/${broadcasts.length})</b>\n\n` +
            `📅 <i>Posté le ${date}</i>\n\n` +
            `${badgeTxt}${fullMsg}`;

        const pollRows = [];
        if (b.poll_data && b.poll_data.options) {
            const poll = b.poll_data;
            const hasVoted = poll.votes && poll.votes[userId];
            const hasFreeResponse = poll.free_responses && poll.free_responses[userId];

            if (hasVoted || hasFreeResponse) {
                text += `\n\n✅ <b>${settings.msg_thanks_participation || 'Merci pour votre participation !'}</b>`;
                if (hasFreeResponse) {
                    text += `\n\n✍️ <i>${settings.msg_your_answer || 'Votre réponse'} : ${poll.free_responses[userId].text}</i>`;
                }
            } else {
                // Afficher les options de vote
                poll.options.forEach((opt, idx) => {
                    pollRows.push([Markup.button.callback(opt, `poll_vote_${b.id}_${idx}_${index}`)]);
                });
                if (poll.poll_allow_free) {
                    pollRows.push([Markup.button.callback('🖊 Réponse libre', `poll_free_${b.id}_${index}`)]);
                }
            }
        }

        const navButtons = [];
        if (index > 0) navButtons.push(Markup.button.callback(settings.btn_previous || '⬅️ Précédent', `view_broadcasts_${index - 1}`));
        if (index < broadcasts.length - 1) navButtons.push(Markup.button.callback(settings.btn_next || 'Suivant ➡️', `view_broadcasts_${index + 1}`));

        const keyboard = [
            ...pollRows,
            navButtons,
            [Markup.button.callback(settings.btn_back_quick_menu || '◀️ Retour Menu', 'main_menu')]
        ];

        await safeEdit(ctx, text, {
            photo: photo,
            video: video,
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard(keyboard)
        });
    });

    // Capture des messages spéciaux (Feedback, Retard, Chat)
    bot.on('message', async (ctx, next) => {
        const userId = `${ctx.platform}_${ctx.from.id}`;
        const settings = await getAppSettings();

        // 1. Feedback (Orders)
        const pendingOrderFeedback = await getAndClearPendingFeedback(userId);
        if (pendingOrderFeedback) {
            const { orderId, rate } = pendingOrderFeedback;
            const text = ctx.message.text || ctx.message.caption || "(Avis sans texte)";
            // Capture de média (Photo ou Vidéo)
            const photo = ctx.message.photo ? (Array.isArray(ctx.message.photo) ? ctx.message.photo[ctx.message.photo.length - 1] : ctx.message.photo) : null;
            const video = ctx.message.video || null;
            const media = photo || video;

            // Save to bot_orders feedback fields
            await saveFeedback(orderId, parseInt(rate), text);

            let finalMediaUrls = [];
            if (media) {
                const isVideo = !!video;
                const ext = isVideo ? '.mp4' : '.jpg';
                const fileName = `rev_${Date.now()}${ext}`;

                if (ctx.platform === 'whatsapp' && media.isWa) {
                    try {
                        const { uploadMediaBuffer } = require('../services/database');
                        const buffer = await ctx.channel.downloadMedia(media.msg);
                        if (buffer) {
                             const mime = isVideo ? 'video/mp4' : 'image/jpeg';
                            const permanentUrl = await uploadMediaBuffer(buffer, fileName, mime);
                            finalMediaUrls.push(permanentUrl);
                        }
                    } catch (e) {
                        console.error('[WA-REVIEW] Media processing failed:', e.message);
                    }
                } else if (ctx.telegram) {
                    try {
                        const fileId = media.file_id || media;
                        const link = await ctx.telegram.getFileLink(fileId);
                        const permanentUrl = await uploadMediaFromUrl(link.href, fileName);
                        finalMediaUrls.push(permanentUrl);
                    } catch (e) {
                        console.warn('[REVIEW] Upload to storage failed, using file_id:', e.message);
                        finalMediaUrls.push(media.file_id || media); 
                    }
                }
            }

            // Also save to generic bot_reviews
            await saveReview({
                user_id: userId,
                username: ctx.from.username || 'Inconnu',
                first_name: ctx.from.first_name || 'Anonyme',
                text,
                rating: parseInt(rate),
                order_id: orderId,
                photos: finalMediaUrls,
                is_public: true
            });

            await sendFeedbackNotifications(orderId, rate, text, ctx);

            await safeEdit(ctx,
                '🙏 <b>Merci pour votre retour !</b>\n\nVotre avis a bien été enregistré. 🏮',
                { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour Menu', 'main_menu')]]) }
            );
            return;
        }

        // 2. Generic Review (Not tied to order, or from main menu) — Multi-step flow
        if (awaitingReviewText.has(userId)) {
            const data = awaitingReviewText.get(userId);
            const photo = ctx.message.photo ? (Array.isArray(ctx.message.photo) ? ctx.message.photo[ctx.message.photo.length - 1] : ctx.message.photo) : null;
            const video = ctx.message.video || null;
            const hasMedia = !!(photo || video);
            const incomingText = ctx.message.text || ctx.message.caption || null;

            // STEP 1: Awaiting text comment
            if (!data.step || data.step === 'text') {
                const reviewText = incomingText || "(Avis sans texte)";
                data.text = reviewText;
                data.step = 'media';
                awaitingReviewText.set(userId, data);

                const mediaButtons = [
                    [Markup.button.callback('📸 Ajouter une photo/vidéo', 'review_add_media_hint')],
                    [Markup.button.callback('✅ Envoyer maintenant', 'review_submit')]
                ];
                await safeEdit(ctx,
                    `✅ <b>Commentaire enregistré !</b>\n\n💬 "${reviewText}"\n\n📎 Vous pouvez maintenant ajouter des photos ou vidéos, ou envoyer directement votre avis.`,
                    { parse_mode: 'HTML', ...Markup.inlineKeyboard(mediaButtons) }
                );
                return;
            }

            // STEP 2: Awaiting media (or submit)
            if (data.step === 'media') {
                if (hasMedia) {
                    // Upload the media and accumulate
                    const isVideo = !!video;
                    const mediaItem = video || photo;
                    const url = await _uploadReviewMedia(ctx, userId, mediaItem, isVideo);
                    if (url) {
                        data.photos = data.photos || [];
                        data.photos.push(url);
                        awaitingReviewText.set(userId, data);
                    }

                    const count = (data.photos || []).length;
                    const reviewSettings = ctx.state?.settings || await getAppSettings();
                    const mediaButtons = [
                        [Markup.button.callback(`📸 Ajouter une autre (${count} ajoutée${count > 1 ? 's' : ''})`, 'review_add_media_hint')],
                        [Markup.button.callback(reviewSettings.btn_send_now || '✅ Envoyer maintenant', 'review_submit')]
                    ];
                    await safeEdit(ctx,
                        `✅ <b>${count} média${count > 1 ? 's' : ''} ajouté${count > 1 ? 's' : ''} !</b>\n\nEnvoyez d'autres photos/vidéos ou cliquez sur <b>Envoyer maintenant</b>.`,
                        { parse_mode: 'HTML', ...Markup.inlineKeyboard(mediaButtons) }
                    );
                    return;
                } else if (incomingText) {
                    // User typed text in media step — treat as "submit" intent
                    // Fall through to finalise below
                }
            }

            // Finalise: save review with all accumulated data
            awaitingReviewText.delete(userId);
            const { saveReview: saveReviewFn, getAppSettings: getAppSettingsFn } = require('../services/database');
            const reviewSettings = await getAppSettingsFn();

            await saveReviewFn({
                user_id: userId,
                username: ctx.from.username || '?',
                first_name: ctx.from.first_name || 'Anonyme',
                text: data.text || "(Avis sans texte)",
                rating: parseInt(data.rate),
                photos: data.photos || [],
                is_public: true
            });

            const stars = '⭐'.repeat(data.rate);
            const mediaCount = (data.photos || []).length;
            const adminMsg = `🌟 <b>NOUVEL AVIS GÉNÉRAL !</b>\n\n👤 Client : ${ctx.from.first_name}\n🌟 Note : ${stars}\n💬 Commentaire : ${data.text || '(Sans commentaire)'}${mediaCount > 0 ? `\n🖼 ${mediaCount} média(s) joint(s)` : ''}`;
            await notifyAdmins(bot, adminMsg);

            await safeEdit(ctx, reviewSettings.msg_review_thanks || '✅ <b>Merci !</b> Votre avis a été publié anonymement. 🏮', {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([[Markup.button.callback(reviewSettings.btn_back_menu || '◀️ Retour Menu', 'main_menu')]])
            });
            return;
        }

        // --- FONCTION DE RELAYAGE SÉCURISÉE ---
        const safeHtml = (str) => String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        // 2. Retard Livreur
        try {
            if (awaitingDelayReason.has(userId)) {
                const orderId = awaitingDelayReason.get(userId);
                awaitingDelayReason.delete(userId);
                const order = await getOrder(orderId);
                if (order) {
                    const count = (parseInt(order.chat_count) || 0);
                    if (count >= 6) {
                        await ctx.reply("❌ Impossible d'envoyer : Limite de 6 échanges déjà atteinte.");
                    } else {
                        const reason = String(ctx.message.text || '');
                        // On ne compte plus le signalement de retard comme un message de chat (notification système)
                        const shortId = String(orderId).slice(-5);

                        const targetId = String(order.user_id);
                        await sendTelegramMessage(targetId,
                            `⚠️ <b>Un retard est à prévoir</b>\n\nVotre livreur nous signale un imprévu :\n"<i>${safeHtml(reason)}</i>"\n\nIl fait le maximum pour arriver vite !${count >= 6 ? '\n\n<i>(Limite d\'échanges atteinte)</i>' : ''}`,
                            {
                                ...Markup.inlineKeyboard([
                                    ...(count < 6 ? [[Markup.button.callback(`💬 Répondre (Tour ${count + 1}/6)`, `chat_livreur_${orderId}`)]] : []),
                                    [Markup.button.callback('❓ Aide & Support', 'help_menu')],
                                    [Markup.button.callback('❌ Annuler ma commande', `cancel_order_client_${orderId}`)]
                                ])
                            }
                        ).catch(err => {
                            console.error(`❌ Send delay report failed to ${targetId}:`, err.message);
                            throw err;
                        });

                        // Alerte aux admins via service central
                        const alertMsg = `⚠️ <b>SIGNALEMENT RETARD</b>\n\n🆔 Commande : <code>#${shortId}</code>\n👤 Livreur : ${safeHtml(ctx.from.first_name)}\n📝 Motif : "<i>${safeHtml(reason)}</i>"`;
                        await notifyAdmins(bot, alertMsg);

                        await ctx.reply(`✅ Notification de retard envoyée au client.`).catch(() => { });
                    }
                }
                return;
            }
        } catch (errDelay) {
            console.error("❌ CRITICAL DELAY RELAY ERROR:", errDelay);
            await ctx.reply(`⚠️ Échec de l'envoi du retard : ${errDelay.message || 'Erreur inconnue'}.`).catch(() => { });
            return;
        }

        // --- DISCUSSION CLIENT <> LIVREUR ---
        try {
            if (awaitingChatReply.has(userId)) {
                const chatData = awaitingChatReply.get(userId);
                awaitingChatReply.delete(userId);
                const orderId = chatData.orderId;
                const order = await getOrder(orderId);
                if (order) {
                    // SÉCURITÉ : Vérifier si la commande est toujours en cours
                    if (order.status !== 'taken') {
                        return await ctx.reply("❌ Cette commande est terminée ou annulée. La discussion est fermée.").catch(() => { });
                    }

                    const reply = String(ctx.message.text || '');
                    const newCount = await incrementChatCount(orderId);
                    const shortId = String(orderId).slice(-5);

                    // Qui envoie à qui ?
                    const isLivreur = userId === order.livreur_id;
                    const targetIdRaw = isLivreur ? order.user_id : order.livreur_id;

                    if (!targetIdRaw) {
                        return await ctx.reply("❌ Impossible de trouver le destinataire (Livreur ou Client non assigné).").catch(() => { });
                    }

                    const targetId = String(targetIdRaw);
                    const roleLabel = isLivreur ? "livreur" : "client";
                    const targetLabelText = isLivreur ? "le livreur" : "au client"; // Inversé pour la logique de bouton

                    const chatMsg = await sendTelegramMessage(targetId,
                        `💬 <b>Message du ${roleLabel} (Commande #${shortId})</b>\n\n"<i>${safeHtml(reply)}</i>"\n\n` +
                        `📊 <i>Message ${newCount}/6</i>${newCount >= 6 ? '\n⚠️ <b>Dernier échange consommé.</b>' : ''}`,
                        {
                            ...Markup.inlineKeyboard([
                                ...(newCount < 6 ? [[Markup.button.callback(`💬 Répondre (Tour ${newCount + 1}/6)`, `chat_livreur_${orderId}`)]] : []),
                                [Markup.button.callback('◀️ Menu', isLivreur ? 'livreur_menu' : 'main_menu')]
                            ])
                        }
                    );
                    if (chatMsg) addMessageToTrack(targetId, chatMsg.message_id).catch(() => { });

                    // Alerte aux admins via service central
                    const alertMsg = `💬 <b>CHAT ${roleLabel.toUpperCase()}</b>\n\n🆔 Commande : <code>#${shortId}</code>\n👤 De : ${safeHtml(ctx.from.first_name)}\n📝 Message : "<i>${safeHtml(reply)}</i>"`;
                    await notifyAdmins(bot, alertMsg);

                    const targetRoleLabel = isLivreur ? "client" : "livreur";
                    const successIcon = settings ? (settings.ui_icon_success || '✅') : '✅';
                    await ctx.reply(`${successIcon} Message ${newCount}/6 transmis au ${targetRoleLabel}.`).catch(() => { });
                } else {
                    await ctx.reply("❌ Commande introuvable pour ce chat.").catch(() => { });
                }
                return;
            }
        } catch (errChat) {
            console.error("❌ CRITICAL CHAT RELAY ERROR:", errChat);
            await ctx.reply(`⚠️ Échec de l'envoi : ${errChat.message || 'Erreur inconnue'}.`).catch(() => { });
            return;
        }

        await next();
    });

    bot.action('livreur_menu', async (ctx) => {
        await ctx.answerCbQuery();
        // Nettoyage des états en attente pour éviter les motifs fantômes
        const uid = `${ctx.platform}_${ctx.from.id}`;
        awaitingDelayReason.delete(uid);
        awaitingChatReply.delete(uid);

        const settings = ctx.state?.settings || await getAppSettings();
        const user = await getUser(`${ctx.platform}_${ctx.from.id}`);
        if (!user || !user.is_livreur) return safeEdit(ctx, settings.msg_access_denied || '❌ Accès refusé.', Markup.inlineKeyboard([[Markup.button.callback(settings.btn_back_quick_menu || '◀️ Menu', 'main_menu')]]));

        const { getLivreurMenuKeyboard } = require('./start');
        const city = user.current_city || user.data?.current_city || 'Non défini';
        const isAvail = user.is_available || user.data?.is_available;

        const { getLivreurOrders } = require('../services/database');
        const activeOrders = await getLivreurOrders(`${ctx.platform}_${ctx.from.id}`);

        let text = `${settings.ui_icon_livreur} <b>${settings.label_livreur || 'Espace Livreur'}</b>\n\n` +
            `👤 ${user.first_name || ctx.from.first_name}\n` +
            `📍 Secteur : <b>${city.toUpperCase()}</b>\n` +
            `🔘 Statut : <b>${isAvail ? (settings.ui_icon_success || '✅') + ' DISPONIBLE' : (settings.ui_icon_error || '❌') + ' INDISPONIBLE'}</b>\n\n`;

        if (activeOrders.length > 0) {
            text += `🚨 <b>VOUS AVEZ ${activeOrders.length} COMMANDE(S) EN COURS !</b>\n\n`;
            activeOrders.forEach(o => {
                text += `📦 #${o.id.slice(-5)} - ${o.address}\n`;
            });
            text += `\n<i>Cliquez sur "Mes livraisons en cours" pour les gérer.</i>\n\n`;
        }

        text += `Que voulez-vous faire ?`;

        const opts = await getLivreurMenuKeyboard(ctx, settings, user, activeOrders.length > 0);
        await safeEdit(ctx, text, opts);
    });

    bot.action('active_deliveries', async (ctx) => {
        await ctx.answerCbQuery();
        const settings = ctx.state?.settings || await getAppSettings();
        const { getLivreurOrders } = require('../services/database');
        const orders = await getLivreurOrders(`${ctx.platform}_${ctx.from.id}`);

        if (orders.length === 0) {
            return safeEdit(ctx, settings.msg_no_active_deliveries || '📭 Aucune livraison en cours.', Markup.inlineKeyboard([[Markup.button.callback(settings.btn_back_generic || '◀️ Retour', 'livreur_menu')]]));
        }

        let text = `🚚 <b>Livraisons en cours</b>\n\nCliquez sur une livraison pour la gérer :\n`;
        const buttons = orders.map(o => [Markup.button.callback(`#${o.id.slice(-5)} - ${o.product_name} (${o.address.substring(0, 15)}...)`, `view_active_${o.id}`)]);
        buttons.push([Markup.button.callback(settings.btn_back_generic || '◀️ Retour', 'livreur_menu')]);

        await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
    });

    bot.action(/^view_active_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const settings = ctx.state?.settings || await getAppSettings();
        const orderId = ctx.match[1];
        const order = await getOrder(orderId);
        if (!order) return safeEdit(ctx, settings.msg_order_not_found || '❌ Commande non trouvée.', Markup.inlineKeyboard([[Markup.button.callback(settings.btn_back_generic || '◀️ Retour', 'main_menu')]]));

        // settings already defined above
        let detailText = `📦 <b>Détails Livraison #${orderId.slice(-5)}</b>\n\n` +
            `📍 Adresse : <code>${order.address}</code>\n` +
            `💰 À encaisser : <b>${order.total_price || 0}€</b>\n\n`;

        if (order.scheduled_at) {
            detailText = `🗓 <b>LIVRAISON PLANIFIÉE</b>\n` +
                `🕒 Prévu pour : <b>${order.scheduled_at}</b>\n\n` + detailText;
        } else {
            detailText = `🚀 <b>LIVRAISON IMMÉDIATE (ASAP)</b>\n\n` + detailText;
        }

        await safeEdit(ctx, detailText + `Utilisez les boutons ci-dessous pour avancer :`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('⏰ Arrivée -1h', `notify_${orderId}_1h`)],
                    [Markup.button.callback(settings.btn_notify_30min || '⏳ 30 min', `notify_${orderId}_30m`), Markup.button.callback(settings.btn_notify_10min || '⏳ 10 min', `notify_${orderId}_10m`)],
                    [Markup.button.callback('⚡ 5 min', `notify_${orderId}_5m`), Markup.button.callback('📍 Arrivé', `notify_${orderId}_here`)],
                    [Markup.button.callback('💬 Parler au client', `chat_livreur_${orderId}`)],
                    [Markup.button.callback(`${settings.ui_icon_success} MARQUER COMME LIVRÉE`, `finish_${orderId}`)],
                    [Markup.button.callback(settings.btn_abandon_delivery || '❌ Abandonner la livraison', `abandon_${orderId}`)],
                    [Markup.button.callback('🚩 ANNULER LA COMMANDE', `cancel_order_livreur_${orderId}`)],
                    [Markup.button.callback(settings.btn_back_generic || '◀️ Retour', 'active_deliveries')]
                ])
            }
        );
    });

    // --- COMMANDES TG ---
    bot.command('menu', async (ctx) => displayCatalog(ctx));
    bot.command('orders', async (ctx) => {
        if (ctx.callbackQuery) await ctx.answerCbQuery();
        const settings = ctx.state?.settings || await getAppSettings();
        const activeOrders = await getClientActiveOrders(`${ctx.platform}_${ctx.from.id}`);
        if (activeOrders.length === 0) return safeEdit(ctx, settings.msg_no_active_orders || '📭 Vous n\'avez aucune commande active.', Markup.inlineKeyboard([[Markup.button.callback(settings.btn_back_generic || '◀️ Retour', 'main_menu')]]));
        const buttons = activeOrders.map(o => [Markup.button.callback(`📦 Commande #${o.id.slice(-5)} (${o.status})`, `view_order_${o.id}`)]);
        buttons.push([Markup.button.callback(settings.btn_back_generic || '◀️ Retour', 'main_menu')]);
        await safeEdit(ctx, '🔔 <b>Vos commandes actives :</b>', Markup.inlineKeyboard(buttons));
    });

    bot.command('help', async (ctx) => showHelpMenu(ctx));

    async function showHelpMenu(ctx) {
        try {
            if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => { });
            const settings = await getAppSettings();
            const activeOrders = await getClientActiveOrders(`${ctx.platform}_${ctx.from.id}`);

            let text = `<b>${settings.label_help || 'Aide & Support'}</b>\n\n` +
                `${settings.msg_help_intro || 'Besoin d\'aide ? Choisissez une option ci-dessous :'}`;

            const buttons = [];
            if (activeOrders.length > 0) {
                buttons.push([Markup.button.callback(settings.btn_where_is_delivery || '⏳ Où en est ma livraison ?', 'help_where_is_my_order')]);
            }

            buttons.push([Markup.button.callback('📞 Parler à l\'Admin', 'help_chat_admin')]);
            buttons.push([Markup.button.callback(settings.btn_back_quick_menu || '◀️ Retour Menu', 'main_menu')]);

            await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
        } catch (e) {
            console.error('❌ Error in showHelpMenu:', e);
            throw e;
        }
    }

    bot.action('help_menu', async (ctx) => {
        await showHelpMenu(ctx);
    });

    bot.action('help_where_is_my_order', async (ctx) => {
        await ctx.answerCbQuery();
        const orders = await getClientActiveOrders(`${ctx.platform}_${ctx.from.id}`);
        if (orders.length === 0) {
            return safeEdit(ctx, "📭 <b>Vous n'avez pas de commande en cours.</b>\n\nSi vous venez de commander, attendez que l'admin valide votre commande.",
                Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'help_menu')]])
            );
        }

        const latest = orders[0];
        const shortId = latest.id.slice(-5);
        const { logHelpRequest } = require('../services/database');
        await logHelpRequest(latest.id, 'WHERE_IS_MY_ORDER', 'Le client demande où est sa commande.');

        if (latest.livreur_id) {
            await sendTelegramMessage(latest.livreur_id,
                `❓ <b>DEMANDE CLIENT (ID #${shortId})</b>\n\nLe client demande où vous en êtes pour sa livraison.\nMerci de lui envoyer une estimation ASAP via le menu livreur !`
            );
        }

        const settings = await getAppSettings();
        await notifyAdmins(bot, `❓ <b>DEMANDE "OÙ EST MA COMMANDE"</b>\n\n🆔 ID : <code>#${shortId}</code>\n👤 Client : ${ctx.from.first_name}`);

        await safeEdit(ctx, `✅ <b>Votre demande a été transmise !</b>\n\nLe livreur (ID #${shortId}) a été notifié de votre attente. Il reviendra vers vous très vite par message.`,
            Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'help_menu')]])
        );
    });

    // Note: help_chat_admin est géré par handlers/admin.js pour éviter les duplications

    bot.action('user_chat_reply_admin', async (ctx) => {
        await ctx.answerCbQuery();
        awaitingUserSupportReply.set(`${ctx.platform}_${ctx.from.id}`, true);
        return ctx.reply(`💬 <b>Réponse à l'administration</b>\n\nEnvoyez votre message maintenant (texte, photo ou vidéo) :`, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([[Markup.button.callback('❌ Annuler', 'cancel_user_support')]])
        });
    });

    bot.action('cancel_user_support', async (ctx) => {
        awaitingUserSupportReply.delete(`${ctx.platform}_${ctx.from.id}`);
        await ctx.answerCbQuery('Annulé');
        return showHelpMenu(ctx);
    });


    // Mode client pour les livreurs
    bot.action('client_menu', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const { getMainMenuKeyboard } = require('./start');

            // Récupérer explicitement les settings et user
            const { getUser, getAppSettings } = require('../services/database');
            const userId = `${ctx.platform}_${ctx.from.id}`;
            clearActiveMediaGroup(userId); // Quitter le contexte produit
            const [user, settings] = await Promise.all([
                getUser(userId),
                getAppSettings()
            ]);
            
            const keyboard = await getMainMenuKeyboard(ctx, settings, user);
            
            await safeEdit(ctx,
                `🛒 <b>Mode Client</b>\n\nVous pouvez commander comme un client normal :`,
                {
                    parse_mode: 'HTML',
                    ...keyboard
                }
            );
        } catch (error) {
            console.error('❌ Erreur client_menu:', error);
            await ctx.answerCbQuery('Erreur, réessayez', { show_alert: true }).catch(() => {});
        }
    });

    bot.action('my_deliveries', async (ctx) => {
        await ctx.answerCbQuery();
        const settings = ctx.state?.settings || await getAppSettings();
        const userId = `${ctx.platform}_${ctx.from.id}`;
        const { getLivreurHistory } = require('../services/database');

        try {
            console.log(`[LIVREUR] Historique pour: ${userId}`);
            const deliveries = await getLivreurHistory(userId);
            console.log(`[LIVREUR] ${deliveries.length} livraisons trouvées.`);

            if (deliveries.length === 0) {
                return safeEdit(ctx, settings.msg_empty_delivery_history || `📭 Votre historique de livraison est vide.`, Markup.inlineKeyboard([[Markup.button.callback(settings.btn_back_generic || '◀️ Retour', 'livreur_menu')]]));
            }

            let text = `📊 <b>Mon historique de livraisons</b>\n\n`;
            let totalEarned = 0;

            deliveries.forEach((d, i) => {
                // Parsing date Supabase simple
                const dateStr = d.created_at ? new Date(d.created_at).toLocaleDateString('fr-FR') : 'Date inconnue';
                text += `${i + 1}. #${d.id.slice(-5)} - ${d.product_name} (${d.total_price}€)\n` +
                    `📅 ${dateStr} - 📍 ${(d.address || 'N/A').substring(0, 20)}...\n\n`;
                totalEarned += parseFloat(d.total_price);
            });

            text += `💰 <b>Total cumulé livré : ${totalEarned.toFixed(2)}€</b>`;

            await safeEdit(ctx, text, Markup.inlineKeyboard([[Markup.button.callback(settings.btn_back_generic || '◀️ Retour', 'livreur_menu')]]));
        } catch (e) {
            console.error('Error fetching delivery history:', e);
            await safeEdit(ctx, '❌ Erreur lors de la récupération de l\'historique.', Markup.inlineKeyboard([[Markup.button.callback(settings.btn_back_generic || '◀️ Retour', 'livreur_menu')]]));
        }
    });

    bot.on('text', async (ctx, next) => {
        if (ctx.state.awaiting_city) {
            const city = ctx.message.text.trim().toLowerCase();
            const docId = `${ctx.platform}_${ctx.from.id}`;
            const { updateLivreurPosition } = require('../services/database');

            await updateLivreurPosition(docId, city);

            // Nettoyage input
            await ctx.deleteMessage().catch(() => { });

            const settings = (ctx.state?.settings || await getAppSettings());
            const user = await getUser(docId);
            const { getLivreurMenuKeyboard: getKB } = require('./start');

            const text = `✅ <b>Secteur validé : ${city.toUpperCase()}</b>\n\n` +
                `${settings.ui_icon_livreur} <b>${settings.label_livreur_space}</b>\n\n` +
                `📍 Secteur : <b>${user.current_city ? user.current_city.toUpperCase() : city.toUpperCase()}</b>\n` +
                `🔘 Statut : <b>${user.is_available ? settings.ui_icon_success + ' DISPONIBLE' : settings.ui_icon_error + ' INDISPONIBLE'}</b>`;

            await safeEdit(ctx, text, await getKB(ctx, settings, user));
            delete ctx.state.awaiting_city;
            return;
        }
        await next();
    });

    bot.on('message', async (ctx, next) => {
        // Abandoned cart activity update
        const userId = `${ctx.platform}_${ctx.from.id}`;
        if (userCarts.has(userId)) {
            userLastActivity.set(userId, Date.now());
        }
        return next();
    });
 
    bot.action('set_dispo_true', async (ctx) => {
        await ctx.answerCbQuery("✅ Vous êtes maintenant DISPONIBLE !");
        const docId = `${ctx.platform}_${ctx.from.id}`;
        const { setLivreurAvailability, getUser, getAppSettings } = require('../services/database');
        await setLivreurAvailability(docId, true);
        const { getMainMenuKeyboard } = require('./start');
        const settings = await getAppSettings();
        const user = await getUser(docId);
        const keyboard = await getMainMenuKeyboard(ctx, settings, user);
        await safeEdit(ctx, `🔘 Statut mis à jour : <b>DISPONIBLE ✅</b>`, { parse_mode: 'HTML', ...keyboard });
    });

    bot.action('set_dispo_false', async (ctx) => {
        await ctx.answerCbQuery("❌ Vous êtes maintenant INDISPONIBLE.");
        const docId = `${ctx.platform}_${ctx.from.id}`;
        const { setLivreurAvailability, getUser, getAppSettings } = require('../services/database');
        await setLivreurAvailability(docId, false);
        const { getMainMenuKeyboard } = require('./start');
        const settings = await getAppSettings();
        const user = await getUser(docId);
        const keyboard = await getMainMenuKeyboard(ctx, settings, user);
        await safeEdit(ctx, `🔘 Statut mis à jour : <b>INDISPONIBLE ❌</b>`, { parse_mode: 'HTML', ...keyboard });
    });

    // ========== SYSTEME FOURNISSEUR ==========

    bot.action('supplier_menu', async (ctx) => {
        await ctx.answerCbQuery();
        const settings = ctx.state?.settings || await getAppSettings();
        const supplier = await getSupplierByTelegramId(String(ctx.from.id));
        if (!supplier) return safeEdit(ctx, '❌ Vous n\'êtes pas enregistré comme fournisseur.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu', 'main_menu')]]));

        const products = await getSupplierProducts(supplier.id);
        const orders = await getSupplierOrders(supplier.id, 5);
        const pendingCount = orders.filter(o => o.status === 'pending' || o.status === 'accepted').length;

        let text = `🏪 <b>Espace Fournisseur</b>\n\n`;
        text += `👤 ${supplier.name}\n`;
        text += `📦 ${products.length} produit(s) assigné(s)\n`;
        if (pendingCount > 0) text += `🔔 <b>${pendingCount} commande(s) en attente !</b>\n`;

        await safeEdit(ctx, text, Markup.inlineKeyboard([
            [Markup.button.callback('🏪 Mon Magasin (Marketplace)', 'mp_my_shop')],
            [Markup.button.callback('📋 Commandes en cours', 'supplier_orders')],
            [Markup.button.callback('📦 Mes produits assignés', 'supplier_products')],
            [Markup.button.callback(settings.btn_supplier_my_sales || '📊 Mes ventes', 'supplier_sales')],
            [Markup.button.callback('❓ Comment ça marche ?', 'supplier_guide')],
            [Markup.button.callback(settings.btn_back_menu || '◀️ Retour Menu', 'main_menu')]
        ]));
    });

    bot.action('supplier_guide', async (ctx) => {
        await ctx.answerCbQuery();
        const text = `📘 <b>Guide Fournisseur</b>\n\n` +
            `Voici comment gérer votre activité sur le bot :\n\n` +
            `1️⃣ <b>Commandes :</b> Dès qu'un client commande un de vos produits, vous recevez une notification ici.\n\n` +
            `2️⃣ <b>Préparation :</b> Allez dans "Commandes en cours" pour voir les détails. Cliquez sur <b>"Prêt ✅"</b> dès que le produit est prêt à être récupéré.\n\n` +
            `3️⃣ <b>Ventes & Revenus :</b> Consultez "Mes ventes" pour voir votre chiffre d'affaires total et vos commissions accumulées.\n\n` +
            `4️⃣ <b>Produits :</b> Vérifiez la liste de vos produits assignés dans "Mes produits".\n\n` +
            `<i>Besoin d'aide ? Contactez l'administrateur.</i>`;

        await safeEdit(ctx, text, Markup.inlineKeyboard([
            [Markup.button.callback('◀️ Retour Espace Fournisseur', 'supplier_menu')]
        ]));
    });

    bot.action('supplier_orders', async (ctx) => {
        await ctx.answerCbQuery();
        const settings = ctx.state?.settings || await getAppSettings();
        const supplier = await getSupplierByTelegramId(String(ctx.from.id));
        if (!supplier) return safeEdit(ctx, '❌ Accès refusé.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu', 'main_menu')]]));

        const orders = await getSupplierOrders(supplier.id, 20);
        const pending = orders.filter(o => ['pending', 'accepted'].includes(o.status));

        if (pending.length === 0) {
            return safeEdit(ctx, '📭 Aucune commande en attente.', Markup.inlineKeyboard([
                [Markup.button.callback('◀️ Retour', 'supplier_menu')]
            ]));
        }

        let text = `📋 <b>Commandes en cours (${pending.length})</b>\n\n`;
        pending.forEach((o, i) => {
            const items = o.items_text || o.product_list || 'Produit';
            text += `${i+1}. 📦 #${o.id.slice(-5)} - ${items}\n`;
            text += `   📍 ${o.address || '?'} | 💰 ${o.total_price || '?'}€\n`;
            text += `   ${o.supplier_ready_at ? '✅ Prêt' : '⏳ En préparation'}\n\n`;
        });

        const buttons = pending.filter(o => !o.supplier_ready_at).map(o =>
            [Markup.button.callback(`✅ Prêt #${o.id.slice(-5)}`, `supplier_ready_${o.id}`)]
        );
        buttons.push([Markup.button.callback('◀️ Retour', 'supplier_menu')]);

        await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
    });

    bot.action(/^supplier_ready_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery('✅ Marqué comme prêt !');
        const orderId = ctx.match[1];
        await markOrderSupplierReady(orderId);

        await notifyAdmins(bot, `🏪 <b>Fournisseur : produit prêt !</b>\n\nCommande #${orderId.slice(-5)} marquée comme prête par le fournisseur.`);

        const supplier = await getSupplierByTelegramId(String(ctx.from.id));
        const orders = await getSupplierOrders(supplier.id, 20);
        const pending = orders.filter(o => ['pending', 'accepted'].includes(o.status));

        if (pending.length === 0) {
            return safeEdit(ctx, '✅ Toutes les commandes sont prêtes !', Markup.inlineKeyboard([
                [Markup.button.callback('◀️ Retour', 'supplier_menu')]
            ]));
        }

        let text = `📋 <b>Commandes en cours (${pending.length})</b>\n\n`;
        pending.forEach((o, i) => {
            const items = o.items_text || o.product_list || 'Produit';
            text += `${i+1}. 📦 #${o.id.slice(-5)} - ${items}\n`;
            text += `   ${o.supplier_ready_at ? '✅ Prêt' : '⏳ En préparation'}\n\n`;
        });

        const buttons = pending.filter(o => !o.supplier_ready_at).map(o =>
            [Markup.button.callback(`✅ Prêt #${o.id.slice(-5)}`, `supplier_ready_${o.id}`)]
        );
        buttons.push([Markup.button.callback('◀️ Retour', 'supplier_menu')]);
        await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
    });

    bot.action('supplier_products', async (ctx) => {
        await ctx.answerCbQuery();
        const supplier = await getSupplierByTelegramId(String(ctx.from.id));
        if (!supplier) return safeEdit(ctx, '❌ Accès refusé.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu', 'main_menu')]]));

        const products = await getSupplierProducts(supplier.id);
        if (products.length === 0) {
            return safeEdit(ctx, '📭 Aucun produit ne vous est assigné pour le moment.', Markup.inlineKeyboard([
                [Markup.button.callback('◀️ Retour', 'supplier_menu')]
            ]));
        }

        let text = `📦 <b>Mes produits (${products.length})</b>\n\n`;
        products.forEach((p, i) => {
            text += `${i+1}. ${p.name} - ${p.price}€\n`;
            text += `   ${p.is_available ? '✅ En vente' : '❌ Indisponible'}\n`;
        });

        await safeEdit(ctx, text, Markup.inlineKeyboard([
            [Markup.button.callback('◀️ Retour', 'supplier_menu')]
        ]));
    });

    bot.action('supplier_sales', async (ctx) => {
        await ctx.answerCbQuery();
        const supplier = await getSupplierByTelegramId(String(ctx.from.id));
        if (!supplier) return safeEdit(ctx, '❌ Accès refusé.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu', 'main_menu')]]));

        const orders = await getSupplierOrders(supplier.id, 100);
        const delivered = orders.filter(o => o.status === 'delivered');
        const totalRevenue = delivered.reduce((sum, o) => sum + (parseFloat(o.total_price) || 0), 0);
        const commission = supplier.commission_pct ? (totalRevenue * supplier.commission_pct / 100) : 0;

        let text = `📊 <b>Statistiques Fournisseur</b>\n\n`;
        text += `📦 Total commandes : ${orders.length}\n`;
        text += `✅ Livrées : ${delivered.length}\n`;
        text += `💰 Chiffre d'affaires : ${totalRevenue.toFixed(2)}€\n`;
        if (supplier.commission_pct) {
            text += `📈 Commission (${supplier.commission_pct}%) : ${commission.toFixed(2)}€\n`;
        }

        await safeEdit(ctx, text, Markup.inlineKeyboard([
            [Markup.button.callback('◀️ Retour', 'supplier_menu')]
        ]));
    });
}

/**
 * Vérifie les paniers abandonnés depuis plus de 30 minutes
 */
async function checkAbandonedCarts(bot) {
    const { Markup } = require('telegraf');
    const now = Date.now();
    const TIMEOUT = 30 * 60 * 1000; // 30 minutes

    for (const [userId, lastTime] of userLastActivity.entries()) {
        const cart = userCarts.get(userId);
        if (cart && cart.length > 0 && (now - lastTime) > TIMEOUT) {
            try {
                const settings = await require('../services/database').getAppSettings();
                if (settings.enable_abandoned_cart_notifications === false || settings.enable_abandoned_cart_notifications === 'false') {
                    continue;
                }

                const defaultMsg = `🛒 <b>Votre panier vous attend !</b>\n\n` +
                    `Il reste encore <b>${cart.length} article(s)</b> dans votre panier chez <b>${settings.bot_name}</b>.\n\n` +
                    `Ne manquez pas nos pépites du moment ! 🔥`;

                const msg = settings.msg_abandoned_cart || defaultMsg;

                await sendTelegramMessage(userId, msg, {
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('💳 Voir mon panier / Commander', 'view_cart')],
                        [Markup.button.callback('🛍️ Retour au Catalogue', 'view_catalog')]
                    ])
                });
                // On marque comme notifié en reculant le temps ou en supprimant l'activité (pour ne pas spammer)
                userLastActivity.delete(userId);
            } catch (e) {
                console.error(`[ABANDONED-CART] Error notifying ${userId}:`, e);
            }
        }
    }
}

module.exports = {
    setupOrderSystem,
    initOrderState,
    userCarts,
    pendingOrders,
    awaitingAddressDetails,
    pendingOrderConfirmation,
    awaitingDelayReason,
    awaitingChatReply,
    checkAbandonedCarts,
    userLastActivity
};
