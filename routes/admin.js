import express from 'express';
import { Parser as Json2csvParser } from 'json2csv';
const router = express.Router();
import mongoose from 'mongoose';
import Service from '../models/Service.js';
import Order from '../models/Order.js';
import Currency from '../models/Currency.js'; // Import Currency model
import QuickReply from '../models/QuickReply.js'; // Import QuickReply model
import Help from '../models/Help.js';
import formatPrice from '../formatPrice.js';
import adminAuth from '../middleware/adminAuth.js';
import panelAuth, { verifyPanelLogin } from '../middleware/panelAuth.js';

// Middleware to validate ObjectId parameters
const validateObjectId = (req, res, next) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(404).send('Invalid ID format');
  }
  next();
};

// Attach WhatsApp client
router.use((req, res, next) => {
  req.client = req.app.get('whatsappClient');
  next();
});

// Panel login middleware (username/password) comes BEFORE WhatsApp QR auth
router.use(panelAuth);

// Panel login page
router.get('/panel-login', (req, res) => {
  if (req.session && req.session.panelLoggedIn) return res.redirect('/admin/login');
  res.render('admin/panel-login', { error: null });
});

// Panel login POST
router.post('/panel-login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.render('admin/panel-login', { error: 'Username and password required.' });
  }
  const valid = await verifyPanelLogin(username, password);
  if (!valid) {
    return res.render('admin/panel-login', { error: 'Invalid username or password.' });
  }
  req.session.panelLoggedIn = true;
  res.redirect('/admin/login');
});

// Admin login page (QR)
router.get('/login', (req, res) => {
  const sock = req.app.get('whatsappClient');
  // If already authenticated, redirect to dashboard
  if (sock && sock.user) {
    req.session.isAdmin = true;
    return res.redirect('/admin/dashboard');
  }
  // If WhatsApp just authenticated (event flag), force session and redirect
  const waJustAuthenticated = req.app.get('waJustAuthenticated');
  if (waJustAuthenticated && Date.now() - waJustAuthenticated < 15000) { // 15s window
    req.session.isAdmin = true;
    req.app.set('waJustAuthenticated', null);
    return res.redirect('/admin/dashboard');
  }
  // Always get the latest QR code from sock.qr
  let qr = null;
  if (sock && sock.qr) {
    qr = sock.qr;
  }
  res.render('admin/login', { qr });
});

// API endpoint for session status and QR polling
router.get('/session-status', (req, res) => {
  const sock = req.app.get('whatsappClient');
  const authenticated = !!(sock && sock.user);
  let qr = null;
  if (!authenticated && sock && sock.qr) {
    qr = sock.qr.startsWith('data:image') ? sock.qr : `data:image/png;base64,${sock.qr}`;
  }
  // Debug log
  console.log('[SESSION STATUS]', {
    sessionId: req.sessionID,
    sessionAdmin: req.session ? req.session.isAdmin : undefined,
    hasSock: !!sock,
    hasUser: !!(sock && sock.user),
    qr: qr ? '[QR present]' : null,
    authenticated
  });
  res.json({ authenticated, qr });
});

// Refresh QR code (force WhatsApp to regenerate QR)
router.post('/login/refresh', (req, res) => {
  const sock = req.app.get('whatsappClient');
  if (sock && sock.logout) sock.logout(); // Force re-auth
  req.session.isAdmin = false;
  res.redirect('/admin/login');
});

// Logout route
import { logoutWhatsApp } from '../whatsapp.js';

// Enhanced logout: supports panel, WhatsApp, or both (use ?type=panel|wa|both)
router.get('/logout', async (req, res) => {
  const type = req.query.type || 'both';
  if (type === 'panel' || type === 'both') {
    req.session.panelLoggedIn = false;
    req.session.isAdmin = false;
  }
  if (type === 'wa' || type === 'both') {
    await logoutWhatsApp();
  }
  req.session.destroy(() => {
    // Inform user of restart, then exit process (system will restart if managed)
    res.send('<html><body><h2>System is restarting...</h2><script>setTimeout(()=>{window.location="/admin/panel-login"},4000);</script></body></html>');
    setTimeout(() => {
      process.exit(0); // Triggers full restart under process manager
    }, 1000);
  });
});

// Protect all admin panel routes except login/logout
// IMPORTANT: Move this AFTER login/logout routes so login is not protected by adminAuth
router.use(adminAuth);

// SMS settings utility
import fs from 'fs';
import path from 'path';
const smsSettingsPath = path.resolve(process.cwd(), 'smsSettings.json');
const momoSettingsPath = path.resolve(process.cwd(), 'momoSettings.json');

