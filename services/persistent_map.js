// PersistentMap - Map wrapper that persists state to Supabase bot_state table
const TABLE = 'bot_state';
const db = () => require('../config/supabase').supabase.from(TABLE);

function createPersistentMap(namespace) {
    const mem = new Map();
    let live = false;
    const rid = (k) => `${namespace}:${k}`;

    const syncToDB = async (k, val, op) => {
        try {
            const payload = op === 'SET' 
                ? { id: rid(k), namespace, user_key: k, value: JSON.parse(JSON.stringify(val)), updated_at: new Date().toISOString() }
                : null;

            if (op === 'SET') {
                const { error } = await db().upsert(payload, { onConflict: 'id' });
                if (error) console.error(`[State] ${namespace} ${op} DB Error for ${k}:`, error.message);
            } else if (op === 'DEL') {
                const { error } = await db().delete().eq('id', rid(k));
                if (error) console.error(`[State] ${namespace} ${op} DB Error for ${k}:`, error.message);
            }
        } catch (e) {
            console.error(`[State] ${namespace} ${op} Exception for ${k}:`, e.message);
        }
    };

    return {
        has: (key) => mem.has(String(key)),
        get: (key) => mem.get(String(key)),
        set(key, val) {
            const k = String(key);
            mem.set(k, val);
            syncToDB(k, val, 'SET'); // Pas besoin d'attendre l'écriture DB pour continuer le bot
            return this;
        },
        delete(key) {
            const k = String(key), had = mem.has(k);
            mem.delete(k);
            syncToDB(k, null, 'DEL');
            return had;
        },
        clear() { 
            mem.clear(); 
            db().delete().eq('namespace', namespace).then(({error}) => {
                if (error) console.error(`[State] ${namespace} CLEAR DB Error:`, error.message);
            });
        },
        keys: () => mem.keys(), 
        values: () => mem.values(), 
        entries: () => mem.entries(),
        get size() { return mem.size; },
        forEach: (cb) => mem.forEach(cb),
        [Symbol.iterator]: () => mem[Symbol.iterator](),
        async load() {
            try {
                const now = Date.now();
                // Attempt load with retry logic or at least timeout
                const { data, error } = await db()
                    .select('user_key, value')
                    .eq('namespace', namespace);
                
                if (error) { 
                    console.warn(`[State] ${namespace} load error: ${error.message}`); 
                    live = true;
                    return; 
                }
                for (const r of (data || [])) mem.set(r.user_key, r.value);
                live = true;
                if (mem.size > 0) console.log(`[State] ${namespace}: ${mem.size} entrées restaurées (${Date.now() - now}ms)`);
            } catch (e) { 
                console.error(`[State] ${namespace} Exception:`, e.message);
                live = true;
            }
        }
    };
}

module.exports = { createPersistentMap };
