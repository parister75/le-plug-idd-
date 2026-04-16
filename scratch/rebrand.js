const fs = require('fs');
const path = require('path');

const replacements = [
    { from: /monshopbot/gi, to: 'LE PLUG IDF' },
    { from: /monshop/gi, to: 'LE PLUG IDF' },
    { from: /La Frappe/gi, to: 'LE PLUG IDF' },
    { from: /lafrappe/gi, to: 'leplugidf' },
    { from: /bot-clients-telegram/g, to: 'le-plug-idf-bot' },
    { from: /la-frappe-production-cea7\.up\.railway\.app/g, to: 'le-plug-idf.up.railway.app' }
];

const filesToProcess = [
    'index.js',
    'package.json',
    'README.md',
    'setup.sql',
    'services/database.js',
    'services/utils.js',
    'handlers/admin.js',
    'handlers/order_system.js',
    'handlers/start.js',
    'web/views/dashboard.html',
    'web/views/login.html',
    'web/views/address_picker.html'
];

filesToProcess.forEach(file => {
    const filePath = path.join(process.cwd(), file);
    if (fs.existsSync(filePath)) {
        let content = fs.readFileSync(filePath, 'utf8');
        let originalContent = content;
        
        replacements.forEach(r => {
            content = content.replace(r.from, r.to);
        });
        
        if (content !== originalContent) {
            fs.writeFileSync(filePath, content, 'utf8');
            console.log(`✅ Updated ${file}`);
        } else {
            console.log(`ℹ️ No changes for ${file}`);
        }
    } else {
        console.log(`⚠️ File not found: ${file}`);
    }
});