// Utility to load MoMo settings
function loadMomoSettings() {
    try {
        if (!fs.existsSync(momoSettingsPath)) {
            fs.writeFileSync(momoSettingsPath, JSON.stringify({ environment: 'sandbox', apiUser: '', apiKey: '', subscriptionKey: '', currency: 'EUR' }, null, 2));
        }
        return JSON.parse(fs.readFileSync(momoSettingsPath, 'utf8'));
    } catch (e) {
        console.error('[Settings] Error loading momoSettings.json:', e);
        return { environment: 'sandbox', apiUser: '', apiKey: '', subscriptionKey: '', currency: 'EUR' };
    }
}

// Utility to save MoMo settings
function saveMomoSettings(settings) {
    try {
        fs.writeFileSync(momoSettingsPath, JSON.stringify(settings, null, 2));
        return true;
    } catch (e) {
        console.error('[Settings] Error saving momoSettings.json:', e);
        return false;
    }
}

// Admin settings page (GET)
router.get('/settings', async (req, res) => {
  let smsSettings = {};
  let momoSettings = loadMomoSettings();
  try {
    if (fs.existsSync(smsSettingsPath)) {
      smsSettings = JSON.parse(fs.readFileSync(smsSettingsPath, 'utf8'));
    }
  } catch { smsSettings = {}; }
  const activeCurrency = await Currency.findOne({ isActive: true }) || { symbol: '$', code: 'USD' };
  const help = await Help.findOneOrCreate();
  res.render('admin/settings', { currencies: [], quickReplies: [], smsSettings, smsAlert: null, currency: activeCurrency, momoSettings, help });
});

// Admin settings page (POST MoMo settings)
router.post('/settings/momo', async (req, res) => {
  const { environment, apiUser, apiKey, subscriptionKey, currency } = req.body;
  const momoSettings = { environment, apiUser, apiKey, subscriptionKey, currency };
  let success = null;
  let error = null;
  if (!environment || !apiUser || !apiKey || !subscriptionKey || !currency) {
    error = 'All fields are required for MoMo settings.';
  } else if (!['sandbox', 'production'].includes(environment)) {
    error = 'Invalid environment selected.';
  } else {
    if (saveMomoSettings(momoSettings)) {
      success = 'MTN MoMo settings saved successfully.';
    } else {
      error = 'Failed to save MTN MoMo settings.';
    }
  }
  let smsSettings = {};
  try {
    if (fs.existsSync(smsSettingsPath)) {
      smsSettings = JSON.parse(fs.readFileSync(smsSettingsPath, 'utf8'));
    }
  } catch { smsSettings = {}; }
  const activeCurrency = await Currency.findOne({ isActive: true }) || { symbol: '$', code: 'USD' };
  const help = await Help.findOneOrCreate();
  res.render('admin/settings', {
    currencies: [],
    quickReplies: [],
    smsSettings,
    smsAlert: null,
    currency: activeCurrency,
    momoSettings,
    help,
    success,
    error
  });
});

// Admin settings page (POST Help Message)
router.post('/settings/help', async (req, res) => {
    const { content } = req.body;
    let success = null;
    let error = null;

    try {
        if (!content || content.trim() === '') {
            error = 'Help message content cannot be empty.';
        } else {
            const help = await Help.findOneOrCreate();
            help.content = content;
            await help.save();
            success = 'Help message updated successfully.';
        }
    } catch (e) {
        console.error('[Settings] Error saving help message:', e);
        error = 'Failed to save help message.';
    }

    // Reload all settings to re-render the page
    let smsSettings = {};
    let momoSettings = loadMomoSettings();
    try {
        if (fs.existsSync(smsSettingsPath)) {
            smsSettings = JSON.parse(fs.readFileSync(smsSettingsPath, 'utf8'));
        }
    } catch { smsSettings = {}; }
    const activeCurrency = await Currency.findOne({ isActive: true }) || { symbol: '$', code: 'USD' };
    const help = await Help.findOneOrCreate();

    res.render('admin/settings', {
        currencies: [], 
        quickReplies: [], 
        smsSettings,
        smsAlert: null,
        currency: activeCurrency,
        momoSettings,
        help,
        success,
        error
    });
});

// Admin settings page (POST SMS settings)
router.post('/settings/sms', async (req, res) => {
  const { apiKey, sender, recipient } = req.body;
  let smsSettings = { apiKey, sender, recipient };
  let smsAlert = null;
  try {
    fs.writeFileSync(smsSettingsPath, JSON.stringify(smsSettings, null, 2));
    smsAlert = { type: 'success', message: 'SMS settings updated successfully.' };
  } catch (e) {
    smsAlert = { type: 'danger', message: 'Failed to save SMS settings.' };
  }
  const activeCurrency = await Currency.findOne({ isActive: true }) || { symbol: '$', code: 'USD' };
  const help = await Help.findOneOrCreate();
  res.render('admin/settings', { currencies: [], quickReplies: [], smsSettings, smsAlert, currency: activeCurrency, help });
});

