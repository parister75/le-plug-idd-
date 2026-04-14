const { createClient } = require('@supabase/supabase-js');
const { validateLicense } = require('../services/license');
// Environment variables are loaded in index.js

if (!validateLicense()) {
    console.error('❌ Licence invalide.');
    process.exit(1);
}

// Emergency hardcoded fallback if environment variables are missing
const supabaseUrl = process.env.SUPABASE_URL || 'https://tsafkhhyqmlknxrgnqgw.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRzYWZraGh5cW1sa254cmducWd3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjY3MDg0MCwiZXhwIjoyMDg4MjQ2ODQwfQ.1-AzrYIDY9PU-VbWRHe_KoIzlpzD6Fj3Q_nCOIOeXnQ';

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ ERREUR CRITIQUE : Identifiants Supabase absents du système.');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = { supabase };
