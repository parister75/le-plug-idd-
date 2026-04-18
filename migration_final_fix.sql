-- COMBINED MIGRATION: CUSTOM LINKS + MARKETPLACE FIXES
-- Applied to support unlimited custom links and fix product display errors

-- 1. BOT SETTINGS: Add custom_links column
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS custom_links TEXT DEFAULT '[]';

-- 2. MARKETPLACE: Fix missing columns in supplier_marketplace
ALTER TABLE supplier_marketplace ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE supplier_marketplace ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE supplier_marketplace ADD COLUMN IF NOT EXISTS is_validated BOOLEAN DEFAULT FALSE;
ALTER TABLE supplier_marketplace ADD COLUMN IF NOT EXISTS unit VARCHAR(20) DEFAULT 'unit';
ALTER TABLE supplier_marketplace ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 0;
ALTER TABLE supplier_marketplace ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

-- Update description for clarification
COMMENT ON COLUMN bot_settings.custom_links IS 'JSON array of custom social/contact links [{icon, label, url}]';
