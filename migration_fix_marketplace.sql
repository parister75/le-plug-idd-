-- Fix missing columns in supplier_marketplace
-- Applied to resolve: column supplier_marketplace.created_at does not exist

ALTER TABLE supplier_marketplace ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE supplier_marketplace ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE supplier_marketplace ADD COLUMN IF NOT EXISTS is_validated BOOLEAN DEFAULT FALSE;
ALTER TABLE supplier_marketplace ADD COLUMN IF NOT EXISTS unit VARCHAR(20) DEFAULT 'unit';
ALTER TABLE supplier_marketplace ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 0;
ALTER TABLE supplier_marketplace ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

-- Ensure some data exists if it was empty due to errors
COMMENT ON TABLE supplier_marketplace IS 'Table containing marketplace products from external suppliers';
