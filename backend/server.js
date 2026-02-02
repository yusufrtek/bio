import express from "express";
import cors from "cors";
import admin from "firebase-admin";

const app = express();
app.use(cors({ origin: "*", allowedHeaders: ["Content-Type", "Authorization", "X-Admin-Key"] }));
app.use(express.json());

const ADMIN_KEY = process.env.ADMIN_KEY || "CHANGE_ME";

function initFirebase() {
  if (admin.apps.length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON missing");
  const sa = JSON.parse(raw);

  admin.initializeApp({
    credential: admin.credential.cert(sa),
    databaseURL: "https://maps-52b00-default-rtdb.europe-west1.firebasedatabase.app"
  });
}

function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: "unauthorized" });
  next();
}

app.get("/", (req, res) =>
  res.json({ ok: true, service: "news-push-api", routes: ["/ping", "/register-token", "/admin/send"] })
);
app.get("/ping", (req, res) => res.json({ ok: true }));

// Kullanıcı token kaydı + "all" topic subscribe
app.post("/register-token", async (req, res) => {
  try {
    initFirebase();
    const token = String(req.body?.token || "").trim();
    const uid = String(req.body?.uid || "anon").trim() || "anon";
    if (!token) return res.status(400).json({ error: "missing token" });

    const hash = Buffer.from(token).toString("base64").slice(0, 40).replace(/[^a-zA-Z0-9]/g, "");
    await admin.database().ref(`tokens/${uid}/${hash}`).set({ token, createdAt: Date.now() });

    const sub = await admin.messaging().subscribeToTopic([token], "all");
    return res.json({ ok: true, subscribed: sub.successCount, uid });
  } catch (e) {
    return res.status(500).json({ error: "server error", detail: String(e.message || e) });
  }
});

// Admin panel: topic'e push gönder
app.post("/admin/send", requireAdmin, async (req, res) => {
  try {
    initFirebase();

    const title = String(req.body?.title || "").slice(0, 80) || "Son Dakika";
    const body = String(req.body?.body || "").slice(0, 140) || "";
    const url = String(req.body?.url || "").slice(0, 400) || "/";

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
  } catch (e) {
    return res.status(500).json({ error: "send failed", detail: String(e.message || e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Backend running on", PORT));
