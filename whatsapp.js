// whatsapp_new.js - Stable WhatsApp Connection Handler
import { makeWASocket, DisconnectReason, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, Browsers } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { qrToDataURL } from './browserQr.js';
import fs from 'fs';
import path from 'path';
import Order from './models/Order.js';
import Service from './models/Service.js';
import SmsSetting from './models/SmsSetting.js';
import QuickReply from './models/QuickReply.js';
import Help from './models/Help.js';
import { hasOrderableServices, getServiceBreadcrumb } from './serviceUtils.js';
import { getActiveCurrency } from './currencyUtils.js';
import { sendSMS } from './smsNotify.js';
import * as mtnMomo from './mtnMomo.js';

// Global state
const userStates = new Map();
let sock = null;
let isConnecting = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;
const AUTH_DIR = 'session';
let connectionState = 'closed'; // Track connection state manually

// Simple logger to avoid Baileys logger issues
const logger = {
    info: (msg) => console.log(`[INFO] ${msg}`),
    error: (msg) => console.error(`[ERROR] ${msg}`),
    warn: (msg) => console.warn(`[WARN] ${msg}`),
    debug: () => {}, // Disable debug logs
    trace: () => {}, // Disable trace logs
    child: () => logger,
    level: 'error'
};

// Ensure auth directory exists
const ensureAuthDir = () => {
    try {
        if (!fs.existsSync(AUTH_DIR)) {
            fs.mkdirSync(AUTH_DIR, { recursive: true });
            console.log('Created session directory');
        }
        return true;
    } catch (error) {
        console.error('Error creating session directory:', error);
        return false;
    }
};

// Safe message sending with connection checks and retry logic
const safeSendMessage = async (jid, content, retries = 3) => {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            // Check if socket exists and is authenticated
            if (!sock || !sock.user) {
                console.log(`Socket not ready (attempt ${attempt}/${retries})`);
                if (attempt < retries) {
                    await delay(1000 * attempt); // Progressive delay
                    continue;
                }
                return null;
            }
            
            // Check connection state using our tracked state
            if (connectionState !== 'open') {
                console.log(`Connection not open (attempt ${attempt}/${retries}), state: ${connectionState}`);
                if (attempt < retries) {
                    await delay(1000 * attempt); // Progressive delay
                    continue;
                }
                return null;
            }
            
            // Try to send the message
            const result = await sock.sendMessage(jid, content);
            if (attempt > 1) {
                console.log(`Message sent successfully on attempt ${attempt}`);
            }
            return result;
            
        } catch (error) {
            console.error(`Error sending message (attempt ${attempt}/${retries}):`, error.message);
            if (attempt < retries) {
                await delay(1000 * attempt); // Progressive delay before retry
            }
        }
    }
    
    console.error(`Failed to send message after ${retries} attempts`);
    return null;
};

// --- Refactored Message Handling Logic ---

async function showMainMenu(chatId, message = 'Welcome to Fx Cobra X! 🤖') {
    const currency = await getActiveCurrency();
    const services = await Service.find({ parentId: null });
    const serviceList = services.map((s, i) => {
        const priceString = s.price > 0 ? ` - ${currency.symbol}${s.price.toFixed(2)}` : '';
        return `*${i + 1}.* ${s.name}${priceString}`;
    }).join('\n');

    const fullMessage = `${message}\n\nHere are our main services. Reply with the number of your choice:\n\n${serviceList}\n\n--------------------\n_Type *help* for more options._`;
    await safeSendMessage(chatId, { text: fullMessage });
    userStates.set(chatId, { step: 'service_selection', services, navStack: [] });
}

async function handleBackNavigation(chatId, state) {
    const navStack = state.navStack || [];
    if (navStack.length > 0) {
        const prevState = navStack.pop(); // Get the last state
        userStates.set(chatId, prevState); // Restore previous state

        const parentService = await Service.findById(prevState.services[0].parentId);
        const breadcrumb = await getServiceBreadcrumb(parentService._id);
        const servicePath = (breadcrumb && breadcrumb.length > 0) ? breadcrumb.join(' > ') : parentService.name;
        const serviceList = prevState.services.map((s, i) => `*${i + 1}.* ${s.name}`).join('\n');
        const message = `*${parentService.name}*\n\n*Select an option below:*\n\n${serviceList}\n\n*Type 'back' to return to the previous menu.*`;
        await safeSendMessage(chatId, { text: message });
    } else {
        // At the top level, show main menu
        await showMainMenu(chatId, 'You are at the main menu. Here are the services:');
    }
}