// Root admin route - redirect to dashboard
router.get('/', (req, res) => {
  res.redirect('/admin/dashboard');
});

// Dashboard - recent orders
router.get('/dashboard', async (req, res) => {
  // All recent orders for table
  const recentOrders = await Order.find().sort({ createdAt: -1 }).limit(20).populate('serviceId');
  // Only completed orders for revenue
  const completedOrders = await Order.find({ status: 'completed' });
  const activeCurrency = await Currency.findOne({ isActive: true }) || { symbol: '$', code: 'USD' };
  res.render('admin/dashboard', { orders: recentOrders, completedOrders, currency: activeCurrency });
});

// Services management
router.get('/services', async (req, res) => {
  let { page = 1, pageSize = 10, search = '', parent = '' } = req.query;
  page = parseInt(page) || 1;
  pageSize = parseInt(pageSize) || 10;
  const query = {};
  if (search) {
    query.name = { $regex: search, $options: 'i' };
  }
  if (parent && parent !== 'all') {
    query.parentId = parent;
  }
  const totalServices = await Service.countDocuments(query);
  const services = await Service.find(query)
    .populate('parentId')
    .sort({ createdAt: -1 })
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .lean();
  // Only include non-orderable (category) services: no price and has children
  const parentOptions = await Service.aggregate([
    { $match: { $or: [ { price: { $exists: false } }, { price: null }, { price: 0 } ] } },
    { $lookup: {
      from: 'services',
      localField: '_id',
      foreignField: 'parentId',
      as: 'children'
    }},
    { $match: { 'children.0': { $exists: true } } },
    { $project: { _id: 1, name: 1 } }
  ]);
  const activeCurrency = await Currency.findOne({ isActive: true }) || { symbol: '$', code: 'USD' };
  res.render('admin/services', {
    services,
    currency: activeCurrency,
    pagination: {
      page,
      pageSize,
      totalServices,
      totalPages: Math.ceil(totalServices / pageSize),
      search,
      parent
    },
    parentOptions
  });
});

// TEMP DEBUG: GET route for bulk-action
router.get('/services/bulk-action', (req, res) => {
  res.status(200).send('GET /services/bulk-action is working! (router is mounted)');
});

// Bulk actions for services (export/delete)
router.post('/services/bulk-action', async (req, res) => {
  console.log('[DEBUG] POST /services/bulk-action HIT');
  console.log('[BulkServiceAction Debug] req.body:', req.body);
  try {
    const { bulkAction, serviceIds } = req.body;
    let ids = serviceIds;
    if (!ids || (Array.isArray(ids) && ids.length === 0)) {
      req.session.error = 'No services selected.';
      return res.redirect('/admin/services');
    }
    if (!Array.isArray(ids)) ids = [ids];
    if (bulkAction === 'export') {
      const services = await Service.find({ _id: { $in: ids } }).populate('parentId').lean();
      const fields = [
        { label: 'Service ID', value: '_id' },
        { label: 'Name', value: 'name' },
        { label: 'Description', value: 'description' },
        { label: 'Parent', value: row => row.parentId && row.parentId.name ? row.parentId.name : '' },
        { label: 'Price', value: 'price' },
        { label: 'Created', value: row => row.createdAt ? new Date(row.createdAt).toLocaleString() : '' },
      ];
      const parser = new Json2csvParser({ fields });
      const csv = parser.parse(services);
      res.header('Content-Type', 'text/csv');
      res.attachment('services_export_selected.csv');
      return res.send(csv);
    } else if (bulkAction === 'delete') {
      await Service.deleteMany({ _id: { $in: ids } });
      req.session.success = `Deleted ${ids.length} service(s).`;
      return res.redirect('/admin/services');
    } else {
      req.session.error = 'Invalid bulk action.';
      return res.redirect('/admin/services');
    }
  } catch (error) {
    console.error('Bulk service action error:', error);
    req.session.error = 'Bulk service action failed.';
    return res.redirect('/admin/services');
  }
});

