-- 🚀 MIGRATION: ADD VERIFICATION CHANNELS
ALTER TABLE bot_settings 
ADD COLUMN IF NOT EXISTS verification_channels JSONB DEFAULT '[
    {"label": "Canal 1", "url": "https://t.me/+qTYatGLmccpkZmRk"},
    {"label": "Canal 2", "url": "https://t.me/leplug_idf"}
]';

-- Recharger le cache
NOTIFY pgrst, 'reload schema';
