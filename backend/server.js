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

/* ===================== FIREBASE INIT ===================== */
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

/* ===================== HELPERS ===================== */
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

function adminAllowList() {
  const raw = process.env.ADMIN_EMAILS || "";
  return new Set(
    raw.split(",")
      .map(x => x.trim().toLowerCase())
      .filter(Boolean)
  );
}

function sanitizeTemplate(t) {
  const x = String(t || "neo").toLowerCase().trim();
  // Template listesi artık Firestore'dan gelecek ama default güvenli olsun
  return x.slice(0, 24) || "neo";
}

function sanitizeBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  const out = [];
  for (const b of blocks.slice(0, 80)) {
    if (!b || typeof b !== "object") continue;
    const type = String(b.type || "").toLowerCase().trim();
    const id = String(b.id || "").slice(0, 80);

    if (!["button", "text", "tweet", "youtube", "divider", "image"].includes(type)) continue;

    if (type === "divider") { out.push({ id, type }); continue; }

    if (type === "text") {
      out.push({ id, type, text: String(b.text || "").slice(0, 3000) });
      continue;
    }

    if (type === "button") {
      out.push({
        id, type,
        title: String(b.title || "").slice(0, 80),
        url: String(b.url || "").slice(0, 800),
        note: String(b.note || "").slice(0, 160)
      });
      continue;
    }

    if (type === "image") {
      out.push({
        id, type,
        url: String(b.url || "").slice(0, 800),
        caption: String(b.caption || "").slice(0, 200)
      });
      continue;
    }

    // tweet / youtube
    out.push({ id, type, url: String(b.url || "").slice(0, 800) });
  }
  return out;
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
    req.email = (decoded.email || "").toLowerCase();
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

async function requireAdmin(req, res, next) {
  await requireAuth(req, res, async () => {
    const allow = adminAllowList();
    if (!req.email || !allow.has(req.email)) {
      return res.status(403).json({ error: "Admin only" });
    }
    next();
  });
}

/* ===================== ROOT ===================== */
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "theleng-api",
    routes: [
      "/ping",
      "/templates",
      "/my-page",
      "/my-page/full",
      "/claim",
      "/page",
      "/:slug",
      "/admin/users",
      "/admin/page",
      "/admin/templates"
    ]
  });
});

app.get("/ping", (req, res) => res.json({ ok: true }));

/* ===================== TEMPLATES (PUBLIC) ===================== */
/**
 * Firestore: settings/templates doc
 * { templates: [{id,name,desc,previewClass}] }
 */
app.get("/templates", async (req, res) => {
  initFirebase();
  if (!db) return res.status(500).json({ error: "Server misconfigured" });

  const ref = db.collection("settings").doc("templates");
  const snap = await ref.get();
  if (!snap.exists) {
    // default
    return res.json({
      templates: [
        { id: "neo", name: "Neo", desc: "Koyu, net, modern", previewClass: "t-neo" },
        { id: "glass", name: "Glass", desc: "Cam, yumuşak", previewClass: "t-glass" },
        { id: "sunrise", name: "Sunrise", desc: "Sıcak gradient", previewClass: "t-sunrise" }
      ]
    });
  }
  const data = snap.data() || {};
  return res.json({ templates: Array.isArray(data.templates) ? data.templates : [] });
});

/* ===================== USER: MY PAGE ===================== */
/**
 * 200 -> {hasPage:true, slug:"..."}
 * 404 -> {hasPage:false}
 */
app.get("/my-page", requireAuth, async (req, res) => {
  const uref = db.collection("users").doc(req.uid);
  const usnap = await uref.get();
  if (!usnap.exists) return res.status(404).json({ hasPage: false });
  const slug = usnap.data()?.slug;
  if (!slug) return res.status(404).json({ hasPage: false });
  return res.json({ hasPage: true, slug });
});

/**
 * edit için tam içerik
 */
app.get("/my-page/full", requireAuth, async (req, res) => {
  const uref = db.collection("users").doc(req.uid);
  const usnap = await uref.get();
  if (!usnap.exists || !usnap.data()?.slug) return res.status(404).json({ hasPage: false });

  const slug = usnap.data().slug;
  const pref = db.collection("pages").doc(slug);
  const psnap = await pref.get();
  if (!psnap.exists) return res.status(404).json({ hasPage: false });

  const data = psnap.data();
  return res.json({
    hasPage: true,
    page: {
      slug: data.slug,
      displayName: data.displayName || "",
      bio: data.bio || "",
      photoUrl: data.photoUrl || "",
      socials: data.socials || {},
      template: data.template || "neo",
      blocks: Array.isArray(data.blocks) ? data.blocks : [],
      isPublic: data.isPublic !== false
    }
  });
});

/* ===================== CLAIM (ONE PAGE PER USER) ===================== */
/**
 * - Kullanıcı daha önce sayfa aldıysa: 409 + mevcut slug döner
 * - İlk kez ise: slug boşsa otomatik üretmez, user slug ister
 */