// CSV Export for services
router.get('/services/export', async (req, res) => {
  try {
    let { search = '', parent = '' } = req.query;
    const query = {};
    if (search) {
      query.name = { $regex: search, $options: 'i' };
    }
    if (parent && parent !== 'all') {
      query.parentId = parent;
    }
    const services = await Service.find(query).populate('parentId').sort({ createdAt: -1 }).lean();
    const fields = [
      { label: 'Name', value: 'name' },
      { label: 'Description', value: 'description' },
      { label: 'Parent Service', value: row => row.parentId && row.parentId.name ? row.parentId.name : '' },
      { label: 'Price', value: 'price' },
      { label: 'Created', value: row => row.createdAt ? new Date(row.createdAt).toLocaleString() : '' },
    ];
    const parser = new Json2csvParser({ fields });
    const csv = parser.parse(services);
    res.header('Content-Type', 'text/csv');
    res.attachment('services_export.csv');
    return res.send(csv);
  } catch (error) {
    console.error('Error exporting services:', error);
    res.status(500).send('Failed to export services');
  }
});
router.get('/services/new', async (req, res) => {
  // Get all services that can be parents (including existing submenus)
  const parentServices = await Service.find({});
  const activeCurrency = await Currency.findOne({ isActive: true }) || { symbol: '$', code: 'USD' };
  res.render('admin/service_form', { service: {}, parentServices, currency: activeCurrency });
});
router.post('/services/new', async (req, res) => {
  try {
    const { name, description, parentId, price } = req.body;
    
    // Validate input
    if (!name || name.trim() === '') {
      req.session.error = 'Service name is required';
      return res.redirect('/admin/services/new');
    }
    
    const serviceData = { 
      name: name.trim(), 
      description: description ? description.trim() : '',
      parentId: parentId || null
    };
    
    // Add price if provided and valid
    if (price && !isNaN(parseFloat(price)) && parseFloat(price) >= 0) {
      serviceData.price = parseFloat(price);
    }
    
    console.log('Creating service with data:', serviceData);
    await Service.create(serviceData);
    req.session.success = 'Service created successfully';
  } catch (error) {
    console.error('Error creating service:', error);
    req.session.error = 'Failed to create service: ' + (error.message || 'Unknown error');
  }
  res.redirect('/admin/services');
});

// Apply ObjectId validation to service routes with IDs
router.get('/services/:id/edit', validateObjectId, async (req, res) => {
  try {
    const service = await Service.findById(req.params.id);
    if (!service) {
      req.session.error = 'Service not found';
      return res.redirect('/admin/services');
    }
    
    // Get all services that can be parents (excluding the current service to prevent circular references)
    const parentServices = await Service.find({ 
      _id: { $ne: service._id }
    });
    
    const activeCurrency = await Currency.findOne({ isActive: true }) || { symbol: '$', code: 'USD' };
    res.render('admin/service_form', { 
      service: service.toJSON(),
      parentServices,
      currency: activeCurrency
    });
  } catch (error) {
    console.error('Error fetching service for edit:', error);
    req.session.error = 'Error loading service details';
    res.redirect('/admin/services');
  }
});

router.post('/services/:id/edit', validateObjectId, async (req, res) => {
  try {
    const { name, description, parentId, price } = req.body;
    
    // Validate input
    if (!name || name.trim() === '') {
      req.session.error = 'Service name is required';
      return res.redirect(`/admin/services/${req.params.id}/edit`);
    }
    
    const updateData = { 
      name: name.trim(), 
      description: description ? description.trim() : '',
      parentId: parentId || null
    };
    
    // Handle price update
    if (price && !isNaN(parseFloat(price)) && parseFloat(price) >= 0) {
      updateData.price = parseFloat(price);
    } else if (price === '' || price === null || price === undefined) {
      // If price is empty, remove it from the document
      updateData.$unset = { price: 1 };
    }
    
    console.log('Updating service with data:', updateData);
    await Service.findByIdAndUpdate(req.params.id, updateData);
    req.session.success = 'Service updated successfully';
  } catch (error) {
    console.error('Error updating service:', error);
    req.session.error = 'Failed to update service: ' + (error.message || 'Unknown error');
  }
  res.redirect('/admin/services');
});

router.post('/services/:id/delete', validateObjectId, async (req, res) => {
  const result = await Service.findByIdAndDelete(req.params.id);
  if (!result) return res.status(404).send('Service not found');
  res.redirect('/admin/services');
});

