const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET_KEY || 'default_admin_secret';

// Firebase Admin SDK initialization
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://maps-52b00-default-rtdb.europe-west1.firebasedatabase.app'
});

const db = admin.database();

app.use(cors());
app.use(express.json());

// Admin middleware
const adminAuth = (req, res, next) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== ADMIN_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  next();
};

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'FETİH SAAT API Running', timestamp: new Date().toISOString() });
});

// ===== PRODUCTS =====

// Get all products (public)
app.get('/products', async (req, res) => {
  try {
    const snapshot = await db.ref('products').once('value');
    const products = [];
    snapshot.forEach((child) => {
      if (child.val().active) {
        products.push({ id: child.key, ...child.val() });
      }
    });
    res.json({ products });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Get all products
app.get('/admin/products', adminAuth, async (req, res) => {
  try {
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
    const { name, priceTRY, imageUrl, description, active } = req.body;
    const productRef = db.ref('products').push();
    await productRef.set({
      name,
      priceTRY: parseFloat(priceTRY),
      imageUrl: imageUrl || '',
      description: description || '',
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
    const { id } = req.params;
    await db.ref(`products/${id}`).update(req.body);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Delete product
app.delete('/admin/products/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await db.ref(`products/${id}`).remove();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== COUPONS =====

// Admin: Get all coupons
app.get('/admin/coupons', adminAuth, async (req, res) => {
  try {
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
    const { code, type, value, active } = req.body;
    await db.ref(`coupons/${code}`).set({
      type, // "percent" or "fixed"
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
    const { code } = req.params;
    await db.ref(`coupons/${code}`).remove();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== ORDERS =====

// Create order (public)
app.post('/create-order', async (req, res) => {
  try {
    const { items, customer, couponCode } = req.body;
    
    // Calculate total from Firebase products
    let totalTRY = 0;
    for (const item of items) {
      const productSnap = await db.ref(`products/${item.productId}`).once('value');
      const product = productSnap.val();
      if (product && product.active) {
        totalTRY += product.priceTRY * item.qty;
      }
    }

    // Apply coupon if provided
    let discountTRY = 0;
    if (couponCode) {
      const couponSnap = await db.ref(`coupons/${couponCode}`).once('value');
      const coupon = couponSnap.val();
      if (coupon && coupon.active) {
        if (coupon.type === 'percent') {
          discountTRY = totalTRY * (coupon.value / 100);
        } else if (coupon.type === 'fixed') {
          discountTRY = coupon.value;
        }
      }
    }

    totalTRY = Math.max(0, totalTRY - discountTRY);

    // Save order
    const orderRef = db.ref('orders').push();
    await orderRef.set({
      items,
      customer,
      status: 'PENDING',
      totalTRY,
      discountTRY,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    res.json({
      orderId: orderRef.key,
      status: 'PENDING',
      totalTRY,
      discountTRY
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start payment (public)
app.post('/start-payment', async (req, res) => {
  try {
    const { orderId } = req.body;
    const orderSnap = await db.ref(`orders/${orderId}`).once('value');
    const order = orderSnap.val();
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Update order status
    await db.ref(`orders/${orderId}`).update({
      status: 'PAYMENT_STARTED',
      updatedAt: new Date().toISOString()
    });

    // In production, integrate with PayTR here
    // For now, return a placeholder URL
    const paymentUrl = `https://www.paytr.com/odeme/test?order=${orderId}&amount=${order.totalTRY}`;

    await db.ref(`orders/${orderId}`).update({ paymentUrl });

    res.json({ paymentUrl });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Get all orders
app.get('/admin/orders', adminAuth, async (req, res) => {
  try {
    const snapshot = await db.ref('orders').once('value');
    const orders = [];
    snapshot.forEach((child) => {
      orders.push({ id: child.key, ...child.val() });
    });
    res.json({ count: orders.length, orders });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Update order status
app.post('/admin/orders/:id/status', adminAuth, async (req, res) => {
  try {
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
