import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import pino from 'pino';

const AUTH_DIR = 'session-test';

(async () => {
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const sock = makeWASocket({
        auth: {
            creds: state.creds,
            keys: state.keys
        },
        logger: pino({ level: 'info' })
    });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', ({ connection, qr, lastDisconnect }) => {
        if (qr) {
            console.log('Scan this QR code:');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed.', shouldReconnect ? 'Reconnecting...' : 'Logged out.');
            if (shouldReconnect) setTimeout(() => process.exit(1), 1000);
        }
        if (connection === 'open') {
            console.log('WhatsApp connection opened! Authenticated!');
            process.exit(0);
        }
    });
})();
