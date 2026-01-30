import express from "express";
import cors from "cors";
import admin from "firebase-admin";

const app = express();
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json());

/* =====================================================
   FIREBASE INIT (CRASH-PROOF)
===================================================== */
let db = null;
let firebaseInitError = null;

function initFirebase() {
  if (db || firebaseInitError) return;

  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON missing");

    const serviceAccount = JSON.parse(raw);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });

    db = admin.firestore();
    console.log("✅ Firebase initialized");
  } catch (e) {
    firebaseInitError = e;
    console.error("❌ Firebase init failed:", e.message);
  }
}

/* =====================================================
   HELPERS
===================================================== */
function normalizeSlug(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function isValidSlug(slug) {
  return /^[a-z0-9-]{3,30}$/.test(slug);
}

async function requireAuth(req, res, next) {
  initFirebase();
  if (!db) {
    return res.status(500).json({
      error: "Server misconfigured",
      detail: firebaseInitError?.message || "Firebase not ready"
    });
  }

  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.uid = decoded.uid;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

/* =====================================================
   ROUTES (ROOT + HEALTH)
===================================================== */
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "theleng-api",
    routes: ["/ping", "/claim", "/page", "/:slug"]
  });
});

app.get("/ping", (req, res) => {
  res.json({ ok: true });
});

/* =====================================================
   POST /claim  → slug sahiplen
===================================================== */
app.post("/claim", requireAuth, async (req, res) => {
  const slug = normalizeSlug(req.body?.slug);
  if (!isValidSlug(slug)) {
    return res.status(400).json({ error: "Invalid slug" });
  }

  const ref = db.collection("pages").doc(slug);

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) throw new Error("TAKEN");

      tx.set(ref, {
        slug,
        ownerUid: req.uid,
        displayName: "",
        bio: "",
        photoUrl: "",
        socials: {},
        isPublic: true,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    return res.json({ ok: true, slug });
  } catch (e) {
    if (e.message === "TAKEN") {
      return res.status(409).json({ error: "Slug already taken" });
    }
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* =====================================================
   PUT /page  → sayfa güncelle
===================================================== */
app.put("/page", requireAuth, async (req, res) => {
  const slug = normalizeSlug(req.body?.slug);
  if (!isValidSlug(slug)) {
    return res.status(400).json({ error: "Invalid slug" });
  }

  const ref = db.collection("pages").doc(slug);
  const snap = await ref.get();

  if (!snap.exists) {
    return res.status(404).json({ error: "Page not found" });
  }

  if (snap.data().ownerUid !== req.uid) {
    return res.status(403).json({ error: "Not owner" });
  }

  const updateData = {
    displayName: String(req.body?.displayName || "").slice(0, 50),
    bio: String(req.body?.bio || "").slice(0, 160),
    photoUrl: String(req.body?.photoUrl || "").slice(0, 500),
    socials:
      req.body?.socials && typeof req.body.socials === "object"
        ? req.body.socials
        : {},
    isPublic:
      typeof req.body?.isPublic === "boolean"
        ? req.body.isPublic
        : true,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };

  await ref.update(updateData);
  return res.json({ ok: true, slug });
});

/* =====================================================
   GET /:slug  → public profil
===================================================== */
app.get("/:slug", async (req, res) => {
  initFirebase();
  if (!db) {
    return res.status(500).json({
      error: "Server misconfigured",
      detail: firebaseInitError?.message || "Firebase not ready"
    });
  }

  const slug = normalizeSlug(req.params.slug);
  if (!isValidSlug(slug)) {
    return res.status(400).json({ error: "Invalid slug" });
  }

  const snap = await db.collection("pages").doc(slug).get();
  if (!snap.exists) {
    return res.status(404).json({ error: "Not found" });
  }

  const data = snap.data();
  if (!data.isPublic) {
    return res.status(404).json({ error: "Not found" });
  }

  return res.json({
    slug: data.slug,
    displayName: data.displayName || "",
    bio: data.bio || "",
    photoUrl: data.photoUrl || "",
    socials: data.socials || {}
  });
});

/* =====================================================
   START SERVER
===================================================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 API running on port", PORT);
});
