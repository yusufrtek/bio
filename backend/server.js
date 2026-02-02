import express from "express";
import cors from "cors";
import admin from "firebase-admin";

const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Admin-Key"]
}));
app.options("*", cors());
app.use(express.json({ limit: "2mb" }));

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

function slugify(input) {
  // TR karakterleri sadeleştir, URL-safe yap
  const map = {
    "ç":"c","ğ":"g","ı":"i","ö":"o","ş":"s","ü":"u",
    "Ç":"c","Ğ":"g","İ":"i","I":"i","Ö":"o","Ş":"s","Ü":"u"
  };
  const s = String(input || "")
    .split("")
    .map(ch => map[ch] ?? ch)
    .join("")
    .toLowerCase()
    .trim()
    .replace(/&/g, " ve ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return s || ("makale-" + Date.now());
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "news-api",
    routes: [
      "/ping",
      "/register-token",
      "/admin/add-tweet",
      "/admin/delete-tweet",
      "/admin/add-article",
      "/admin/delete-article",
      "/admin/send"
    ]
  });
});

app.get("/ping", (req, res) => res.json({ ok: true }));

// Push aboneliği (topic: all)
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

// ========== TWEETS ==========
app.post("/admin/add-tweet", requireAdmin, async (req, res) => {
  try {
    initFirebase();

    const embedHtml = String(req.body?.embedHtml || "").trim();
    if (!embedHtml) return res.status(400).json({ error: "missing embedHtml" });

    const id =
      String(req.body?.id || "").trim() ||
      ("tweet_" + Date.now() + "_" + Math.random().toString(16).slice(2, 8));

    const createdAt = Number(req.body?.createdAt || Date.now());

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

app.post("/admin/delete-tweet", requireAdmin, async (req, res) => {
  try {
    initFirebase();
    const id = String(req.body?.id || "").trim();
    if (!id) return res.status(400).json({ error: "missing id" });

    await withTimeout(admin.database().ref(`tweets/${id}`).remove(), 8000);
    return res.json({ ok: true, id });
  } catch (err) {
    console.error("delete-tweet error:", err);
    return res.status(500).json({ error: "delete-tweet failed", detail: String(err.message || err) });
  }
});

// ========== ARTICLES ==========
app.post("/admin/add-article", requireAdmin, async (req, res) => {
  try {
    initFirebase();

    const title = String(req.body?.title || "").trim();
    const html = String(req.body?.html || "").trim();   // içerik HTML
    const coverImageUrl = String(req.body?.coverImageUrl || "").trim();
    const excerpt = String(req.body?.excerpt || "").trim();

    if (!title) return res.status(400).json({ error: "missing title" });
    if (!html) return res.status(400).json({ error: "missing html" });

    const desiredSlug = String(req.body?.slug || "").trim();
    let slug = slugify(desiredSlug || title);

    // slug çakışmasını çöz: -2, -3...
    const base = slug;
    let i = 2;
    while ((await admin.database().ref(`articles/${slug}`).get()).exists()) {
      slug = `${base}-${i++}`;
    }

    const createdAt = Date.now();
    const article = { slug, title, excerpt, coverImageUrl, html, createdAt };

    await withTimeout(
      admin.database().ref(`articles/${slug}`).set(article),
      8000
    );

    return res.json({ ok: true, slug, article });
  } catch (err) {
    console.error("add-article error:", err);
    return res.status(500).json({ error: "add-article failed", detail: String(err.message || err) });
  }
});

app.post("/admin/delete-article", requireAdmin, async (req, res) => {
  try {
    initFirebase();
    const slug = String(req.body?.slug || "").trim();
    if (!slug) return res.status(400).json({ error: "missing slug" });

    await withTimeout(admin.database().ref(`articles/${slug}`).remove(), 8000);
    return res.json({ ok: true, slug });
  } catch (err) {
    console.error("delete-article error:", err);
    return res.status(500).json({ error: "delete-article failed", detail: String(err.message || err) });
  }
});

// ========== PUSH ==========
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
