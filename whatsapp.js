// whatsapp_new.js - Stable WhatsApp Connection Handler
import { makeWASocket, DisconnectReason, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, Browsers } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { qrToDataURL } from './browserQr.js';
import fs from 'fs';
import path from 'path';
import Order from './models/Order.js';
import Service from './models/Service.js';
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

async function showMainMenu(chatId, message = 'Welcome to Fx Cobra X Services! Here are our services:') {
    const currency = await getActiveCurrency();
    const services = await Service.find({ parentId: null });
    let reply = `${message}\n`;
    services.forEach((s, i) => {
        if (s.price && s.price > 0) {
            reply += `${i + 1}. ${s.name} - ${currency.symbol}${s.price.toFixed(2)}\n`;
        } else {
            reply += `${i + 1}. ${s.name}\n`;
        }
    });
    reply += 'Reply with the number of your choice.';
    await safeSendMessage(chatId, { text: reply });
    userStates.set(chatId, { step: 'service_selection', services, navStack: [] });
}

async function handleBackNavigation(chatId, state) {
    const navStack = state.navStack || [];
    if (navStack.length > 0) {
        const prevState = navStack.pop(); // Get the last state
        userStates.set(chatId, prevState); // Restore previous state

        const currency = await getActiveCurrency();
        let reply = `Going back...\n\nAvailable options:\n`;
        prevState.services.forEach((s, i) => {
            if (s.price && s.price > 0) {
                reply += `${i + 1}. ${s.name} - ${currency.symbol}${s.price.toFixed(2)}\n`;
            } else {
                reply += `${i + 1}. ${s.name} (Category)\n`;
            }
        });
        reply += 'Reply with the number of your choice or type "back" to go to the previous menu.';
        await safeSendMessage(chatId, { text: reply });
    } else {
        // At the top level, show main menu
        await showMainMenu(chatId, 'You are at the main menu. Here are the services:');
    }
}

async function handleServiceSelection(chatId, state, text) {
    const choice = parseInt(text.trim());
    if (isNaN(choice) || choice <= 0 || choice > state.services.length) {
        await safeSendMessage(chatId, { text: 'Invalid choice. Please select a valid number.' });
        return;
    }

    const selectedService = state.services[choice - 1];
    const subServices = await Service.find({ parentId: selectedService._id });
    const currency = await getActiveCurrency();

    // If the selected service has a price, it's orderable directly
    if (selectedService.price && selectedService.price > 0) {
        await safeSendMessage(chatId, {
            text: `You selected: ${selectedService.name}\nPrice: ${currency.symbol}${selectedService.price.toFixed(2)}\n\nReply with 'order' to place an order or 'menu' to go back.`
        });
        userStates.set(chatId, { step: 'order_confirmation', selectedService, navStack: state.navStack || [] });
        return;
    }

    // If it's a category, find its children
    if (subServices.length > 0) {
        const hasAnyOrderable = await hasOrderableServices(selectedService._id);
        if (hasAnyOrderable) {
            let reply = `You selected: ${selectedService.name}\n\nAvailable options:\n`;
            subServices.forEach((s, i) => {
                if (s.price && s.price > 0) {
                    reply += `${i + 1}. ${s.name} - ${currency.symbol}${s.price.toFixed(2)}\n`;
                } else {
                    reply += `${i + 1}. ${s.name} (Category)\n`;
                }
            });
            reply += 'Reply with the number of your choice or type "back".';

            const navStack = state.navStack || [];
            navStack.push(state); // Save current state for back navigation

            await safeSendMessage(chatId, { text: reply });
            userStates.set(chatId, { step: 'service_selection', services: subServices, navStack });
        } else {
            await safeSendMessage(chatId, { text: `❌ No orderable services found under "${selectedService.name}".` });
            await handleBackNavigation(chatId, state); // Go back automatically
        }
    } else {
        await safeSendMessage(chatId, { text: `❌ "${selectedService.name}" is a category with no services.` });
        await showMainMenu(chatId); // No children, show main menu
    }
}

