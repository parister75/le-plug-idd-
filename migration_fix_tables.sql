-- 🛠 MIGRATION FIX : Ajout des colonnes manquantes et configuration du storage
-- À exécuter dans le SQL Editor de Supabase si le bot affiche des erreurs "column does not exist"

-- 1. FIX BOT_STATS (Ajout de total_referrals)
ALTER TABLE bot_stats ADD COLUMN IF NOT EXISTS total_referrals INT DEFAULT 0;

-- 2. FIX BOT_STATE (Ajout de user_key et namespace)
ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS user_key TEXT;
ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS namespace TEXT;

-- 3. FIX BOT_BROADCASTS (Ajout de start_at et colonnes de suivi)
ALTER TABLE bot_broadcasts ADD COLUMN IF NOT EXISTS start_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE bot_broadcasts ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE bot_broadcasts ADD COLUMN IF NOT EXISTS total_target INT DEFAULT 0;
ALTER TABLE bot_broadcasts ADD COLUMN IF NOT EXISTS options JSONB DEFAULT '{}';

-- 4. FIX BOT_SETTINGS (Colonnes manquantes pour le nouveau branding)
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS welcome_photo TEXT;
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS list_admins TEXT;
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS moderator_telegram_id TEXT;

-- 5. CONFIGURATION DU STORAGE
-- On s'assure que le bucket 'uploads' existe (utilisé par le code)
INSERT INTO storage.buckets (id, name, public) 
VALUES ('uploads', 'uploads', true)
ON CONFLICT (id) DO NOTHING;

-- Autoriser l'accès public en lecture et écriture au bucket uploads
CREATE POLICY "Public Access" ON storage.objects FOR SELECT USING (bucket_id = 'uploads');
CREATE POLICY "Public Insert" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'uploads');

-- 6. RÉ-INSERTION DES STATS INITIALES (Évite l'erreur d'insert si déjà présent)
INSERT INTO bot_stats (id, total_users, total_orders, total_ca, total_referrals) 
VALUES ('global', 0, 0, 0, 0)
ON CONFLICT (id) DO UPDATE SET 
  total_referrals = EXCLUDED.total_referrals 
  WHERE bot_stats.total_referrals IS NULL;
