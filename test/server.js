const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET_KEY || 'default_admin_secret';

// Firebase Admin SDK initialization
let db;
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    
    if (serviceAccount.project_id) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: `https://${serviceAccount.project_id}-default-rtdb.europe-west1.firebasedatabase.app`
        });
        db = admin.database();
        console.log('Firebase initialized successfully');
    } else {
        console.log('Firebase service account not configured');
    }
} catch (error) {
    console.error('Firebase initialization error:', error.message);
}

app.use(cors());
app.use(express.json());

// Admin middleware
const adminAuth = (req, res, next) => {
    const adminKey = req.headers['x-admin-key'];
    if (adminKey !== ADMIN_SECRET) {
        return res.status(403).json({ error: 'Yetkisiz erisim' });
    }
    next();
};

// Health check
app.get('/', (req, res) => {
    res.json({ 
        status: 'ok', 
        message: 'FETİH SAAT API Calisiyor', 
        timestamp: new Date().toISOString(),
        firebase: db ? 'connected' : 'not configured'
    });
});

// ===== PUBLIC ENDPOINTS =====

// Get all active products (public)
app.get('/products', async (req, res) => {
    try {
        if (!db) return res.json({ products: [] });
        
        const snapshot = await db.ref('products').once('value');
        const products = [];
        snapshot.forEach((child) => {
            const product = child.val();
            if (product.active !== false) {
                products.push({ id: child.key, ...product });
            }
        });
        res.json({ products });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get all categories (public)
app.get('/categories', async (req, res) => {
    try {
        if (!db) return res.json({ categories: [] });
        
        const snapshot = await db.ref('categories').once('value');
        const categories = [];
        snapshot.forEach((child) => {
            const category = child.val();
            if (category.active !== false) {
                categories.push({ id: child.key, ...category });
            }
        });
        // Sort by order if available
        categories.sort((a, b) => (a.order || 0) - (b.order || 0));
        res.json({ categories });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get settings (public)
app.get('/settings', async (req, res) => {
    try {
        if (!db) return res.json({ settings: { shippingCost: 50 } });
        
        const snapshot = await db.ref('settings').once('value');
        const settings = snapshot.val() || { shippingCost: 50 };
        res.json({ settings });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Validate coupon (public)
app.post('/validate-coupon', async (req, res) => {
    try {
        if (!db) return res.json({ valid: false, error: 'Database not configured' });
        
        const { code } = req.body;
        const snapshot = await db.ref(`coupons/${code}`).once('value');
        const coupon = snapshot.val();
        
        if (coupon && coupon.active) {
            res.json({ valid: true, coupon: { code, ...coupon } });
        } else {
            res.json({ valid: false, error: 'Gecersiz kupon kodu' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create order (public) - BACKEND CALCULATES PRICES
app.post('/create-order', async (req, res) => {
    try {
        if (!db) return res.status(500).json({ error: 'Database not configured' });
        
        const { items, customer, couponCode, paymentMethod } = req.body;
        
        // Get settings for shipping cost
        const settingsSnap = await db.ref('settings').once('value');
        const settings = settingsSnap.val() || { shippingCost: 50 };
        const shippingTRY = settings.shippingCost || 50;
        
        // Calculate total from Firebase prices (NOT from client)
        let subtotalTRY = 0;
        const orderItems = [];
        
        for (const item of items) {
            const productSnap = await db.ref(`products/${item.productId}`).once('value');
            const product = productSnap.val();
            if (product && product.active !== false) {
                const itemTotal = product.priceTRY * item.qty;
                subtotalTRY += itemTotal;
                orderItems.push({
                    productId: item.productId,
                    name: product.name,
                    price: product.priceTRY,
                    qty: item.qty,
                    lineTotal: itemTotal
                });
            }
        }

        // Apply coupon if provided
        let discountTRY = 0;
        if (couponCode) {
            const couponSnap = await db.ref(`coupons/${couponCode}`).once('value');
            const coupon = couponSnap.val();
            if (coupon && coupon.active) {
                if (coupon.type === 'percent') {
                    discountTRY = subtotalTRY * (coupon.value / 100);
                } else if (coupon.type === 'fixed') {
                    discountTRY = Math.min(coupon.value, subtotalTRY);
                }
            }
        }

        // Calculate final total
        const totalTRY = Math.max(0, subtotalTRY - discountTRY) + shippingTRY;

        // Generate order ID
        const orderId = 'ORD-' + Date.now().toString(36).toUpperCase();

        // Save order
        await db.ref(`orders/${orderId}`).set({
            items: orderItems,
            customer,
            couponCode: couponCode || null,
            subtotalTRY,
            discountTRY,
            shippingTRY,
            totalTRY,
            paymentMethod: paymentMethod || 'PENDING',
            status: 'PENDING',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        });

        res.json({
            orderId,
            status: 'PENDING',
            subtotalTRY,
            discountTRY,
            shippingTRY,
            totalTRY
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update order payment method (public)
app.post('/order/:id/payment-method', async (req, res) => {
    try {
        if (!db) return res.status(500).json({ error: 'Database not configured' });
        
        const { id } = req.params;
        const { paymentMethod } = req.body;
        
        const orderSnap = await db.ref(`orders/${id}`).once('value');
        if (!orderSnap.exists()) {
            return res.status(404).json({ error: 'Siparis bulunamadi' });
        }

        const newStatus = paymentMethod === 'EFT' ? 'EFT_PENDING' : 'PAYMENT_STARTED';
        
        await db.ref(`orders/${id}`).update({
            paymentMethod,
            status: newStatus,
            updatedAt: new Date().toISOString()
        });

        res.json({ success: true, status: newStatus });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Start payment (public) - PayTR integration
app.post('/start-payment', async (req, res) => {
    try {
        if (!db) return res.status(500).json({ error: 'Database not configured' });
        
        const { orderId } = req.body;
        const orderSnap = await db.ref(`orders/${orderId}`).once('value');
        const order = orderSnap.val();
        
        if (!order) {
            return res.status(404).json({ error: 'Siparis bulunamadi' });
        }

        // Update order status
        await db.ref(`orders/${orderId}`).update({
            status: 'PAYMENT_STARTED',
            paymentMethod: 'CARD',
            updatedAt: new Date().toISOString()
        });

        // PayTR entegrasyonu - ÖRNEK URL (gerçek entegrasyon için PayTR dokümantasyonuna bakın)
        // Bu URL test amaçlıdır, gerçek PayTR iframe URL'si merchant_id, merchant_key vs. ile oluşturulur
        const paymentUrl = `https://www.paytr.com/odeme/test?merchant_oid=${orderId}&payment_amount=${Math.round(order.totalTRY * 100)}`;

        await db.ref(`orders/${orderId}`).update({ paymentUrl });

        res.json({ paymentUrl, orderId });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// PayTR callback endpoint
app.post('/paytr-callback', async (req, res) => {
    try {
        const { merchant_oid, status, total_amount, hash } = req.body;
        
        // TODO: Hash doğrulama yapılmalı (PayTR dokümantasyonuna bakınız)
        
        if (status === 'success') {
            await db.ref(`orders/${merchant_oid}`).update({
                status: 'PAID',
                paidAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            });
        } else {
            await db.ref(`orders/${merchant_oid}`).update({
                status: 'FAILED',
                updatedAt: new Date().toISOString()
            });
        }
        
        res.send('OK');
    } catch (error) {
        console.error('PayTR callback error:', error);
        res.status(500).send('ERROR');
    }
});

// ===== ADMIN ENDPOINTS =====

// Admin: Get all products
app.get('/admin/products', adminAuth, async (req, res) => {
    try {
        if (!db) return res.json({ products: [] });
        
        const snapshot = await db.ref('products').once('value');
        const products = [];
        snapshot.forEach((child) => {
            products.push({ id: child.key, ...child.val() });
        });
        res.json({ products });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Admin: Add product
app.post('/admin/products', adminAuth, async (req, res) => {
    try {
        if (!db) return res.status(500).json({ error: 'Database not configured' });
        
        const { name, priceTRY, imageUrl, images, description, active, categoryId } = req.body;
        const productRef = db.ref('products').push();
        await productRef.set({
            name,
            priceTRY: parseFloat(priceTRY),
            imageUrl: imageUrl || (images && images[0]) || '',
            images: images || (imageUrl ? [imageUrl] : []),
            description: description || '',
            categoryId: categoryId || '',
            active: active !== false,
            createdAt: new Date().toISOString()
        });
        res.json({ success: true, productId: productRef.key });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Admin: Update product
app.put('/admin/products/:id', adminAuth, async (req, res) => {
    try {
        if (!db) return res.status(500).json({ error: 'Database not configured' });
        
        const { id } = req.params;
        const updates = { ...req.body, updatedAt: new Date().toISOString() };
        if (updates.priceTRY) updates.priceTRY = parseFloat(updates.priceTRY);
        
        await db.ref(`products/${id}`).update(updates);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Admin: Delete product
app.delete('/admin/products/:id', adminAuth, async (req, res) => {
    try {
        if (!db) return res.status(500).json({ error: 'Database not configured' });
        
        const { id } = req.params;
        await db.ref(`products/${id}`).remove();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Admin: Get all categories
app.get('/admin/categories', adminAuth, async (req, res) => {
    try {
        if (!db) return res.json({ categories: [] });
        
        const snapshot = await db.ref('categories').once('value');
        const categories = [];
        snapshot.forEach((child) => {
            categories.push({ id: child.key, ...child.val() });
        });
        categories.sort((a, b) => (a.order || 0) - (b.order || 0));
        res.json({ categories });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Admin: Add category
app.post('/admin/categories', adminAuth, async (req, res) => {
    try {
        if (!db) return res.status(500).json({ error: 'Database not configured' });
        
        const { id, name, image, description, order, active } = req.body;
        const categoryId = id || db.ref('categories').push().key;
        
        await db.ref(`categories/${categoryId}`).set({
            name,
            image: image || '',
            description: description || '',
            order: order || 0,
            active: active !== false,
            createdAt: new Date().toISOString()
        });
        res.json({ success: true, categoryId });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Admin: Update category
app.put('/admin/categories/:id', adminAuth, async (req, res) => {
    try {
        if (!db) return res.status(500).json({ error: 'Database not configured' });
        
        const { id } = req.params;
        await db.ref(`categories/${id}`).update({
            ...req.body,
            updatedAt: new Date().toISOString()
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Admin: Delete category
app.delete('/admin/categories/:id', adminAuth, async (req, res) => {
    try {
        if (!db) return res.status(500).json({ error: 'Database not configured' });
        
        const { id } = req.params;
        await db.ref(`categories/${id}`).remove();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Admin: Get all coupons
app.get('/admin/coupons', adminAuth, async (req, res) => {
    try {
        if (!db) return res.json({ coupons: [] });
        
        const snapshot = await db.ref('coupons').once('value');
        const coupons = [];
        snapshot.forEach((child) => {
            coupons.push({ code: child.key, ...child.val() });
        });
        res.json({ coupons });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Admin: Add coupon
app.post('/admin/coupons', adminAuth, async (req, res) => {
    try {
        if (!db) return res.status(500).json({ error: 'Database not configured' });
        
        const { code, type, value, active } = req.body;
        await db.ref(`coupons/${code}`).set({
            type,
            value: parseFloat(value),
            active: active !== false,
            createdAt: new Date().toISOString()
        });
        res.json({ success: true, code });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Admin: Delete coupon
app.delete('/admin/coupons/:code', adminAuth, async (req, res) => {
    try {
        if (!db) return res.status(500).json({ error: 'Database not configured' });
        
        const { code } = req.params;
        await db.ref(`coupons/${code}`).remove();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Admin: Get all orders
app.get('/admin/orders', adminAuth, async (req, res) => {
    try {
        if (!db) return res.json({ orders: [] });
        
        const snapshot = await db.ref('orders').once('value');
        const orders = [];
        snapshot.forEach((child) => {
            orders.push({ id: child.key, ...child.val() });
        });
        
        // Sort by date descending
        orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        
        res.json({ count: orders.length, orders });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Admin: Update order status
app.post('/admin/orders/:id/status', adminAuth, async (req, res) => {
    try {
        if (!db) return res.status(500).json({ error: 'Database not configured' });
        
        const { id } = req.params;
        const { status } = req.body;
        await db.ref(`orders/${id}`).update({
            status,
            updatedAt: new Date().toISOString()
        });
        res.json({ success: true, status });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Admin: Get settings
app.get('/admin/settings', adminAuth, async (req, res) => {
    try {
        if (!db) return res.json({ settings: { shippingCost: 50 } });
        
        const snapshot = await db.ref('settings').once('value');
        const settings = snapshot.val() || { shippingCost: 50 };
        res.json({ settings });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Admin: Save settings
app.post('/admin/settings', adminAuth, async (req, res) => {
    try {
        if (!db) return res.status(500).json({ error: 'Database not configured' });
        
        const settings = req.body;
        await db.ref('settings').update({
            ...settings,
            updatedAt: new Date().toISOString()
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`FETİH SAAT API running on port ${PORT}`);
});