// Orders management
router.get('/orders', async (req, res) => {
  try {
    let { page = 1, pageSize = 10, search = '', status = '' } = req.query;
    page = parseInt(page) || 1;
    pageSize = parseInt(pageSize) || 10;
    const query = {};
    if (search) {
      query.$or = [
        { userId: { $regex: search, $options: 'i' } },
        { serviceName: { $regex: search, $options: 'i' } },
      ];
      if (/^[a-fA-F0-9]{24}$/.test(search)) {
        query.$or.push({ _id: search });
      }
    }
    if (status && status !== 'all') {
      query.status = status;
    }
    const totalOrders = await Order.countDocuments(query);
    const { getServiceBreadcrumb } = await import('../serviceUtils.js');
    const orders = await Order.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .populate('serviceId', 'name price')
      .lean();
    for (const order of orders) {
      if (order.serviceId) {
        const breadcrumbArr = await getServiceBreadcrumb(order.serviceId);
        order.breadcrumb = Array.isArray(breadcrumbArr) ? breadcrumbArr.join(' > ') : '';
      }
    }
    const activeCurrency = await Currency.findOne({ isActive: true }) || { symbol: '$', code: 'USD' };
    res.render('admin/orders', {
      orders,
      currency: activeCurrency,
      formatPrice,
      pagination: {
        page,
        pageSize,
        totalOrders,
        totalPages: Math.ceil(totalOrders / pageSize),
        search,
        status
      },
      statusOptions: ['all', 'pending', 'processing', 'completed', 'cancelled']
    });
  } catch (error) {
    console.error('Error fetching orders:', error);
    req.session.error = 'Failed to load orders';
    res.redirect('/admin/dashboard');
  }
});

// Bulk actions for orders (export/delete)
router.post('/orders/bulk-action', async (req, res) => {
  console.log('[BulkAction Debug] req.body:', req.body);
  console.log('[BulkAction Debug] typeof req.body.orderIds:', typeof req.body.orderIds);
  console.log('[BulkAction Debug] Array.isArray(req.body.orderIds):', Array.isArray(req.body.orderIds));
  try {
    const { bulkAction, orderIds } = req.body;
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      req.session.error = 'No orders selected.';
      return res.redirect('/admin/orders');
    }
    if (bulkAction === 'export') {
      const orders = await Order.find({ _id: { $in: orderIds } }).populate('serviceId').lean();
      const fields = [
        { label: 'Order ID', value: '_id' },
        { label: 'Customer', value: 'userId' },
        { label: 'Service', value: row => row.serviceId && row.serviceId.name ? row.serviceId.name : row.serviceName || '' },
        { label: 'Price', value: 'price' },
        { label: 'Status', value: 'status' },
        { label: 'Created', value: row => row.createdAt ? new Date(row.createdAt).toLocaleString() : '' },
      ];
      const parser = new Json2csvParser({ fields });
      const csv = parser.parse(orders);
      res.header('Content-Type', 'text/csv');
      res.attachment('orders_export_selected.csv');
      return res.send(csv);
    } else if (bulkAction === 'delete') {
      await Order.deleteMany({ _id: { $in: orderIds } });
      req.session.success = `Deleted ${orderIds.length} order(s).`;
      return res.redirect('/admin/orders');
    } else {
      req.session.error = 'Invalid bulk action.';
      return res.redirect('/admin/orders');
    }
  } catch (error) {
    console.error('Bulk action error:', error);
    req.session.error = 'Bulk action failed.';
    res.redirect('/admin/orders');
  }
});

// CSV Export for orders
router.get('/orders/export', async (req, res) => {
  try {
    let { search = '', status = '' } = req.query;
    const query = {};
    if (search) {
      query.$or = [
        { userId: { $regex: search, $options: 'i' } },
        { serviceName: { $regex: search, $options: 'i' } },
      ];
      if (/^[a-fA-F0-9]{24}$/.test(search)) {
        query.$or.push({ _id: search });
      }
    }
    if (status && status !== 'all') {
      query.status = status;
    }
    const orders = await Order.find(query).sort({ createdAt: -1 }).lean();
    const fields = [
      { label: 'Order ID', value: row => row._id.toString() },
      { label: 'User ID', value: 'userId' },
      { label: 'Service Name', value: 'serviceName' },
      { label: 'Price', value: 'price' },
      { label: 'Status', value: 'status' },
      { label: 'Created At', value: row => row.createdAt ? new Date(row.createdAt).toLocaleString() : '' },
    ];
    const parser = new Json2csvParser({ fields });
    const csv = parser.parse(orders);
    res.header('Content-Type', 'text/csv');
    res.attachment('orders_export.csv');
    return res.send(csv);
  } catch (error) {
    console.error('Error exporting orders:', error);
    res.status(500).send('Failed to export orders');
  }
});