async function handleServiceSelection(chatId, state, text) {
    const choice = parseInt(text.trim());
    if (isNaN(choice) || choice <= 0 || choice > state.services.length) {
        await safeSendMessage(chatId, { text: '⚠️ *Invalid choice.* Please select a valid number from the list.' });
        return;
    }

    const selectedService = state.services[choice - 1];
    const currency = await getActiveCurrency();

    // If the selected service has a price, it's directly orderable.
    if (selectedService.price && selectedService.price > 0) {
        const confirmationMessage = `🛒 *Confirm Your Order*\n\nYou have selected *${selectedService.name}*.\nPrice: *${currency.symbol}${selectedService.price.toFixed(2)}*\n\n--------------------\nReply *'1'* to Confirm\nReply *'0'* to Go Back`;
        await safeSendMessage(chatId, { text: confirmationMessage });
        userStates.set(chatId, { step: 'order_confirmation', selectedService, navStack: state.navStack || [] });
        return;
    }

    // If it's a category (no price), find its immediate children.
    const subServices = await Service.find({ parentId: selectedService._id }).lean();

    if (subServices.length > 0) {
        // Display immediate children (subcategories or services).
        const serviceList = subServices.map((s, i) => {
            const priceString = s.price > 0 ? ` - ${currency.symbol}${s.price.toFixed(2)}` : '';
            return `*${i + 1}.* ${s.name}${priceString}`;
        }).join('\n');
        const message = `*${selectedService.name}*\n\nSelect an option below:\n\n${serviceList}\n\n--------------------\n_Type *back* to return to the previous menu._`;
        await safeSendMessage(chatId, { text: message });

        const navStack = state.navStack || [];
        navStack.push(state); // Save current state for 'back' navigation.
        userStates.set(chatId, { step: 'service_selection', services: subServices, navStack });
    } else {
        // If there are no immediate children, check if the category contains any orderable services in nested subcategories.
        const isOrderable = await hasOrderableServices(selectedService._id);
        if (isOrderable) {
            // This case should ideally not be reached if the menu is structured well, but as a fallback:
            await safeSendMessage(chatId, { text: `Please navigate further to find an orderable service.` });
        } else {
            // The category and all its subcategories are empty or contain no orderable items.
            await safeSendMessage(chatId, { text: `🤷‍♂️ *No orderable services found under '${selectedService.name}'.*` });
        }
        // Return to the previous menu or main menu to avoid getting stuck.
        await handleBackNavigation(chatId, state);
    }
}

async function handleOrderConfirmation(chatId, state, text, message) {
    const normalizedText = text.toLowerCase().trim();

    if (normalizedText === '1') {
        // --- Confirm Order ---
        const currency = await getActiveCurrency();
        const service = await Service.findById(state.selectedService._id);

        if (!service || !service.price || service.price <= 0) {
            await safeSendMessage(chatId, { text: `❌ Sorry, "${service.name}" cannot be ordered.` });
            await showMainMenu(chatId);
            return;
        }

        try {
            const order = new Order({
                userId: chatId,
                serviceId: service._id,
                serviceName: service.name, // Storing the name for easy access
                price: service.price, // Correctly using the 'price' field
                message: `Order for ${service.name}`,
                adminReplies: [{
                    message: `Order for ${service.name}`,
                    isCustomer: true,
                    timestamp: new Date()
                }]
            });
            await order.save();

            const breadcrumb = await getServiceBreadcrumb(service._id);
            const servicePath = (breadcrumb && breadcrumb.length > 0) ? breadcrumb.join(' > ') : service.name;

            await safeSendMessage(chatId, {
                text: `✅ *Order Confirmed!*\n\n*Order ID:* ${order._id.toString().slice(-8)}\n*Service:* ${servicePath}\n*Price:* ${currency.symbol}${service.price.toFixed(2)}\n*Status:* Pending\n\nOur team will be in touch shortly. You can reply to this message to add comments to your order.`
            });

            // CRITICAL: Clear the user's state after order confirmation.
            userStates.delete(chatId);
            
            // Optional SMS Notification
            try {
                const smsSettings = await SmsSetting.findOneOrCreate();
                if (smsSettings && smsSettings.apiKey && smsSettings.sender && smsSettings.recipient) {
                    const smsText = `New Order: ${service.name} (${currency.symbol}${service.price.toFixed(2)}) from ${chatId.split('@')[0]}`;
                    sendSMS(smsText, smsSettings).catch(err => console.error('[SMS] Error sending notification:', err.message));
                }
            } catch (err) {
                console.error('[SMS] Unexpected error:', err.message);
            }

        } catch (error) {
            console.error('Error creating order:', error);
            await safeSendMessage(chatId, { text: "🚨 Sorry, there was an error placing your order. Please try again." });
        }

    } else if (normalizedText === '0') {
        // --- Cancel and Go Back ---
        await handleBackNavigation(chatId, state);
    } else {
        // --- Invalid Input ---
        await safeSendMessage(chatId, { text: "⚠️ Invalid input. Please reply with *'1'* to confirm or *'0'* to go back." });
    }
}

