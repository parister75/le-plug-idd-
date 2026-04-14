const crypto = require('crypto');
require('dotenv').config();

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 64;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const ITERATIONS = 100000;

/**
 * Récupère ou génère la clé de chiffrement à partir de la variable d'environnement
 */
function getKey(salt, iterations = ITERATIONS) {
    const masterKey = process.env.ENCRYPTION_KEY;
    if (!masterKey) {
        throw new Error('❌ ENCRYPTION_KEY manquante dans le fichier .env');
    }
    return crypto.pbkdf2Sync(masterKey, salt, iterations, KEY_LENGTH, 'sha512');
}

/**
 * Chiffre une chaîne de caractères
 * @param {string} text 
 * @returns {string} format: salt:iv:authTag:encryptedText
 */
function encrypt(text) {
    if (!text) return null;

    const salt = crypto.randomBytes(SALT_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);
    const key = getKey(salt);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const tag = cipher.getAuthTag();

    return `${salt.toString('hex')}:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
}

/**
 * Déchiffre une chaîne de caractères
 * @param {string} encryptedData 
 */
function decryptWithIterations(salt, iv, tag, encryptedText, iterations) {
    const key = getKey(salt, iterations);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

function decrypt(encryptedData) {
    if (!encryptedData || typeof encryptedData !== 'string' || !encryptedData.includes(':')) return encryptedData;

    try {
        const parts = encryptedData.split(':');
        // Un message chiffré doit avoir exactement 4 parties: salt:iv:tag:encryptedText
        if (parts.length !== 4) return encryptedData;

        const [saltHex, ivHex, tagHex, encryptedText] = parts;
        
        // Vérification basique que ce sont des chaînes hexadécimales
        if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(ivHex) || !/^[0-9a-f]+$/i.test(tagHex)) {
            return encryptedData;
        }

        const salt = Buffer.from(saltHex, 'hex');
        const iv = Buffer.from(ivHex, 'hex');
        const tag = Buffer.from(tagHex, 'hex');

        // Essai séquentiel des itérations possibles
        const iterationChoices = [ITERATIONS, 1000, 50000, 100000].filter((v, i, a) => a.indexOf(v) === i);

        for (const iters of iterationChoices) {
            try {
                return decryptWithIterations(salt, iv, tag, encryptedText, iters);
            } catch (_) {
                // On continue au prochain
            }
        }

        throw new Error('Aucune itération ne fonctionne');
    } catch (error) {
        // Si c'est une chaîne non chiffrée qui contient des deux-points par hasard, 
        // on retourne simplement la chaîne originale au lieu de loguer une erreur.
        if (error.message.includes('The first argument must be of type string') || 
            error.message.includes('Avoir itération') || 
            error.message.includes('Unsupported state')) {
            return encryptedData;
        }
        
        console.error('❌ Erreur de déchiffrement finale:', error.message);
        return encryptedData; // Retourne le texte original si erreur inattendue
    }
}

module.exports = { encrypt, decrypt };