app.post("/claim", requireAuth, async (req, res) => {
  const desired = normalizeSlug(req.body?.slug);
  if (!isValidSlug(desired)) return res.status(400).json({ error: "Invalid slug" });

  const uref = db.collection("users").doc(req.uid);
  const pref = db.collection("pages").doc(desired);

  try {
    const result = await db.runTransaction(async (tx) => {
      const us = await tx.get(uref);
      if (us.exists && us.data()?.slug) {
        return { ok: false, code: 409, slug: us.data().slug, reason: "USER_ALREADY_HAS_PAGE" };
      }

      const ps = await tx.get(pref);
      if (ps.exists) {
        return { ok: false, code: 409, slug: null, reason: "SLUG_TAKEN" };
      }

      tx.set(pref, {
        slug: desired,
        ownerUid: req.uid,
        displayName: "",
        bio: "",
        photoUrl: "",
        socials: {},
        isPublic: true,
        template: "neo",
        blocks: [],
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      tx.set(uref, {
        uid: req.uid,
        email: req.email || "",
        slug: desired,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      return { ok: true, code: 200, slug: desired };
    });

    if (!result.ok) {
      if (result.reason === "USER_ALREADY_HAS_PAGE") {
        return res.status(409).json({ error: "User already has a page", slug: result.slug });
      }
      if (result.reason === "SLUG_TAKEN") {
        return res.status(409).json({ error: "Slug already taken" });
      }
      return res.status(409).json({ error: "Conflict" });
    }

    return res.json({ ok: true, slug: result.slug });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ===================== UPDATE PAGE (OWNER) ===================== */
app.put("/page", requireAuth, async (req, res) => {
  const slug = normalizeSlug(req.body?.slug);
  if (!isValidSlug(slug)) return res.status(400).json({ error: "Invalid slug" });

  const ref = db.collection("pages").doc(slug);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ error: "Page not found" });

  const data = snap.data();
  if (data.ownerUid !== req.uid) return res.status(403).json({ error: "Not owner" });

  const updateData = {
    displayName: String(req.body?.displayName || "").slice(0, 60),
    bio: String(req.body?.bio || "").slice(0, 3000),
    photoUrl: String(req.body?.photoUrl || "").slice(0, 800),
    socials: (req.body?.socials && typeof req.body.socials === "object") ? req.body.socials : {},
    isPublic: typeof req.body?.isPublic === "boolean" ? req.body.isPublic : true,
    template: sanitizeTemplate(req.body?.template),
    blocks: sanitizeBlocks(req.body?.blocks),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };

  await ref.update(updateData);
  return res.json({ ok: true, slug });
});

/* ===================== PUBLIC GET ===================== */
app.get("/:slug", async (req, res) => {
  initFirebase();
  if (!db) return res.status(500).json({ error: "Server misconfigured" });

  const slug = normalizeSlug(req.params.slug);
  if (!isValidSlug(slug)) return res.status(400).json({ error: "Invalid slug" });

  const snap = await db.collection("pages").doc(slug).get();
  if (!snap.exists) return res.status(404).json({ error: "Not found" });

  const data = snap.data();
  if (!data.isPublic) return res.status(404).json({ error: "Not found" });

  return res.json({
    slug: data.slug,
    displayName: data.displayName || "",
    bio: data.bio || "",
    photoUrl: data.photoUrl || "",
    socials: data.socials || {},
    template: data.template || "neo",
    blocks: Array.isArray(data.blocks) ? data.blocks : []
  });
});

/* ===================== ADMIN ===================== */
/**
 * GET /admin/users?limit=50
 * basit liste
 */
app.get("/admin/users", requireAdmin, async (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
  const snap = await db.collection("users").orderBy("createdAt", "desc").limit(limit).get();
  const users = snap.docs.map(d => ({
    uid: d.id,
    email: d.data().email || "",
    slug: d.data().slug || "",
    createdAt: d.data().createdAt || null
  }));
  res.json({ ok: true, users });
});

/**
 * PUT /admin/page
 * {slug, displayName, bio, photoUrl, socials, template, blocks, isPublic}
 */
app.put("/admin/page", requireAdmin, async (req, res) => {
  const slug = normalizeSlug(req.body?.slug);
  if (!isValidSlug(slug)) return res.status(400).json({ error: "Invalid slug" });

  const ref = db.collection("pages").doc(slug);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ error: "Page not found" });

  await ref.update({
    displayName: String(req.body?.displayName || "").slice(0, 60),
    bio: String(req.body?.bio || "").slice(0, 3000),
    photoUrl: String(req.body?.photoUrl || "").slice(0, 800),
    socials: (req.body?.socials && typeof req.body.socials === "object") ? req.body.socials : {},
    isPublic: typeof req.body?.isPublic === "boolean" ? req.body.isPublic : true,
    template: sanitizeTemplate(req.body?.template),
    blocks: sanitizeBlocks(req.body?.blocks),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  res.json({ ok: true, slug });
});

/**
 * PUT /admin/templates
 * {templates: [{id,name,desc,previewClass}]}
 */
app.put("/admin/templates", requireAdmin, async (req, res) => {
  const templates = Array.isArray(req.body?.templates) ? req.body.templates.slice(0, 50) : [];
  await db.collection("settings").doc("templates").set({ templates }, { merge: true });
  res.json({ ok: true, count: templates.length });
});

/* ===================== START ===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 API running on port", PORT));
