-- 🚀 MIGRATION SQL FOR LE PLUG IDF
-- Copiez et collez ce code dans l'éditeur SQL de votre Dashboard Supabase

-- 1. Ajout de la colonne priority dans bot_products
ALTER TABLE bot_products ADD COLUMN IF NOT EXISTS priority INT DEFAULT 0;

-- 2. Ajout des colonnes manquantes dans bot_orders
ALTER TABLE bot_orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE bot_orders ADD COLUMN IF NOT EXISTS is_priority BOOLEAN DEFAULT FALSE;

-- 3. Mise à jour des réglages pour s'assurer que le rebranding est forcé
UPDATE bot_settings SET dashboard_title = 'LE PLUG IDF', bot_name = 'LE PLUG IDF' WHERE id = 'default';

-- Fin de la migration
