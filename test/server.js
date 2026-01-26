const express = require("express");
const cors = require("cors");

const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(express.json());

// Firebase Admin init
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL
});

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Render backend çalışıyor 🎉" });
});

// 1) Sipariş oluştur: Firebase'e yazar
app.post("/create-order", async (req, res) => {
  try {
    const { items, customer } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items boş olamaz" });
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

// 2) Ödeme başlat (şimdilik test linki dönüyor)
app.post("/start-payment", async (req, res) => {
  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ error: "orderId zorunlu" });

  const paymentUrl = "https://example.com/pay?orderId=" + orderId;

  await admin.database().ref(`orders/${orderId}`).update({
    status: "PAYMENT_STARTED",
    paymentUrl,
    updatedAt: Date.now()
  });

  res.json({ paymentUrl });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