const handleMessage = async (message) => {
    try {
        const chatId = message.key.remoteJid;

        // Ignore messages from groups
        if (chatId.endsWith('@g.us')) {
            return;
        }
        const text = message.message?.conversation || message.message?.extendedTextMessage?.text || '';

        if (!chatId || !text) {
            return;
        }

        const lowerCaseText = text.toLowerCase().trim();

        // --- Definitive Logic Flow ---

        const state = userStates.get(chatId);

        // 1. Always allow universal commands, regardless of state.
        if (lowerCaseText === 'menu' || lowerCaseText === 'start') {
            await showMainMenu(chatId);
            return;
        }
        if (lowerCaseText === 'back' || lowerCaseText === 'go back') {
            await handleBackNavigation(chatId, state);
            return;
        }
        if (lowerCaseText === 'help') {
            try {
                const help = await Help.findOneOrCreate();
                await safeSendMessage(chatId, { text: help.content });
            } catch (error) {
                console.error('Error fetching help message:', error);
                await safeSendMessage(chatId, { text: '🚨 Sorry, I could not retrieve the help message at this time.' });
            }
            return;
        }

        // 2. If the user is in a specific menu state, handle that.
        if (state) {
            switch (state.step) {
                case 'service_selection':
                    await handleServiceSelection(chatId, state, text);
                    break;
                case 'order_confirmation':
                    await handleOrderConfirmation(chatId, state, text, message);
                    break;
                default:
                    await showMainMenu(chatId, "🤔 Sorry, I got a bit lost. Let's start over from the main menu.");
                    break;
            }
            return; // End processing after state handling
        }

        // 3. If no state and no universal command, check for an active order to reply to.
        console.log(`[CONVO_CHECK] No state. Searching for active order for ${chatId}...`);
        const activeOrder = await Order.findOne({
            userId: chatId,
            status: { $in: ['pending', 'processing', 'awaiting_reply', 'confirmed'] }
        }).sort({ createdAt: -1 });

        if (activeOrder) {
            console.log(`[CONVO_CHECK] Active order found (ID: ${activeOrder._id}). Treating as reply.`);
            if (['close', 'end', 'done'].includes(lowerCaseText)) {
                await Order.findByIdAndUpdate(activeOrder._id, { $set: { status: 'pending' } });
                await safeSendMessage(chatId, { text: '✅ Conversation closed. \n Type menu to return to main menu.' });
            } else {
                await Order.findByIdAndUpdate(activeOrder._id, {
                    $push: { adminReplies: { message: text, isCustomer: true, timestamp: new Date() } },
                    $set: { status: 'awaiting_reply' }
                });
                await safeSendMessage(chatId, { text: `✅ Message received. (Type 'close' to end)` });
            }
            return; // End processing after conversation handling
        }

        // 4. If nothing else, show the main menu.
        console.log(`[CONVO_CHECK] No state and no active order. Showing main menu.`);
        await showMainMenu(chatId);
    } catch (error) {
        console.error('--- FATAL ERROR in handleMessage ---');
        console.error(error);
        const chatId = message.key.remoteJid;
        if (chatId) {
            try {
                await safeSendMessage(chatId, { text: "🚨 *Oops!* Something went wrong on our end.\nPlease type *menu* to try again." });
                userStates.delete(chatId); // Clear broken state
            } catch (sendError) {
                console.error('--- FATAL ERROR: Could not send error message to user ---');
                console.error(sendError);
            }
        }
    }
};

