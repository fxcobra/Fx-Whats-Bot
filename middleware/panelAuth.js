import bcrypt from 'bcrypt';
import fs from 'fs';
import path from 'path';

const adminPath = path.resolve(process.cwd(), 'panelAdmin.json');
let adminCreds = { username: 'admin', password: '' };
if (fs.existsSync(adminPath)) {
  adminCreds = JSON.parse(fs.readFileSync(adminPath, 'utf8'));
}

export default function panelAuth(req, res, next) {
  if (req.session && req.session.panelLoggedIn) return next();
  // Allow access to panel login page itself (GET/POST)
  if (req.path === '/panel-login') return next();
  return res.redirect('/admin/panel-login');
}


export async function verifyPanelLogin(username, password) {
  if (username !== adminCreds.username) return false;
  return await bcrypt.compare(password, adminCreds.password);
}
