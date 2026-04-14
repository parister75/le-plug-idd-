const { useSupabaseAuthState } = require('./services/database');
const pino = require('pino');
require('dotenv').config();

async function start() {
    const sessionId = process.env.WHATSAPPD_SESSION_ID || 'tct_0752981714';
    const phoneNumber = '+33752981714';

    console.log(`🚀 Démarrage du jumelage pour ${phoneNumber} (Session: ${sessionId})...`);

    const BaileysRaw = await import('@whiskeysockets/baileys');
    const Baileys = BaileysRaw.default || BaileysRaw;
    
    // Baileys components
    const makeWASocket = Baileys.default || Baileys.makeWASocket || BaileysRaw.makeWASocket || Baileys;
    const { state, saveCreds } = await useSupabaseAuthState(sessionId);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["Mac OS", "Safari", "17.0"]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (connection === 'close') {
            console.log('🔌 Connexion fermée. Relancez le script si nécessaire.');
            process.exit(0);
        } else if (connection === 'open') {
            console.log('✅ WhatsApp connecté avec succès !');
            process.exit(0);
        }
    });

    // Demande du code de jumelage
    if (!sock.authState.creds.registered) {
        try {
            console.log('⏳ Demande du code à WhatsApp...');
            // Petit délai pour laisser le socket se stabiliser
            setTimeout(async () => {
                const code = await sock.requestPairingCode(phoneNumber);
                console.log('\n****************************************');
                console.log(`✅ VOTRE CODE WHATSAPP : ${code}`);
                console.log('****************************************\n');
                console.log('Entrez ce code sur votre téléphone dans :');
                console.log('WhatsApp > Réglages > Appareils connectés > Connecter un appareil > Se connecter avec un numéro de téléphone.');
            }, 5000);
        } catch (err) {
            console.error('❌ Erreur lors de la demande du code :', err.message);
        }
    } else {
        console.log('ℹ️ Cet appareil est déjà enregistré.');
    }
}

start().catch(console.error);
