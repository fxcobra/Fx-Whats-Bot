// Middleware to protect admin panel routes
// RELAXED: Allow access if panelLoggedIn is set, regardless of WhatsApp connection
export default function adminAuth(req, res, next) {
  if (req.session && req.session.panelLoggedIn) return next();
  // Legacy: If already logged in via session and WhatsApp is connected
  const sock = req.app.get('whatsappClient');
  const isWhatsAppConnected = !!(sock && sock.user);
  if (req.session && req.session.isAdmin && isWhatsAppConnected) return next();
  // If WhatsApp just connected, grant session
  if (isWhatsAppConnected) {
    req.session.isAdmin = true;
    return next();
  }
  // Otherwise, redirect to login
  return res.redirect('/admin/login');
}


