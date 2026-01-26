// test/server.js
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(express.json());

// ===== Firebase Admin init (Realtime Database) =====
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "{}");
if (!serviceAccount.project_id) {
  console.warn("⚠️ FIREBASE_SERVICE_ACCOUNT_JSON eksik/yanlış görünüyor.");
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL
});

// ===== Basic health check =====
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Render backend çalışıyor 🎉" });
});

// ===== Create order (writes to RTDB) =====
app.post("/create-order", async (req, res) => {
  try {
    const { items, customer } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items boş olamaz" });
    }

    // Basit doğrulama
    for (const it of items) {
      if (!it || typeof it.productId !== "string" || !it.productId.trim()) {
        return res.status(400).json({ error: "items[].productId zorunlu" });
      }
      const qty = Number(it.qty);
      if (!Number.isFinite(qty) || qty <= 0) {
        return res.status(400).json({ error: "items[].qty > 0 olmalı" });
      }
    }

    const orderRef = admin.database().ref("orders").push();
    const orderId = orderRef.key;

    await orderRef.set({
      items,
      customer: customer || {},
      status: "PENDING",
      createdAt: Date.now()
    });

    res.json({ orderId, status: "PENDING" });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ===== Start payment (updates order + returns paymentUrl) =====
app.post("/start-payment", async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: "orderId zorunlu" });

    // Sipariş var mı kontrol et
    const snap = await admin.database().ref(`orders/${orderId}`).get();
    if (!snap.exists()) return res.status(404).json({ error: "Sipariş bulunamadı" });

    // Şimdilik sahte ödeme linki
    const paymentUrl = "https://example.com/pay?orderId=" + encodeURIComponent(orderId);

    await admin.database().ref(`orders/${orderId}`).update({
      status: "PAYMENT_STARTED",
      paymentUrl,
      updatedAt: Date.now()
    });

    res.json({ paymentUrl });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ===== Admin: list last orders =====
app.get("/admin/orders", async (req, res) => {
  try {
    const snap = await admin.database().ref("orders").limitToLast(50).get();
    const val = snap.val() || {};
    const list = Object.entries(val).map(([id, o]) => ({ id, ...o }));
    list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json({ count: list.length, orders: list });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ===== Admin: manually set status (TEST ONLY) =====
app.post("/admin/orders/:id/status", async (req, res) => {
  try {
    const id = req.params.id;
    const { status } = req.body;

    if (!status) return res.status(400).json({ error: "status zorunlu" });

    await admin.database().ref(`orders/${id}`).update({
      status: String(status).toUpperCase(),
      updatedAt: Date.now()
    });

    res.json({ ok: true, id, status: String(status).toUpperCase() });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ===== Start server (Render PORT) =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
