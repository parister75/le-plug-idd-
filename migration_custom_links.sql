-- 🆕 MIGRATION : AJOUT DES LIENS PERSONNALISÉS ILLIMITÉS
-- Exécutez ce script dans l'éditeur SQL de Supabase

ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS custom_links TEXT DEFAULT '[]';
