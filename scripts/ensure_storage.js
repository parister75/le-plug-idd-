require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

async function ensureBucket() {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY; // Must be service_role

    if (!supabaseUrl || !supabaseKey) {
        console.error('❌ Missing credentials in .env');
        return;
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    console.log('🔄 Checking Supabase Storage bucket "uploads"...');
    
    try {
        const { data: buckets, error: listError } = await supabase.storage.listBuckets();
        if (listError) throw listError;

        const exists = buckets.find(b => b.name === 'uploads');
        
        if (exists) {
            console.log('✅ Bucket "uploads" already exists.');
        } else {
            console.log('📦 Creating public bucket "uploads"...');
            const { data, error } = await supabase.storage.createBucket('uploads', {
                public: true,
                allowedMimeTypes: ['image/*', 'video/*'],
                fileSizeLimit: 52428800 // 50MB
            });

            if (error) throw error;
            console.log('✨ Bucket "uploads" created successfully!');
        }
    } catch (e) {
        console.error('❌ Failed to ensure bucket:', e.message);
        console.log('💡 Note: This requires the SERVICE_ROLE key to work.');
    }
}

ensureBucket();
