import express from "express";
import cors from "cors";
import admin from "firebase-admin";

const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Admin-Key"]
}));
app.options("*", cors());
app.use(express.json());

const ADMIN_KEY = process.env.ADMIN_KEY || "ertek123";

function initFirebase() {
  if (admin.apps.length) return;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON missing");

  const serviceAccount = JSON.parse(raw);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://backend-6782d-default-rtdb.europe-west1.firebasedatabase.app"
  });
}

function withTimeout(promise, ms = 8000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))
  ]);
}

function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: "unauthorized" });
  next();
}

// root
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "news-push-api",
    routes: ["/ping", "/register-token", "/admin/add-tweet", "/admin/send"]
  });
});

app.get("/ping", (req, res) => res.json({ ok: true }));

// token register + topic subscribe
app.post("/register-token", async (req, res) => {
  try {
    initFirebase();

    const token = String(req.body?.token || "").trim();
    const uid = String(req.body?.uid || "web").trim() || "web";
    if (!token) return res.status(400).json({ error: "missing token" });

    const hash = Buffer.from(token).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 40);

    await withTimeout(
      admin.database().ref(`tokens/${uid}/${hash}`).set({ token, createdAt: Date.now() }),
      8000
    );

    const sub = await admin.messaging().subscribeToTopic([token], "all");
    return res.json({ ok: true, uid, subscribed: sub.successCount });
  } catch (err) {
    console.error("register-token error:", err);
    return res.status(500).json({ error: "register-token failed", detail: String(err.message || err) });
  }
});

// ✅ NEW: admin tweet add (writes RTDB via service account)
app.post("/admin/add-tweet", requireAdmin, async (req, res) => {
  try {
    initFirebase();

    const embedHtml = String(req.body?.embedHtml || "").trim();
    const createdAt = Number(req.body?.createdAt || Date.now());
    if (!embedHtml) return res.status(400).json({ error: "missing embedHtml" });

    const id =
      String(req.body?.id || "").trim() ||
      ("tweet_" + Date.now() + "_" + Math.random().toString(16).slice(2, 8));

    await withTimeout(
      admin.database().ref(`tweets/${id}`).set({ embedHtml, createdAt }),
      8000
    );

    return res.json({ ok: true, id });
  } catch (err) {
    console.error("add-tweet error:", err);
    return res.status(500).json({ error: "add-tweet failed", detail: String(err.message || err) });
  }
});

// admin send push
app.post("/admin/send", requireAdmin, async (req, res) => {
  try {
    initFirebase();

    const title = String(req.body?.title || "Son Dakika").slice(0, 80);
    const body = String(req.body?.body || "").slice(0, 140);
    const url = String(req.body?.url || "/").slice(0, 400);

    const message = {
      topic: "all",
      notification: { title, body },
      data: { url },
      webpush: {
        fcmOptions: { link: url },
        notification: { icon: "/icon-192.png", badge: "/icon-192.png" }
      }
    };

    const id = await admin.messaging().send(message);
    return res.json({ ok: true, id });
  } catch (err) {
    console.error("admin/send error:", err);
    return res.status(500).json({ error: "send failed", detail: String(err.message || err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Backend running on port", PORT));
