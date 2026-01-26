const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

// Ana test endpoint
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Render backend çalışıyor 🎉"
  });
});

// Sahte ödeme başlatma endpoint'i
app.post("/start-payment", (req, res) => {
  const { orderId } = req.body;

  if (!orderId) {
    return res.status(400).json({ error: "orderId zorunlu" });
  }

  res.json({
    paymentUrl: "https://example.com/pay?orderId=" + orderId
  });
});

// ⚠️ Render için şart
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
