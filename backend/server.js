// ===== LENG — Backend (Node.js + Express) =====
// Deploy this on Render (https://bio-rk2d.onrender.com)
// Environment: Node.js
// Required env vars: FIREBASE_SERVICE_ACCOUNT (JSON string)

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// ===== Firebase Admin Init =====
// On Render, set FIREBASE_SERVICE_ACCOUNT env var with your service account JSON
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: 'https://backend-6782d-default-rtdb.europe-west1.firebasedatabase.app'
});

const db = admin.database();
const app = express();

// ===== CORS — single unified middleware =====
const corsOptions = {
    origin: function (origin, callback) {
        // Allow all origins (including no-origin requests like Postman/curl)
        callback(null, true);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    exposedHeaders: ['Access-Control-Allow-Origin'],
    maxAge: 86400,
    preflightContinue: false,
    optionsSuccessStatus: 204
};
app.use(cors(corsOptions));
app.use(express.json());

// ===== Auth Middleware =====
async function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Yetkilendirme basarisi gerekli.' });
    }

    const token = authHeader.split('Bearer ')[1];
    try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.uid = decoded.uid;
        req.email = decoded.email;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Gecersiz token.' });
    }
}

// ===== GET /ping =====
app.get('/ping', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
});

// ===== POST /claim =====
// Claim a slug for the authenticated user
app.post('/claim', authenticate, async (req, res) => {
    try {
        const { slug } = req.body;
        const uid = req.uid;

        // Validate slug
        if (!slug || slug.length < 2 || slug.length > 30) {
            return res.status(400).json({ error: 'Slug 2-30 karakter arasi olmali.' });
        }

        if (!/^[a-z0-9\-_]+$/.test(slug)) {
            return res.status(400).json({ error: 'Slug sadece kucuk harf, rakam, tire ve alt cizgi icermelidir.' });
        }

        // Reserved slugs
        const reserved = ['admin', 'panel', 'api', 'login', 'register', 'settings', 'about', 'contact', 'help', 'support'];
        if (reserved.includes(slug)) {
            return res.status(400).json({ error: 'Bu slug kullanilamaz.' });
        }

        // Check if user already has a slug
        const existingSlug = await db.ref('slugByUid/' + uid).once('value');
        if (existingSlug.exists()) {
            const userSlug = existingSlug.val().slug;
            if (userSlug === slug) {
                // Same slug — user is re-claiming their own slug (e.g. page data was lost)
                // Make sure pagesBySlug entry exists
                const pageSnap = await db.ref('pagesBySlug/' + slug).once('value');
                if (!pageSnap.exists()) {
                    await db.ref('pagesBySlug/' + slug).set({
                        uid: uid,
                        slug: slug,
                        displayName: '',
                        bio: '',
                        photoUrl: '',
                        socials: {},
                        createdAt: admin.database.ServerValue.TIMESTAMP,
                        updatedAt: admin.database.ServerValue.TIMESTAMP
                    });
                }
                return res.json({ success: true, slug: slug, note: 'Slug zaten sizin, tekrar onaylandi.' });
            } else {
                return res.status(400).json({ error: 'Zaten bir sayfaniz var: ' + userSlug + '. Birden fazla sayfa olusturulamaz.' });
            }
        }

        // Check if slug is taken by someone else
        const existingPage = await db.ref('pagesBySlug/' + slug).once('value');
        if (existingPage.exists()) {
            return res.status(409).json({ error: 'Bu slug baskasi tarafindan alinmis. Baska bir tane deneyin.' });
        }

        // Claim slug
        await db.ref('slugByUid/' + uid).set({ slug: slug });
        await db.ref('pagesBySlug/' + slug).set({
            uid: uid,
            slug: slug,
            displayName: '',
            bio: '',
            photoUrl: '',
            socials: {},
            createdAt: admin.database.ServerValue.TIMESTAMP,
            updatedAt: admin.database.ServerValue.TIMESTAMP
        });

        res.json({ success: true, slug: slug });
    } catch (err) {
        console.error('Claim error:', err);
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// ===== PUT /page =====
// Update page data for the authenticated user
app.put('/page', authenticate, async (req, res) => {
    try {
        const uid = req.uid;
        const { slug, displayName, bio, photoUrl, socials } = req.body;

        if (!slug) {
            return res.status(400).json({ error: 'Slug gerekli.' });
        }

        // Verify ownership via slugByUid
        const userSlugSnap = await db.ref('slugByUid/' + uid).once('value');
        if (!userSlugSnap.exists() || userSlugSnap.val().slug !== slug) {
            return res.status(403).json({ error: 'Bu slug size ait degil.' });
        }

        // Sanitize socials
        const cleanSocials = {};
        const allowedKeys = ['instagram', 'twitter', 'youtube', 'linkedin', 'github', 'website'];
        if (socials && typeof socials === 'object') {
            allowedKeys.forEach(key => {
                if (socials[key] && typeof socials[key] === 'string') {
                    cleanSocials[key] = socials[key].trim().substring(0, 500);
                }
            });
        }

        // Check if page exists
        const pageSnap = await db.ref('pagesBySlug/' + slug).once('value');

        if (!pageSnap.exists()) {
            // Page data doesn't exist yet — create it (upsert)
            await db.ref('pagesBySlug/' + slug).set({
                uid: uid,
                slug: slug,
                displayName: (displayName || '').trim().substring(0, 100),
                bio: (bio || '').trim().substring(0, 500),
                photoUrl: (photoUrl || '').trim().substring(0, 1000),
                socials: cleanSocials,
                createdAt: admin.database.ServerValue.TIMESTAMP,
                updatedAt: admin.database.ServerValue.TIMESTAMP
            });
        } else {
            // Update existing
            await db.ref('pagesBySlug/' + slug).update({
                displayName: (displayName || '').trim().substring(0, 100),
                bio: (bio || '').trim().substring(0, 500),
                photoUrl: (photoUrl || '').trim().substring(0, 1000),
                socials: cleanSocials,
                updatedAt: admin.database.ServerValue.TIMESTAMP
            });
        }

        res.json({ success: true });
    } catch (err) {
        console.error('Update error:', err);
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// ===== GET /page/:slug =====
// Public profile data
app.get('/page/:slug', async (req, res) => {
    try {
        const slug = req.params.slug;
        const snap = await db.ref('pagesBySlug/' + slug).once('value');

        if (!snap.exists()) {
            return res.status(404).json({ error: 'Sayfa bulunamadi.' });
        }

        const data = snap.val();
        // Return only public fields
        res.json({
            slug: data.slug,
            displayName: data.displayName,
            bio: data.bio,
            photoUrl: data.photoUrl,
            socials: data.socials || {}
        });
    } catch (err) {
        console.error('Get page error:', err);
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// ===== GET /my-slug =====
// Get the slug for the authenticated user
app.get('/my-slug', authenticate, async (req, res) => {
    try {
        const uid = req.uid;
        const snap = await db.ref('slugByUid/' + uid).once('value');

        if (!snap.exists()) {
            return res.status(404).json({ error: 'Henuz bir sayfaniz yok.' });
        }

        res.json(snap.val());
    } catch (err) {
        console.error('My slug error:', err);
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// ===== Health =====
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: Date.now(),
        env: {
            hasServiceAccount: !!process.env.FIREBASE_SERVICE_ACCOUNT,
            nodeVersion: process.version
        }
    });
});

// ===== 404 catch =====
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint bulunamadi: ' + req.method + ' ' + req.path });
});

// ===== Global error handler =====
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Sunucu hatasi: ' + (err.message || 'Bilinmeyen') });
});

// ===== Start Server =====
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log('LENG API running on port ' + PORT);
    console.log('CORS: all origins allowed');
    console.log('Firebase project: backend-6782d');
});