router.get('/orders/:id', validateObjectId, async (req, res) => {
  try {
    console.log('Fetching order with ID:', req.params.id);
    
    console.log('Fetching order with ID:', req.params.id);
    
    // First try to find the order with all fields
    let order = await Order.findById(req.params.id).lean();
    
    if (!order) {
      console.log('Order not found, trying with different query...');
      // Try with a more permissive query to see if we can find it
      order = await Order.findOne({ _id: req.params.id }).lean();
    }
    
    // If still not found, try to find by string ID match
    if (!order) {
      console.log('Order still not found, trying string ID match...');
      order = await Order.findOne({ _id: req.params.id.toString() }).lean();
    }
    
    // If we have the order but it's missing adminReplies, update it
    if (order && !order.adminReplies) {
      console.log('Order found but missing adminReplies, updating...');
      order = await Order.findByIdAndUpdate(
        order._id,
        { $set: { adminReplies: [] } },
        { new: true }
      ).lean();
    }
    
    console.log('Final order data:', {
      _id: order?._id,
      message: order?.message,
      adminRepliesCount: order?.adminReplies?.length || 0,
      hasServiceId: !!order?.serviceId
    });
    
    if (!order) {
      console.log('Order not found');
      req.session.error = 'Order not found';
      return res.redirect('/admin/orders');
    }
    
    console.log('Order found:', {
      _id: order._id,
      userId: order.userId,
      adminRepliesCount: order.adminReplies ? order.adminReplies.length : 0,
      hasMessage: !!order.message,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt
    });
    
    // Ensure adminReplies exists (no need to save since we're using lean())
    if (!order.adminReplies) {
      order.adminReplies = [];
    }
    
    // Get any flash messages from session
    const { error, success } = req.session || {};
    
    // Clear the flash messages from session
    if (req.session) {
      delete req.session.error;
      delete req.session.success;
    }
    
    // Sort adminReplies by timestamp (oldest first) - order is already a plain object from .lean()
    const sortedOrder = { ...order }; // Create a copy to avoid mutating the original
    if (sortedOrder.adminReplies && Array.isArray(sortedOrder.adminReplies)) {
      console.log('Sorting', sortedOrder.adminReplies.length, 'replies');
      sortedOrder.adminReplies.sort((a, b) => {
        const dateA = a.timestamp instanceof Date ? a.timestamp : new Date(a.timestamp);
        const dateB = b.timestamp instanceof Date ? b.timestamp : new Date(b.timestamp);
        return dateA - dateB;
      });
    }
    
    console.log('Rendering chat view with order:', {
      _id: sortedOrder._id,
      hasMessage: !!sortedOrder.message,
      adminRepliesCount: sortedOrder.adminReplies ? sortedOrder.adminReplies.length : 0,
      adminReplies: sortedOrder.adminReplies ? sortedOrder.adminReplies.map(r => ({
        message: r.message ? r.message.substring(0, 30) + '...' : 'empty',
        timestamp: r.timestamp
      })) : 'none'
    });
    
    // Fetch active quick replies for dynamic rendering
    let quickReplies = [];
    try {
      quickReplies = await QuickReply.find({ isActive: true }).sort({ order: 1, label: 1 });
    } catch (e) {
      console.error('Error fetching quick replies:', e);
    }

    // Fetch full service category breadcrumb for this order
    let orderServiceBreadcrumb = [];
    if (sortedOrder.serviceId) {
      // Use getServiceBreadcrumb util
      const { getServiceBreadcrumb } = await import('../serviceUtils.js');
      orderServiceBreadcrumb = await getServiceBreadcrumb(sortedOrder.serviceId);
    }

    const activeCurrency = await Currency.findOne({ isActive: true }) || { symbol: '$', code: 'USD' };
    res.render('admin/chat', { 
      order: sortedOrder,
      error,
      success,
      quickReplies,
      currency: activeCurrency,
      orderServiceBreadcrumb
    });
  } catch (error) {
    console.error('Error fetching order:', error);
    req.session.error = 'Error loading order';
    res.redirect('/admin/orders');
  }
});

// Change order status
router.post('/orders/:id/status', validateObjectId, async (req, res) => {
  const orderId = req.params.id;
  const { status } = req.body;
  const redirectUrl = `/admin/orders/${orderId}`;

  // Validate status
  const allowedStatuses = ['pending', 'processing', 'completed', 'cancelled'];
  if (!allowedStatuses.includes(status)) {
    req.session.error = 'Invalid status selected.';
    return res.redirect(redirectUrl);
  }

  try {
    const order = await Order.findById(orderId);
    if (!order) {
      req.session.error = 'Order not found.';
      return res.redirect('/admin/orders');
    }
    order.status = status;
    order.updatedAt = new Date();
    await order.save();
    req.session.success = `Order status updated to '${status}'.`;
  } catch (error) {
    console.error('Error updating order status:', error);
    req.session.error = 'Failed to update order status.';
  }
  res.redirect(redirectUrl);
});

