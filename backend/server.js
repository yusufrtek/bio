import express from "express";
import cors from "cors";
import admin from "firebase-admin";

const app = express();
app.use(cors({ origin: "*", allowedHeaders: ["Content-Type", "Authorization"] }));
app.use(express.json());

// 🔴 Render ENV içine bunu koyacağız
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://backend-6782d-default-rtdb.europe-west1.firebasedatabase.app"
});

const db = admin.firestore();

/* ---------------- HELPERS ---------------- */
function normalizeSlug(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-");
}

async function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Token yok" });

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.uid = decoded.uid;
    next();
  } catch {
    res.status(401).json({ error: "Geçersiz token" });
  }
}

/* ---------------- ENDPOINTS ---------------- */

// test
app.get("/ping", (req, res) => res.json({ ok: true }));

// 1️⃣ slug sahiplen
app.post("/claim", auth, async (req, res) => {
  const slug = normalizeSlug(req.body.slug);
  const ref = db.collection("pages").doc(slug);

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) throw "TAKEN";
      tx.set(ref, {
        slug,
        ownerUid: req.uid,
        socials: {},
        isPublic: true,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    res.json({ ok: true, slug });
  } catch {
    res.status(409).json({ error: "Slug dolu" });
  }
});

// 2️⃣ sayfa güncelle
app.put("/page", auth, async (req, res) => {
  const slug = normalizeSlug(req.body.slug);
  const ref = db.collection("pages").doc(slug);
  const snap = await ref.get();

  if (!snap.exists) return res.status(404).json({ error: "Yok" });
  if (snap.data().ownerUid !== req.uid)
    return res.status(403).json({ error: "Yetkisiz" });

  await ref.update({
    socials: req.body.socials,
    isPublic: true
  });

  res.json({ ok: true });
});

// 3️⃣ public sayfa
app.get("/:slug", async (req, res) => {
  const slug = normalizeSlug(req.params.slug);
  const snap = await db.collection("pages").doc(slug).get();

  if (!snap.exists || !snap.data().isPublic)
    return res.status(404).json({ error: "Bulunamadı" });

  res.json(snap.data());
});

app.listen(process.env.PORT || 3000, () =>
  console.log("Backend çalışıyor")
);