async function handleOrderConfirmation(chatId, state, text) {
    const normalizedText = text.toLowerCase().trim();
    const currency = await getActiveCurrency();
    const service = await Service.findById(state.selectedService._id);

    if (normalizedText !== 'order') {
        await safeSendMessage(chatId, { text: `⚠️ Please type 'order' to confirm or 'menu' to cancel.` });
        return;
    }

    if (!service || !service.price || service.price <= 0) {
        await safeSendMessage(chatId, { text: `❌ Sorry, "${service.name}" cannot be ordered.` });
        userStates.delete(chatId);
        await showMainMenu(chatId);
        return;
    }

    try {
        const orderData = {
            userId: chatId,
            serviceId: service._id,
            serviceName: service.name,
            price: service.price,
            status: 'pending',
            message: `I would like to order: ${service.name} for ${currency.symbol}${service.price.toFixed(2)}`,
            adminReplies: []
        };

        let order = new Order(orderData);
        await order.save();

        const breadcrumb = await getServiceBreadcrumb(service._id);
        const servicePath = (breadcrumb && breadcrumb.length > 0) ? breadcrumb.join(' > ') : service.name;

        await safeSendMessage(chatId, {
            text: `✅ Order placed successfully!\n\n📋 Order ID: ${order._id}\n💼 Service: ${servicePath}\n💰 Price: ${currency.symbol}${service.price.toFixed(2)}\n📊 Status: Pending\n\nYou will receive updates shortly.`
        });

        // --- Optional: SMS Notification ---
        try {
            const smsText = `New Order: ${service.name} (${currency.symbol}${service.price.toFixed(2)}) from ${chatId}`;
            const smsSettingsPath = path.resolve(process.cwd(), 'smsSettings.json');
            if (fs.existsSync(smsSettingsPath)) {
                const smsConfig = JSON.parse(fs.readFileSync(smsSettingsPath, 'utf8'));
                sendSMS(smsText, smsConfig).catch(err => console.error('[SMS] Error sending notification:', err.message));
            }
        } catch (err) {
            console.error('[SMS] Unexpected error in SMS notification:', err.message);
        }

        userStates.delete(chatId);
    } catch (error) {
        console.error('Error creating order:', error);
        await safeSendMessage(chatId, { text: "❌ Sorry, there was an error placing your order. Please try again." });
    }
}

async function handleExistingOrderConversation(chatId, text, existingOrder) {
    const normalizedText = text.toLowerCase().trim();

    if (['close', 'end', 'done'].includes(normalizedText)) {
        await Order.findByIdAndUpdate(existingOrder._id, { $set: { status: 'pending' } });
        await safeSendMessage(chatId, { text: `✅ Order #${existingOrder._id.toString().slice(-8)} conversation closed. Type 'menu' to start a new order.` });
        userStates.delete(chatId);
        return;
    }

    try {
        await Order.findByIdAndUpdate(existingOrder._id, {
            $push: { adminReplies: { message: text, timestamp: new Date(), isCustomer: true } },
            $set: { status: 'processing', updatedAt: new Date() }
        }, { new: true });

        await safeSendMessage(chatId, { text: `✅ Your message has been added to order #${existingOrder._id.toString().slice(-8)}. Our team will respond shortly. Type 'close' to end this conversation.` });
        userStates.set(chatId, { step: 'in_conversation', orderId: existingOrder._id });
    } catch (error) {
        console.error('Error updating order with customer reply:', error);
        await safeSendMessage(chatId, { text: '⚠️ There was an error processing your message. Please try again.' });
    }
}

// Main Message Handler
const handleMessage = async (message) => {
    if (!message.message) return;

    const chatId = message.key.remoteJid;
    if (chatId.endsWith('@g.us') || chatId.endsWith('@broadcast')) return;

    const text = (message.message.conversation || message.message.extendedTextMessage?.text || '').trim();
    const normalizedText = text.toLowerCase();
    let state = userStates.get(chatId);

    console.log('Incoming message:', { chatId, text, state: state ? state.step : 'none' });

    // --- Universal Commands ---
    if (['menu', 'start', 'help'].includes(normalizedText)) {
        userStates.delete(chatId);
        await showMainMenu(chatId);
        return;
    }
    if (normalizedText === 'back' && state) {
        await handleBackNavigation(chatId, state);
        return;
    }

    // --- Conversation Routing ---
    try {
        const existingOrder = await Order.findOne({ 
            userId: chatId, 
            status: { $in: ['pending', 'processing'] }
        }).sort({ createdAt: -1 });

        if ((!state || state.step === 'in_conversation') && existingOrder) {
            await handleExistingOrderConversation(chatId, text, existingOrder);
            return;
        }

        if (!state) {
            await showMainMenu(chatId);
            return;
        }

        switch (state.step) {
            case 'service_selection':
                await handleServiceSelection(chatId, state, text);
                break;
            case 'order_confirmation':
                await handleOrderConfirmation(chatId, state, text);
                break;
            default:
                await safeSendMessage(chatId, { text: "Sorry, I'm not sure how to handle that. Type 'menu' to start over." });
                userStates.delete(chatId);
                break;
        }
                    latestReply: updatedOrder.adminReplies[updatedOrder.adminReplies.length - 1]
                });
                
                // Send acknowledgment to user
                await safeSendMessage(chatId, { 
                    text: `✅ Your message has been added to order #${orderId.toString().slice(-8)}.\n\n💬 Your message: "${text}"\n\nOur team will respond shortly. Type 'close' to end this conversation.`
                });
                
            } catch (error) {
                console.error('Error updating order with customer reply in conversation:', error);
                await safeSendMessage(chatId, { 
                    text: '⚠️ There was an error processing your message. Please try again.'
                });
            }
        }
        
    } catch (error) {
        console.error('Error in message handler:', error);
        // Don't try to send error messages if connection is unstable
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