// Reply to user
router.post('/orders/:id/reply', validateObjectId, async (req, res) => {
  const redirectUrl = `/admin/orders/${req.params.id}`;
  
  try {
    const { reply } = req.body;
    console.log('Received reply:', { reply, params: req.params });
    
    // Input validation
    if (!reply || typeof reply !== 'string' || reply.trim() === '') {
      req.session.error = 'Please enter a valid message';
      return res.redirect(redirectUrl);
    }
    
    const trimmedReply = reply.trim();
    const orderId = req.params.id;
    
    // Get the client instance
    const client = req.app.get('whatsappClient');
    console.log('WhatsApp client status:', {
      exists: !!client,
      hasUser: !!(client && client.user),
      clientType: typeof client,
      clientKeys: client ? Object.keys(client) : 'none'
    });
    
    if (!client) {
      console.error('WhatsApp client not found in app');
      req.session.error = 'WhatsApp client is not connected';
      return res.redirect(redirectUrl);
    }
    
    // Find the order to get the user ID
    const order = await Order.findById(orderId);
    if (!order) {
      console.log('Order not found for ID:', orderId);
      req.session.error = 'Order not found';
      return res.redirect('/admin/orders');
    }
    
    console.log('Processing reply for order:', { 
      orderId: order._id,
      userId: order.userId,
      existingReplies: order.adminReplies ? order.adminReplies.length : 0
    });
    
    // Create the reply object with admin info
    const newReply = {
      message: trimmedReply,
      timestamp: new Date(),
      isCustomer: false,  // Mark as admin reply
      adminId: req.user ? req.user._id : 'system' // Track which admin sent the message
    };
    
    console.log('Adding reply to order:', newReply);
    
    // Update the order with the new reply and ensure status is processing
    const updateData = {
      $push: { adminReplies: newReply },
      $set: { 
        status: 'processing',
        updatedAt: new Date()
      }
    };

    const updatedOrder = await Order.findOneAndUpdate(
      { _id: orderId },
      updateData,
      { new: true, runValidators: true }
    );
    
    if (!updatedOrder) {
      console.error('Failed to update order with new reply');
      throw new Error('Failed to save reply');
    }
    
    console.log('Reply saved successfully. Updated order:', {
      _id: updatedOrder._id,
      adminRepliesCount: updatedOrder.adminReplies ? updatedOrder.adminReplies.length : 0,
      latestReply: updatedOrder.adminReplies && updatedOrder.adminReplies.length > 0 
        ? updatedOrder.adminReplies[updatedOrder.adminReplies.length - 1] 
        : 'none'
    });
    
    // Send message via WhatsApp
    try {
      const messageContent = { 
        text: `📨 Admin Reply (Order #${order._id.toString().slice(-8)})\n\n${trimmedReply}\n\nPlease reply to this message if you have any questions.\n\nType 'close' to end this conversation.` 
      };
      
      console.log('Attempting to send WhatsApp message:', {
        userId: order.userId,
        messageContent,
        clientMethods: client ? Object.getOwnPropertyNames(client) : 'none'
      });
      
      // Try different ways to send the message
      let result = null;
      if (client.safeSendMessage) {
        console.log('Using client.safeSendMessage');
        result = await client.safeSendMessage(order.userId, messageContent);
      } else if (client.sendMessage) {
        console.log('Using client.sendMessage');
        result = await client.sendMessage(order.userId, messageContent);
      } else {
        console.error('No sendMessage method found on client');
        throw new Error('sendMessage method not available');
      }
      
      req.session.success = 'Message sent successfully';
      
      // Log the successful message sending
      console.log('Admin message sent to user:', {
        orderId: order._id,
        userId: order.userId,
        message: trimmedReply,
        result: result ? 'success' : 'unknown'
      });
    } catch (whatsappError) {
      console.error('Error sending WhatsApp message:', whatsappError);
      req.session.warning = 'Reply saved but could not be sent via WhatsApp';
    }
    
    res.redirect(redirectUrl);
    
  } catch (error) {
    console.error('Error in reply route:', error);
    req.session.error = 'Error processing your request: ' + (error.message || 'Unknown error');
    res.redirect(redirectUrl);
  }
});

// Currencies management

// View and edit settings (currencies & quick replies)

