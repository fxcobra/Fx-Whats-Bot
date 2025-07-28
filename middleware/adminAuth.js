// Middleware to protect admin panel routes
export default function adminAuth(req, res, next) {
  // Always check WhatsApp connection first
  const sock = req.app.get('whatsappClient');
  const isWhatsAppConnected = !!(sock && sock.user);

  // If WhatsApp is NOT connected, force logout
  if (!isWhatsAppConnected) {
    if (req.session) {
      req.session.isAdmin = false;
      req.session.destroy(() => {
        return res.redirect('/admin/login');
      });
    } else {
      return res.redirect('/admin/login');
    }
    return; // Prevent further execution
  }

  // If already logged in via session and WhatsApp is connected
  if (req.session && req.session.isAdmin) return next();

  // If WhatsApp just connected, grant session
  if (isWhatsAppConnected) {
    req.session.isAdmin = true;
    return next();
  }

  // Otherwise, redirect to login
  return res.redirect('/admin/login');
}

