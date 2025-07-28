import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import session from 'express-session';
import { connectToWhatsApp } from './whatsapp.js';

// Make Express app globally accessible for WhatsApp event emission

// Patch: always keep app.set('whatsappClient', sock) up-to-date
function keepWhatsAppClientUpdated(app, sockPromise) {
  sockPromise.then(sock => {
    if (sock) app.set('whatsappClient', sock);
    if (sock && sock.ev && sock.ev.on) {
      sock.ev.on('connection.update', () => {
        app.set('whatsappClient', sock);
      });
    }
  });
}

import adminRoutes from './routes/admin.js';
import 'dotenv/config';

// ES Module fix for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Express
const app = express();

// Make Express app globally accessible for WhatsApp event emission
globalThis.expressApp = app;
// Listen for WhatsApp authentication event and update session for current admin login
app.on('wa-authenticated', (sock) => {
  // This will only affect users on /admin/login route
  // Use a shared in-memory flag to signal login completion
  app.set('waJustAuthenticated', Date.now());
});
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: process.env.NODE_ENV === 'production' }
}));

// Make session available in all views
app.use((req, res, next) => {
  res.locals.session = req.session;
  next();
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, path) => {
    // Set proper content type for CSS files
    if (path.endsWith('.css')) {
      res.setHeader('Content-Type', 'text/css');
    }
  }
}));

// Add a route to handle favicon.ico to prevent 404 errors
app.get('/favicon.ico', (req, res) => res.status(204).end());

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://buzinezz1379:buzinezz1379@cluster0.la5fj.mongodb.net/fx_cobra_bot?retryWrites=true&w=majority';

// Set strictQuery to suppress deprecation warning
mongoose.set('strictQuery', false);

// Connect to MongoDB
mongoose.connect(MONGODB_URI, { 
  useNewUrlParser: true, 
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 5000
})
.then(() => console.log('Connected to MongoDB'))
.catch(err => console.error('MongoDB connection error:', err));

// Routes
app.use('/admin', adminRoutes);

// Home route
app.get('/', (req, res) => {
  res.send('Fx Cobra X Bot is running!');
});

// Start server and connect to WhatsApp
async function startServer() {
  try {
    // Initialize WhatsApp connection
    // Always keep WhatsApp client reference up-to-date for session/auth
    connectToWhatsApp(sock => app.set('whatsappClient', sock));
    
    // Start the server
    app.listen(PORT, () => {
      console.log(`Server running at http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Start the application
startServer();