async function renderSettings(req, res) {
  let currencies = [];
  let quickReplies = [];
  let smsSettings = { apiKey: '', sender: '', recipient: '' };
  let error = req.session.error || null;
  let success = req.session.success || null;
  try {
    currencies = await Currency.find().sort({ isActive: -1, code: 1 });
    if (!currencies || currencies.length === 0) {
      console.warn('[Settings] No currencies found in database.');
      error = (error ? error + ' ' : '') + 'No currencies found.';
    }
  } catch (e) {
    console.error('[Settings] Error loading currencies:', e);
    error = (error ? error + ' ' : '') + 'Failed to load currencies.';
  }
  try {
    quickReplies = await QuickReply.find().sort({ order: 1, label: 1 });
    if (!quickReplies || quickReplies.length === 0) {
      console.warn('[Settings] No quick replies found in database.');
      error = (error ? error + ' ' : '') + 'No quick replies found.';
    }
  } catch (e) {
    console.error('[Settings] Error loading quick replies:', e);
    error = (error ? error + ' ' : '') + 'Failed to load quick replies.';
  }
  try {
    if (!fs.existsSync(smsSettingsPath)) {
      fs.writeFileSync(smsSettingsPath, JSON.stringify(smsSettings, null, 2));
    }
    smsSettings = JSON.parse(fs.readFileSync(smsSettingsPath, 'utf8'));
  } catch (e) {
    console.error('[Settings] Error loading smsSettings.json:', e);
    error = (error ? error + ' ' : '') + 'Failed to load SMS settings.';
  }
  req.session.success = null;
  req.session.error = null;
  res.render('admin/settings', { currencies, quickReplies, smsSettings, success, error });
}
router.get('/settings', renderSettings);

// Save SMS settings
router.post('/sms-settings', async (req, res) => {
  try {
    const { apiKey, sender, recipient } = req.body;
    const data = { apiKey, sender, recipient };
    try {
      fs.writeFileSync(smsSettingsPath, JSON.stringify(data, null, 2));
      req.session.success = 'SMS settings updated.';
      return res.redirect('/admin/settings');
    } catch (writeErr) {
      console.error('[Settings] Error saving smsSettings.json:', writeErr);
      req.session.error = 'Failed to save SMS settings.';
      return await renderSettings(req, res);
    }
  } catch (e) {
    console.error('[Settings] Unexpected error in SMS settings POST:', e);
    req.session.error = 'Failed to save SMS settings.';
    return await renderSettings(req, res);
  }
});

// Debug: test POST route
router.post('/currencies/test', (req, res) => {
  res.send('Currencies POST test OK');
});

// Add currency
router.post('/currencies', async (req, res) => {
  try {
    const { code, symbol, name, rate } = req.body;
    await Currency.create({ code, symbol, name, rate: parseFloat(rate) || 1 });
    req.session.success = 'Currency added.';
    return res.redirect('/admin/settings');
  } catch (e) {
    req.session.error = 'Failed to add currency.';
    return await renderSettings(req, res);
  }
});
// Edit currency
router.post('/currencies/:id/edit', async (req, res) => {
  try {
    const { code, symbol, name, rate, isActive } = req.body;
    await Currency.findByIdAndUpdate(req.params.id, { code, symbol, name, rate: parseFloat(rate) || 1, isActive: isActive === 'on' });
    req.session.success = 'Currency updated.';
    return res.redirect('/admin/settings');
  } catch (e) {
    req.session.error = 'Failed to update currency.';
    return await renderSettings(req, res);
  }
});
// Delete currency
router.post('/currencies/:id/delete', async (req, res) => {
  try {
    await Currency.findByIdAndDelete(req.params.id);
    req.session.success = 'Currency deleted.';
    return res.redirect('/admin/settings');
  } catch (e) {
    req.session.error = 'Failed to delete currency.';
    return await renderSettings(req, res);
  }
});

// Add quick reply
router.post('/quick-replies', async (req, res) => {
  try {
    const { label, message, order } = req.body;
    await QuickReply.create({ label, message, order: parseInt(order) || 0 });
    req.session.success = 'Quick reply added.';
    return res.redirect('/admin/settings');
  } catch (e) {
    req.session.error = 'Failed to add quick reply.';
    return await renderSettings(req, res);
  }
});
// Edit quick reply
router.post('/quick-replies/:id/edit', async (req, res) => {
  try {
    const { label, message, order, isActive } = req.body;
    await QuickReply.findByIdAndUpdate(req.params.id, { label, message, order: parseInt(order) || 0, isActive: isActive === 'on' });
    req.session.success = 'Quick reply updated.';
    return res.redirect('/admin/settings');
  } catch (e) {
    req.session.error = 'Failed to update quick reply.';
    return await renderSettings(req, res);
  }
});
// Delete quick reply
router.post('/quick-replies/:id/delete', async (req, res) => {
  try {
    await QuickReply.findByIdAndDelete(req.params.id);
    req.session.success = 'Quick reply deleted.';
    return res.redirect('/admin/settings');
  } catch (e) {
    req.session.error = 'Failed to delete quick reply.';
    return await renderSettings(req, res);
  }
});

// API endpoint for stats
router.get('/api/stats', async (req, res) => {
  try {
    const servicesCount = await Service.countDocuments();
    const ordersCount = await Order.countDocuments();
    res.json({ services: servicesCount, orders: ordersCount });
  } catch (error) {
    res.json({ services: 0, orders: 0 });
  }
});

export default router;
