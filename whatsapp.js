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

// Message handler
const handleMessage = async (message) => {
    try {
        if (!message.message) return;
        
        const chatId = message.key.remoteJid;
        const text = message.message.conversation || 
                    message.message.extendedTextMessage?.text || '';
        
        // Skip group and broadcast messages
        if (chatId.endsWith('@g.us') || chatId.endsWith('@broadcast')) {
            return;
        }
        
        let state = userStates.get(chatId);
        
        // Log incoming message for debugging
        console.log('Incoming message:', {
            chatId,
            text,
            hasState: !!state,
            stateStep: state ? state.step : 'none'
        });
        
        // Special handling for common commands that should always work
        const normalizedText = text.toLowerCase().trim();
        if (normalizedText === 'menu' || normalizedText === 'start' || normalizedText === 'help') {
            // Always clear any existing state and show menu
            userStates.delete(chatId);
            const currency = await getActiveCurrency();
            const services = await Service.find({ parentId: null });
            let reply = 'Welcome to Fx Cobra X! Here are our services:\n';
            services.forEach((s, i) => { 
                if (s.price && s.price > 0) {
                    reply += `${i+1}. ${s.name} - ${currency.symbol}${s.price.toFixed(2)}\n`;
                } else {
                    reply += `${i+1}. ${s.name}\n`;
                }
            });
            reply += 'Reply with the number of your choice.';
            await safeSendMessage(chatId, { text: reply });
            userStates.set(chatId, { step: 'service_selection', services });
            return;
        }
        
        // Always check for existing orders first, regardless of state
        const existingOrder = await Order.findOne({ 
            userId: chatId, 
            status: { $nin: ['completed', 'cancelled', 'closed'] },
            $or: [
                { status: { $exists: false } }, // Backward compatibility
                { status: { $in: ['pending', 'processing'] } }
            ]
        }).sort({ createdAt: -1 });
        
        console.log('Existing order check:', {
            found: !!existingOrder,
            orderId: existingOrder ? existingOrder._id : 'none',
            status: existingOrder ? existingOrder.status : 'none',
            hasAdminReplies: existingOrder ? (existingOrder.adminReplies ? existingOrder.adminReplies.length : 0) : 0
        });
        
        if (!state && existingOrder) {
            
            // User has an active order - this is likely a reply to admin
            console.log('User has active order, treating as reply:', {
                orderId: existingOrder._id,
                userMessage: text,
                orderStatus: existingOrder.status,
                orderCreated: existingOrder.createdAt
            });
                
                // Check if this is a command to close the conversation
                if (normalizedText === 'close' || normalizedText === 'end' || normalizedText === 'done') {
                    await Order.findByIdAndUpdate(
                        existingOrder._id,
                        { $set: { status: 'completed' } }
                    );
                    
                    await safeSendMessage(chatId, {
                        text: `✅ Order #${existingOrder._id.toString().slice(-8)} has been marked as completed.\n\nThank you for your business! Type 'menu' to start a new order.`
                    });
                    
                    userStates.delete(chatId);
                    return;
                }
                
                // Add user message to the order as a customer reply
                try {
                    const updatedOrder = await Order.findByIdAndUpdate(
                        existingOrder._id,
                        { 
                            $push: { 
                                adminReplies: { 
                                    message: text,
                                    timestamp: new Date(),
                                    isCustomer: true
                                } 
                            },
                            $set: { 
                                status: 'processing',
                                updatedAt: new Date()
                            }
                        },
                        { new: true }
                    );
                    
                    console.log('Customer reply added to order:', {
                        orderId: updatedOrder._id,
                        totalReplies: updatedOrder.adminReplies.length,
                        latestReply: updatedOrder.adminReplies[updatedOrder.adminReplies.length - 1]
                    });
                    
                    // Always keep the conversation going for this order
                    userStates.set(chatId, { 
                        step: 'in_conversation',
                        orderId: existingOrder._id
                    });
                    
                    console.log('User state set to in_conversation:', {
                        chatId,
                        orderId: existingOrder._id,
                        step: 'in_conversation'
                    });
                    
                    // Only send acknowledgment if this isn't a command
                    if (!['menu', 'start', 'help', 'close', 'end', 'done'].includes(normalizedText)) {
                        await safeSendMessage(chatId, { 
                            text: `✅ Your message has been added to order #${existingOrder._id.toString().slice(-8)}.\n\n💬 Your message: "${text}"\n\nOur team will respond shortly. Type 'close' to end this conversation.`
                        });
                    }
                    
                    return;
                } catch (error) {
                    console.error('Error updating order with customer reply:', error);
                    await safeSendMessage(chatId, { 
                        text: '⚠️ There was an error processing your message. Please try again.'
                    });
                    return;
                }
            return; // Important: return here to prevent further processing
        }
        
        if (!state) {
            // No existing orders - show welcome message
            const services = await Service.find({ parentId: null });
            let reply = 'Welcome to Fx Cobra X! Here are our services:\n';
            services.forEach((s, i) => { 
                reply += `${i+1}. ${s.name}\n`; 
            });
            reply += 'Reply with the number of your choice.';
            
            await safeSendMessage(chatId, { text: reply });
            userStates.set(chatId, { step: 'service_selection', services });
            return;
        }
        
        // Handle service selection
        if (state.step === 'service_selection') {
            const choice = parseInt(text);
            // Get active currency symbol for price display
            const currency = await getActiveCurrency();

            if (choice && choice <= state.services.length) {
                const selectedService = state.services[choice - 1];
                
                // Get sub-services or products
                const subServices = await Service.find({ parentId: selectedService._id });
                
                if (subServices.length > 0) {
                    // Filter to only show services that can be ordered (have prices) or are categories with children
                    const orderableServices = [];
                    const categoryServices = [];
                    
                    for (const service of subServices) {
                        if (service.price && service.price > 0) {
                            orderableServices.push(service);
                        } else {
                            // Check if this service has children (is a category)
                            const hasChildren = await Service.countDocuments({ parentId: service._id });
                            if (hasChildren > 0) {
                                categoryServices.push(service);
                            }
                        }
                    }
                    
                    const allDisplayServices = [...categoryServices, ...orderableServices];
                    
                    // RECURSIVE CHECK: Only show 'no orderable services' if none exist at any depth
                    const hasAnyOrderable = await hasOrderableServices(selectedService._id);
                    if (allDisplayServices.length > 0 && hasAnyOrderable) {
                        let reply = `You selected: ${selectedService.name}\n\nAvailable options:\n`;
                        allDisplayServices.forEach((s, i) => { 
                            if (s.price && s.price > 0) {
                                reply += `${i+1}. ${s.name} - ${currency.symbol}${s.price.toFixed(2)}\n`; 
                            } else {
                                reply += `${i+1}. ${s.name} (Category)\n`;
                            }
                        });
                        reply += 'Reply with the number of your choice.';
                        
                        await safeSendMessage(chatId, { text: reply });
                        userStates.set(chatId, { 
                            step: 'product_selection', 
                            selectedService,
                            subServices: allDisplayServices 
                        });
                    } else if (!hasAnyOrderable) {
                        await safeSendMessage(chatId, { 
                            text: `❌ No orderable services found under "${selectedService.name}".\n\nType 'menu' to go back to main menu.` 
                        });
                        userStates.delete(chatId);
                    } else {
                        // Defensive fallback
                        await safeSendMessage(chatId, { 
                            text: `❌ No orderable services found under "${selectedService.name}".\n\nType 'menu' to go back to main menu.` 
                        });
                        userStates.delete(chatId);
                    }
                } else {
                    // This is a leaf service - check if it can be ordered
                    if (selectedService.price && selectedService.price > 0) {
                        await safeSendMessage(chatId, { 
                            text: `You selected: ${selectedService.name}\nPrice: ${currency.symbol}${selectedService.price.toFixed(2)}\n\nReply with 'order' to place an order or 'menu' to go back to main menu.` 
                        });
                        userStates.set(chatId, { 
                            step: 'order_confirmation', 
                            selectedService 
                        });
                    } else {
                        await safeSendMessage(chatId, { 
                            text: `❌ "${selectedService.name}" is not available for ordering.\n\nType 'menu' to see available options.` 
                        });
                        userStates.delete(chatId);
                    }
                }
            } else {
                await safeSendMessage(chatId, { 
                    text: 'Invalid choice. Please select a valid number.' 
                });
            }
        }
        // Handle product selection
        else if (state.step === 'product_selection') {
            const choice = parseInt(text);
            if (choice && choice <= state.subServices.length) {
                const selectedProduct = state.subServices[choice - 1];
                
                // Check if this is a category (no price) or an orderable service
                if (selectedProduct.price && selectedProduct.price > 0) {
                    // This is an orderable service
                    await safeSendMessage(chatId, { 
                        text: `You selected: ${selectedProduct.name}\nPrice: $${selectedProduct.price.toFixed(2)}\n\nReply with 'order' to place an order or 'menu' to go back to main menu.` 
                    });
                    userStates.set(chatId, { 
                        step: 'order_confirmation', 
                        selectedService: selectedProduct 
                    });
                } else {
                    // This is a category - show its children
                    const subServices = await Service.find({ parentId: selectedProduct._id });
                    
                    // RECURSIVE CHECK: Only show 'no orderable services' if none exist at any depth
                    const hasAnyOrderable = await hasOrderableServices(selectedProduct._id);
                    if (subServices.length > 0 && hasAnyOrderable) {
                        // Filter to only show orderable services and categories
                        const orderableServices = [];
                        const categoryServices = [];
                        for (const s of subServices) {
                            if (s.price && s.price > 0) {
                                orderableServices.push(s);
                            } else {
                                const hasChildren = await Service.countDocuments({ parentId: s._id });
                                if (hasChildren > 0) {
                                    categoryServices.push(s);
                                }
                            }
                        }
                        const allDisplayServices = [...categoryServices, ...orderableServices];
                        let reply = `You selected: ${selectedProduct.name}\n\nAvailable options:\n`;
                        allDisplayServices.forEach((s, i) => { 
                            if (s.price && s.price > 0) {
                                reply += `${i+1}. ${s.name} - $${s.price.toFixed(2)}\n`; 
                            } else {
                                reply += `${i+1}. ${s.name} (Category)\n`;
                            }
                        });
                        reply += 'Reply with the number of your choice.';
                        
                        await safeSendMessage(chatId, { text: reply });
                        userStates.set(chatId, { 
                            step: 'product_selection', 
                            selectedService: selectedProduct,
                            subServices: allDisplayServices 
                        });
                    } else if (!hasAnyOrderable) {
                        await safeSendMessage(chatId, { 
                            text: `❌ No orderable services found under "${selectedProduct.name}".\n\nType 'menu' to go back to main menu.` 
                        });
                        userStates.delete(chatId);
                    } else {
                        await safeSendMessage(chatId, { 
                            text: `❌ "${selectedProduct.name}" is a category with no available services.\n\nType 'menu' to go back to main menu.` 
                        });
                        userStates.delete(chatId);
                    }
                }
            } else {
                await safeSendMessage(chatId, { 
                    text: 'Invalid choice. Please select a valid number.' 
                });
            }
        }
        // Handle order confirmation
        else if (state.step === 'order_confirmation') {
            const normalizedText = text.toLowerCase().trim();
            
            // Get active currency symbol for price display
            const currency = await getActiveCurrency();

            if (normalizedText === 'order') {
                try {
                    // Get the latest service data from the database
                    const service = await Service.findById(state.selectedService._id);
                    if (!service) {
                        throw new Error('Service not found');
                    }

                    // Check if this service can be ordered (has a price)
                    if (!service.price || service.price <= 0) {
                        await safeSendMessage(chatId, { 
                            text: `❌ Sorry, "${service.name}" is a category and cannot be ordered directly.\n\nPlease select a specific service with pricing from the menu.\n\nType 'menu' to see available options.` 
                        });
                        userStates.delete(chatId);
                        return;
                    }

                    // Create order with service details
                    const orderData = {
                        userId: chatId,
                        serviceId: service._id,
                        serviceName: service.name,
                        price: service.price,
                        status: 'pending',
                        message: `I would like to order: ${service.name} for ${currency.symbol}${service.price.toFixed(2)}`,
                        adminReplies: []
                    };
                    
                    console.log('Creating new order with data:', orderData);
                    const order = new Order(orderData);
                    
                    await order.save();

// Send SMS notification to admin/recipient (do not block order flow)
try {
    const smsText = `New Order: ${service.name} (${currency.symbol}${service.price.toFixed(2)}) from ${chatId}`;
    let smsConfig = { apiKey: '', sender: '', recipient: '' };
    const smsSettingsPath = path.resolve(process.cwd(), 'smsSettings.json');
    try {
        if (fs.existsSync(smsSettingsPath)) {
            smsConfig = JSON.parse(fs.readFileSync(smsSettingsPath, 'utf8'));
        }
    } catch (configErr) {
        console.error('[SMS] Failed to read smsSettings.json:', configErr);
    }
    console.log('[SMS] Attempting to send SMS:', { smsText, smsConfig });
    sendSMS(smsText, smsConfig)
        .then((result) => {
            console.log('[SMS] Notification sent for new order. API result:', result);
        })
        .catch(err => {
            console.error('[SMS] Error sending notification:', err && err.message ? err.message : err);
        });
} catch (err) {
    console.error('[SMS] Unexpected error in SMS notification:', err && err.message ? err.message : err);
}

// Verify the order was saved by fetching it back with all fields
                    const savedOrder = await Order.findById(order._id).lean();
                    console.log('Fetched saved order from DB:', {
                        _id: savedOrder._id,
                        serviceName: savedOrder.serviceName,
                        price: savedOrder.price,
                        message: savedOrder.message,
                        adminRepliesCount: savedOrder.adminReplies ? savedOrder.adminReplies.length : 0
                    });
                    
                    // DEBUG: Log service object and _id before breadcrumb
                    console.log('[Order Debug] service:', service);
                    console.log('[Order Debug] service._id:', service._id);
                    let breadcrumb = await getServiceBreadcrumb(service._id);
                    console.log('[Order Debug] breadcrumb:', breadcrumb);
                    if (!breadcrumb || breadcrumb.length === 0) {
                        breadcrumb = [service.name || 'UNKNOWN SERVICE'];
                    }
                    await safeSendMessage(chatId, { 
                        text: `✅ Order placed successfully!\n\n📋 Order ID: ${order._id}\n💼 Service: ${breadcrumb.join(' > ')}\n💰 Price: $${service.price}\n📊 Status: Pending\n\nYou will receive updates on your order status. Thank you for choosing Fx Cobra X!` 
                    });
                    
                    // Reset user state
                    userStates.delete(chatId);
                } catch (error) {
                    console.error('Error creating order:', error);
                    await safeSendMessage(chatId, { 
                        text: "❌ Sorry, there was an error processing your order. Please try again or contact support."
                    });
                }
            } else if (normalizedText === 'menu') {
                userStates.delete(chatId);
                await handleMessage({ ...message, message: { conversation: '' } }); // Restart with welcome message
            } else {
                // If we get here, the user sent an unexpected message
                await safeSendMessage(chatId, { 
                    text: `⚠️ Please choose an option:\n• Type 'order' to confirm your order\n• Type 'menu' to go back to main menu`
                });
            }
        }
        // Handle in_conversation state - when user is actively chatting with admin
        else if (state.step === 'in_conversation') {
            const orderId = state.orderId;
            
            // Check if this is a command to close the conversation
            if (normalizedText === 'close' || normalizedText === 'end' || normalizedText === 'done') {
                await Order.findByIdAndUpdate(
                    orderId,
                    { $set: { status: 'completed' } }
                );
                
                await safeSendMessage(chatId, {
                    text: `✅ Order #${orderId.toString().slice(-8)} has been marked as completed.\n\nThank you for your business! Type 'menu' to start a new order.`
                });
                
                userStates.delete(chatId);
                return;
            }
            
            // Check if user wants to go back to menu
            if (normalizedText === 'menu' || normalizedText === 'start' || normalizedText === 'help') {
                // Don't close the order, just reset the state
                userStates.delete(chatId);
                const services = await Service.find({ parentId: null });
                let reply = 'Welcome to Fx Cobra X! Here are our services:\n';
                services.forEach((s, i) => { 
                    reply += `${i+1}. ${s.name}\n`; 
                });
                reply += 'Reply with the number of your choice.';
                
                await safeSendMessage(chatId, { text: reply });
                userStates.set(chatId, { step: 'service_selection', services });
                return;
            }
            
            // Add user message to the order as a customer reply
            try {
                const updatedOrder = await Order.findByIdAndUpdate(
                    orderId,
                    { 
                        $push: { 
                            adminReplies: { 
                                message: text,
                                timestamp: new Date(),
                                isCustomer: true
                            } 
                        },
                        $set: { 
                            status: 'processing',
                            updatedAt: new Date()
                        }
                    },
                    { new: true }
                );
                
                console.log('Customer reply added to ongoing conversation:', {
                    orderId: updatedOrder._id,
                    totalReplies: updatedOrder.adminReplies.length,
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

// Logout function: cleanly disconnect and clear sessionexport async function logoutWhatsApp() {    try {        if (sock && sock.logout) {            await sock.logout();        }        if (sock && sock.end) {            sock.end();        }        sock = null;        connectionState = 'closed';        // Remove session folder        if (fs.existsSync(AUTH_DIR)) {            fs.rmSync(AUTH_DIR, { recursive: true, force: true });            console.log('Session directory deleted for logout.');        }    } catch (err) {        console.error('Error during WhatsApp logout:', err);    }}





