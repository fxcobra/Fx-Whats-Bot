// whatsapp.js
import pkg from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
const { makeWASocket, DisconnectReason, useMultiFileAuthState, delay, makeInMemoryStore, DisconnectError } = pkg;
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';
import Order from './models/Order.js';
import Service from './models/Service.js';

const userStates = new Map();
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_INTERVAL = 5000; // 5 seconds
const AUTH_DIR = 'session'; // Changed to match reference bot's approach
const MAX_RETRY_ATTEMPTS = 3;
let isReconnecting = false;

// Simple function to ensure auth directory exists
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

async function handleConnection() {
    if (isReconnecting) {
        console.log('Reconnection already in progress, skipping...');
        return;
    }
    
    isReconnecting = true;
    
    try {
        // Clean up old auth state if we've had multiple failures
        // (No manual cleanup needed; session folder is managed automatically)
        // if (reconnectAttempts > 0 && reconnectAttempts % 3 === 0) {
        //     console.log('Multiple reconnection attempts, cleaning up auth state...');
        //     await cleanAuthState();
        // }

        // Ensure session directory exists
        if (!ensureAuthDir()) {
            throw new Error('Failed to create session directory');
        }

        // Initialize auth state with the session directory
        const { state, saveCreds: originalSaveCreds } = await useMultiFileAuthState(AUTH_DIR);
        
        // Create a wrapper for saveCreds to add logging
        const saveCreds = async () => {
            try {
                await originalSaveCreds();
                console.log('Credentials updated');
            } catch (error) {
                console.error('Error updating credentials:', error);
                throw error;
            }
        };
        
        // Reset reconnect attempts on successful auth state load
        if (reconnectAttempts > 0) {
            console.log('Successfully reconnected to WhatsApp!');
            reconnectAttempts = 0;
        }
        
        // Create a simple logger that Baileys can use
        const logger = {
            level: 'error',
            trace: () => {},
            debug: () => {},
            info: () => {},
            warn: (message, ...args) => console.warn(message, ...args),
            error: (message, ...args) => console.error(message, ...args),
            fatal: (message, ...args) => console.error('FATAL:', message, ...args),
            child: () => ({
                trace: () => {},
                debug: () => {},
                info: () => {},
                warn: (message, ...args) => console.warn(message, ...args),
                error: (message, ...args) => console.error(message, ...args),
                fatal: (message, ...args) => console.error('FATAL:', message, ...args)
            })
        };

        // Initialize the store
        const store = makeInMemoryStore({ logger });
        store.readFromFile('./baileys_store.json');
        
        // Configure socket with better error handling and rate limiting
        const sock = makeWASocket({
            printQRInTerminal: true,
            auth: state,
            // Use a more standard browser string
            browser: ['Windows', 'Chrome', '110.0.0.0'],
            // Optimized timeouts and intervals
            defaultQueryTimeoutMs: 60_000,
            connectTimeoutMs: 60_000,
            keepAliveIntervalMs: 15_000,
            // Disable features that might cause issues
            syncFullHistory: false,
            markOnlineOnConnect: true,
            // Enable keepalive pings
            pingInterval: 25_000,
            // Disable message retries to prevent duplicate messages
            maxMsgRetryCount: 0,
            // Disable message retry queue
            msgRetryCounterCache: null,
            // Better logging
            logger: {
                ...logger,
                level: 'error' // Only log errors to reduce noise
            },
            getMessage: async () => undefined,
            shouldSyncHistoryMessage: () => false,
            shouldIgnoreJid: (jid) => {
                // Ignore groups and broadcasts to prevent decryption errors
                return jid.endsWith('@g.us') || jid.endsWith('@broadcast');
            },
            shouldSyncTimeout: 1000,
            transactionOpts: { 
                maxCommitRetries: 2, // Reduced retries
                delayBetweenTriesMs: 2000 // Increased delay
            },
            fireInitQueries: false,
            maxQueryResponseTime: 30_000,
            maxCachedMessages: 5, // Reduced cache size
            retryRequestDelayMs: 3000, // Increased delay
            fetchPatch: false,
            patchMessageBeforeSending: () => ({}),
            handleRateLimit: (retryAfter) => {
                console.log(`Rate limited, waiting ${retryAfter}ms`);
                return true;
            },
            emitOwnEvents: false,
            maxMsgRetryCount: 1,
            // Add additional security options
            appStateMacVerification: {
                patch: false,
                snapshot: false
            },
            // Disable unnecessary features
            linkPreviewImageThumbnailWidth: 0
        });
        
        // Bind the store to the socket
        store.bind(sock.ev);

            let qrGenerated = false;
            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr, isNewLogin } = update;
                
                if (qr && !qrGenerated) {
                    qrGenerated = true;
                    console.log('\n=== NEW QR CODE GENERATED ===');
                    console.log('1. Open WhatsApp on your phone');
                    console.log('2. Tap Menu or Settings and select Linked Devices');
                    console.log('3. Tap on Link a Device');
                    console.log('4. Scan this QR code:\n');
                    qrcode.generate(qr, { small: true });
                    console.log('\n=== SCAN THE ABOVE QR CODE ===\n');
                }
                
                if (isNewLogin) {
                    console.log('New login detected, saving credentials...');
                    await saveCreds();
                }

                if (connection === 'close') {
                    const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                    console.log('Connection closed due to', lastDisconnect.error, ', reconnecting', shouldReconnect);
                    
                    if (shouldReconnect) {
                        reconnectAttempts++;
                        if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
                            console.log(`Reconnection attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${RECONNECT_INTERVAL/1000} seconds...`);
                            await delay(RECONNECT_INTERVAL);
                            return handleConnection();
                        }
                    }
                } else if (connection === 'open') {
                    console.log('WhatsApp connection opened successfully!');
                    reconnectAttempts = 0; // Reset counter on successful connection
                }
            });

            sock.ev.on('creds.update', async () => {
                try {
                    await saveCreds();
                } catch (error) {
                    console.error('Error saving credentials:', error);
                }
            });

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr, isNewLogin } = update;
                
                if (isNewLogin) {
                    console.log('New login detected.');
                    reconnectAttempts = 0;
                }
                
                if (qr) {
                    console.log('Scan the QR code to authenticate:');
                    qrcode.generate(qr, { small: true });
                }

                if (connection === 'close') {
                    const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                    
                    // Handle rate limiting (error 429)
                    if (lastDisconnect?.error?.output?.statusCode === 429) {
                        const retryAfter = parseInt(lastDisconnect.error?.output?.headers?.['retry-after'] || '60', 10) * 1000;
                        console.log(`Rate limited. Waiting ${retryAfter}ms before reconnecting...`);
                        setTimeout(() => handleConnection(), retryAfter);
                        return;
                    }
                    
                    // Handle stream errors (code 515) with exponential backoff
                    if (lastDisconnect?.error?.output?.statusCode === 515) {
                        const backoffTime = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
                        console.log(`Stream error detected, reconnecting in ${backoffTime/1000} seconds...`);
                        
                        // Clean up old socket
                        try {
                            if (sock) {
                                await sock.end(undefined);
                            }
                        } catch (e) {
                            console.error('Error cleaning up socket:', e);
                        }
                        
                        // Schedule reconnection with backoff
                        setTimeout(() => {
                            isReconnecting = false;
                            handleConnection().catch(e => {
                                console.error('Error during reconnection:', e);
                            });
                        }, backoffTime);
                        return;
                    }
                    
                    console.log('Connection closed due to', lastDisconnect?.error || 'unknown reason', ', reconnecting', shouldReconnect);
                    
                    if (shouldReconnect) {
                        reconnectAttempts++;
                        if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
                            const delayTime = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
                            console.log(`Reconnection attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delayTime/1000} seconds...`);
                            setTimeout(() => handleConnection(), delayTime);
                        } else {
                            console.log('Max reconnection attempts reached. Please restart the bot.');
                            isReconnecting = false;
                        }
                    } else {
                        console.log('Disconnected. Please restart the bot.');
                        isReconnecting = false;
                    }
                } else if (connection === 'open') {
                    console.log('WhatsApp connection opened successfully!');
                    reconnectAttempts = 0;
                    isReconnecting = false;
                }
            });

            // Handle messages with improved error handling
            sock.ev.on('messages.upsert', async ({ messages, type }) => {
                for (const message of messages) {
                    try {
                        if (!message.message) continue;
                        
                        // Skip messages from groups and broadcasts
                        const jid = message.key.remoteJid || '';
                        if (jid.endsWith('@broadcast') || jid.endsWith('@g.us')) {
                            console.log('Skipping message from group/broadcast:', jid);
                            continue;
                        }
                        
                        // Process the message
                        await handleMessages(sock)({ messages: [message] });
                    } catch (error) {
                        console.error('Error processing message:', error);
                    }
                }
            });

            // Heartbeat to keep connection alive
            const heartbeat = setInterval(() => {
                if (sock.user) {
                    sock.updatePresence('available').catch(() => {});
                }
            }, 25_000);

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect } = update;
                if (connection === 'close') {
                    clearInterval(heartbeat);
                    const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                    
                    if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                        reconnectAttempts++;
                        const delayTime = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
                        console.log(`Connection closed. Reconnecting in ${delayTime/1000} seconds... (Attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
                        await delay(delayTime);
                        isReconnecting = false;
                        return handleConnection();
                    } else {
                        console.error('Max reconnection attempts reached. Please restart the bot.');
                        process.exit(1);
                    }
                }
            });

            return sock;
        } catch (error) {
            console.error('Connection error:', error);
            isReconnecting = false;
            throw error;
        }
    }

function handleMessages(sock) {
    return async ({ messages }) => {
        try {
            const message = messages[0];
            if (!message.message) return;
            
            const chatId = message.key.remoteJid;
            const text = message.message.conversation || '';
            let state = userStates.get(chatId);
            
            if (!state) {
                const services = await Service.find({ parentId: null });
                let reply = 'Welcome to Fx Cobra X! Here are our services:\n';
                services.forEach((s, i) => { reply += `${i+1}. ${s.name}\n`; });
                reply += 'Reply with the number of your choice.';
                await sock.sendMessage(chatId, { text: reply });
                userStates.set(chatId, { step: 'SERVICE_LIST', services });
                return;
            }

            try {
                switch (state.step) {
                    case 'SERVICE_LIST': {
                        const idx = parseInt(text) - 1;
                        if (isNaN(idx) || idx < 0 || idx >= state.services.length) {
                            await sock.sendMessage(chatId, { text: 'Invalid choice. Please enter a valid number.' });
                            return;
                        }
                        const service = state.services[idx];
                        state.selectedService = service;
                        const subs = await Service.find({ parentId: service._id });
                        
                        if (subs.length > 0) {
                            let reply = `Sub-options for ${service.name}:\n`;
                            subs.forEach((s, i) => { reply += `${i+1}. ${s.name}\n`; });
                            reply += 'Reply with the number of your choice.';
                            state.step = 'SUB_SERVICE_LIST';
                            state.services = subs;
                            await sock.sendMessage(chatId, { text: reply });
                        } else {
                            await sock.sendMessage(chatId, { 
                                text: `Please enter order details for ${service.name} (e.g., quantity, address).` 
                            });
                            state.step = 'COLLECT_INFO';
                        }
                        userStates.set(chatId, state);
                        break;
                    }
                    
                    case 'SUB_SERVICE_LIST': {
                        const idx = parseInt(text) - 1;
                        if (isNaN(idx) || idx < 0 || idx >= state.services.length) {
                            await sock.sendMessage(chatId, { text: 'Invalid choice. Please enter a valid number.' });
                            return;
                        }
                        const service = state.services[idx];
                        state.selectedService = service;
                        await sock.sendMessage(chatId, { 
                            text: `Please enter order details for ${service.name} (e.g., quantity, address).` 
                        });
                        state.step = 'COLLECT_INFO';
                        userStates.set(chatId, state);
                        break;
                    }
                    
                    case 'COLLECT_INFO': {
                        state.orderDetails = text;
                        await sock.sendMessage(chatId, { 
                            text: 'Please enter your payment method (e.g., Credit Card, PayPal, Bank Transfer):' 
                        });
                        state.step = 'PAYMENT_INFO';
                        userStates.set(chatId, state);
                        break;
                    }
                    
                    case 'PAYMENT_INFO': {
                        const order = new Order({
                            userId: chatId,
                            serviceId: state.selectedService._id,
                            details: state.orderDetails,
                            payment: {
                                method: text,
                                status: 'pending'
                            },
                            status: 'pending'
                        });
                        
                        await order.save();
                        
                        // Notify admin
                        const adminMessage = `New order received!\nService: ${state.selectedService.name}\nDetails: ${state.orderDetails}\nPayment: ${text}`;
                        // Replace with admin's chat ID
                        // await sock.sendMessage('ADMIN_CHAT_ID@s.whatsapp.net', { text: adminMessage });
                        
                        await sock.sendMessage(chatId, { 
                            text: 'Thank you for your order! We will process it shortly.' 
                        });
                        userStates.delete(chatId);
                        break;
                    }
                }
            } catch (error) {
                console.error('Error in message handler:', error);
                try {
                    await sock.sendMessage(chatId, { 
                        text: 'An error occurred while processing your request. Please try again.' 
                    });
                } catch (e) {
                    console.error('Failed to send error message:', e);
                }
            }
        } catch (error) {
            console.error('Error in messages.upsert handler:', error);
        }
    };
}

export async function connectToWhatsApp() {
    return handleConnection();
}