// Create WhatsApp connection
const createConnection = async () => {
    try {
        if (!ensureAuthDir()) {
            throw new Error('Failed to create session directory');
        }

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        
        // Create socket with minimal, stable configuration
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            logger,
            logger: pino({ level: 'info' }),
            browser: Browsers.macOS('Desktop'), // Use stable browser identifier
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            markOnlineOnConnect: false, // Reduce server load
            syncFullHistory: false, // Don't sync full history
            shouldSyncHistoryMessage: () => false, // Skip history sync
            getMessage: async () => undefined // Don't fetch old messages
        });

        // Handle credentials update
        socket.ev.on('creds.update', saveCreds);

        // Handle connection updates
        socket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr, isNewLogin } = update;
            
            if (qr) {
                console.log('Scan this QR code:');
                import('qrcode-terminal').then(qrcode => {
                    qrcode.default.generate(qr, { small: true });
                });
                // Generate PNG data URL for browser
                qrToDataURL(qr).then(dataUrl => { socket.qr = dataUrl; }).catch(() => { socket.qr = null; });
            }
            
            if (isNewLogin) {
                console.log('New login detected.');
                reconnectAttempts = 0;
            }
            
            if (connection === 'close') {
                connectionState = 'closed';
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                
                console.log(`Connection closed. Status: ${statusCode}`);
                
                if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                    reconnectAttempts++;
                    console.log(`Reconnecting... (Attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
                    
                    // Immediate reconnection without delay
                    setTimeout(() => {
                        isConnecting = false;
                        connectToWhatsApp();
                    }, 1000);
                } else {
                    console.log('Max reconnection attempts reached or logged out.');
                    reconnectAttempts = 0; // Reset for manual restart
                }
            } else if (connection === 'open') {
                connectionState = 'open';
                console.log('WhatsApp connection opened successfully!');
                reconnectAttempts = 0;
                isConnecting = false;
                // --- PATCH: Wait for socket.user before calling onSocketReady ---
                const waitForUser = async () => {
                    let tries = 0;
                    while ((!socket.user || !socket.user.id) && tries < 20) { // Wait up to 2s
                        await delay(100);
                        tries++;
                    }
                    if (socket.user && socket.user.id) {
                        console.log('[Baileys] socket.user is now set:', socket.user);
                        // Update global socket reference for admin panel
                        sock = socket;
                        // Always propagate socket to Express app
                        if (globalThis.expressApp && typeof globalThis.expressApp.set === 'function') {
                            globalThis.expressApp.set('whatsappClient', sock);
                        }
                        if (typeof globalThis.onSocketReady === 'function') {
                            console.log('[Baileys] Calling global onSocketReady after connection open (global, user ready)');
                            globalThis.onSocketReady(socket);
                        }
                        // Emit wa-authenticated event for Express app (if available)
                        if (globalThis.expressApp && typeof globalThis.expressApp.emit === 'function') {
                            globalThis.expressApp.emit('wa-authenticated', socket);
                        }
                        if (typeof socket.onSocketReady === 'function') {
                            console.log('[Baileys] Calling socket.onSocketReady after connection open (instance, user ready)');
                            socket.onSocketReady(socket);
                        }
                    } else {
                        console.warn('[Baileys] socket.user was not set after waiting. Admin panel may not authenticate.');
                    }
                };
                waitForUser();
            } else if (connection === 'connecting') {
                connectionState = 'connecting';
                console.log('WhatsApp connecting...');
            }
        });

        // Handle incoming messages
        socket.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            
            for (const message of messages) {
                if (message.key.fromMe) continue; // Skip own messages
                await handleMessage(message);
            }
        });

        // Periodic connection health check using our tracked state
        const healthCheck = setInterval(() => {
            if (connectionState !== 'open') {
                console.log(`Connection health check: state=${connectionState}`);
            }
        }, 30000); // Check every 30 seconds
        
        // Clean up health check on socket close
        socket.ev.on('connection.update', ({ connection }) => {
            if (connection === 'close') {
                clearInterval(healthCheck);
            }
        });

        return socket;
        
    } catch (error) {
        console.error('Error creating connection:', error);
        isConnecting = false;
        throw error;
    }
};

// Main connection function
// Accepts an optional callback to run after every (re)connect
// Store the latest onSocketReady callback globally for use in connection.update
export async function connectToWhatsApp(onSocketReady) {
    globalThis.onSocketReady = onSocketReady;

    if (isConnecting) {
        console.log('Connection already in progress...');
        return sock;
    }
    
    isConnecting = true;
    
    try {
        // Close existing connection if any
        if (sock) {
            try {
                sock.end();
            } catch (e) {
                // Ignore errors when closing
            }
        }
        
        sock = await createConnection();
        
        // Add safeSendMessage method to the socket for external use
        if (sock && !sock.safeSendMessage) {
            sock.safeSendMessage = safeSendMessage;
        }
        // Call the callback with the new socket if provided
        if (typeof onSocketReady === 'function') {
            onSocketReady(sock);
        }
        
        // Attach event to always call the callback on reconnect
        if (sock && sock.ev && typeof onSocketReady === 'function') {
            sock.ev.on('connection.update', () => {
                onSocketReady(sock);
            });
        }
        
        return sock;
        
    } catch (error) {
        console.error('Failed to connect to WhatsApp:', error);
        isConnecting = false;
        
        // Retry after delay if not at max attempts
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempts++;
            const delay = 10000; // 10 second delay for errors
            
            console.log(`Retrying connection in ${delay/1000} seconds... (Attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
            
            setTimeout(() => {
                connectToWhatsApp();
            }, delay);
        } else {
            console.log('Max connection attempts reached. Please restart the bot.');
            process.exit(1);
        }
        
        return null;
    }
}

// Logout function: cleanly disconnect and clear session
export async function logoutWhatsApp() {
    try {
        if (sock && sock.logout) {
            await sock.logout();
        }
        if (sock && sock.end) {
            sock.end();
        }
        sock = null;
        connectionState = 'closed';
        // Remove session folder
        if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            console.log('Session directory deleted for logout.');
        }
    } catch (err) {
        console.error('Error during WhatsApp logout:', err);
    }
}





