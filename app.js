// A new, robust app.js with extensive logging

// --- 1. Early Logging & Environment Setup ---
console.log('[App] Starting application...');
import dotenv from 'dotenv';
dotenv.config();
console.log('[App] Environment variables loaded.');

// --- 2. Imports ---
import express from 'express';
import mongoose from 'mongoose';
import session from 'express-session';
import path from 'path';
import { fileURLToPath } from 'url';
// import adminRoutes from './routes/admin.js'; // Temporarily disabled for debugging
// import { connectToWhatsApp } from './whatsapp.js'; // Temporarily disabled for debugging

console.log('[App] All modules imported.');

// --- 3. Uncaught Exception Handler ---
process.on('uncaughtException', (err, origin) => {
    console.error('!!!!!!!!!! UNCAUGHT EXCEPTION !!!!!!!!!!');
    console.error(`[${origin}] ${err.stack}`);
});

// --- 4. Main Application Setup ---
try {
    const app = express();
    const PORT = process.env.PORT || 3000;

    // Get __dirname in ES modules
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    console.log('[App] Express app created.');

    // --- 5. Database Connection ---
    console.log('[DB] Attempting to connect to MongoDB...');
    mongoose.connect(process.env.MONGODB_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
    }).then(() => {
        console.log('[DB] MongoDB connected successfully.');
    }).catch(err => {
        console.error('[DB] MongoDB connection error:', err);
        process.exit(1); // Exit if DB connection fails
    });

    // --- 6. Middleware ---
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use(session({
        secret: process.env.SESSION_SECRET || 'a-very-strong-secret-key',
        resave: false,
        saveUninitialized: true,
        cookie: { secure: false } // Set to true if using HTTPS
    }));
    console.log('[App] Core middleware configured.');

    // --- 7. View Engine ---
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, 'views'));
    console.log('[App] View engine (EJS) configured.');

    // --- 8. Static Files ---
    app.use(express.static(path.join(__dirname, 'public')));
    console.log('[App] Static file directory configured.');

    // --- 9. WhatsApp Client Initialization (Temporarily Disabled) ---
    console.log('[WhatsApp] Initialization skipped for debugging.');

    // --- 10. Routes (Temporarily Disabled) ---
    // app.use('/admin', adminRoutes);
    console.log('[App] Admin routes skipped for debugging.');

    // Root route
    app.get('/', (req, res) => {
        res.redirect('/admin/login');
    });

    // --- 11. Start Server ---
    app.listen(PORT, () => {
        console.log(`\n🚀 Server is running and listening on http://localhost:${PORT}`);
        console.log(`   Admin panel: http://localhost:${PORT}/admin/login`);
    });

} catch (error) {
    console.error('!!!!!!!!!! FATAL STARTUP ERROR !!!!!!!!!!');
    console.error(error.stack);
    process.exit(1);
}
