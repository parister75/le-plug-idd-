-- 🚀 MIGRATION : AJOUT DES COLONNES DE RECHERCHE (HASH/NORMALIZED)
-- Permet de retrouver les utilisateurs par nom/username sans déchiffrement massif

ALTER TABLE bot_users 
ADD COLUMN IF NOT EXISTS first_name_hash TEXT,
ADD COLUMN IF NOT EXISTS username_hash TEXT;

-- Indexer pour la performance des recherches
CREATE INDEX IF NOT EXISTS idx_bot_users_first_name_hash ON bot_users(first_name_hash);
CREATE INDEX IF NOT EXISTS idx_bot_users_username_hash ON bot_users(username_hash);

-- Optionnel: Remplir les colonnes pour les utilisateurs existants (nécessite déchiffrement, peut être fait via script JS)
