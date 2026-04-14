// Shared circular log buffer accessible by both WhatsAppSessionChannel and Dispatcher
const waLogs = [];

function waLog(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    waLogs.push(line);
    if (waLogs.length > 300) waLogs.shift();
    console.log(msg);
}

module.exports = { waLogs, waLog };
