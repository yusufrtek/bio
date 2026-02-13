// ===== LENG — Backend (Node.js + Express) =====
// Deploy this on Render (https://engine.leng.tr)
// Environment: Node.js
// Required env vars: FIREBASE_SERVICE_ACCOUNT (JSON string)

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// ===== Firebase Admin Init =====
// On Render, set FIREBASE_SERVICE_ACCOUNT env var with your service account JSON
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: 'https://backend-6782d-default-rtdb.europe-west1.firebasedatabase.app'
});

const db = admin.database();
const app = express();

// ===== Cloudflare R2 Client =====
const R2 = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
});

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

        if (!/^[a-z0-9]+$/.test(slug)) {
            return res.status(400).json({ error: 'Slug sadece kucuk harf ve rakam icermelidir. Ozel karakter kullanilamaz.' });
        }

        // Reserved slugs
        const reserved = ['admin', 'panel', 'api', 'login', 'register', 'settings', 'about', 'contact', 'help', 'support', 'dash', 'kisalt'];
        if (reserved.includes(slug)) {
            return res.status(400).json({ error: 'Bu slug kullanilamaz.' });
        }

        // Block agency emails from creating personal pages
        const userEmail = (req.email || '').toLowerCase();
        const agenciesSnap = await db.ref('agencies').once('value');
        if (agenciesSnap.exists()) {
            const agencies = agenciesSnap.val();
            for (const aId of Object.keys(agencies)) {
                if ((agencies[aId].email || '').toLowerCase() === userEmail) {
                    return res.status(403).json({ error: 'Bu e-posta bir ajansa ait. Ajans panelinden bio sayfasi olusturabilirsiniz.' });
                }
            }
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
                        blocks: [],
                        background: { color: '', imageUrl: '', opacity: 1, pattern: 'none' },
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
            blocks: [],
            background: { color: '', imageUrl: '', opacity: 1, pattern: 'none' },
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
        const { slug, displayName, bio, photoUrl, socials, blocks, customButtons, background, styles, layerOrder, vitrin } = req.body;

        if (!slug) {
            return res.status(400).json({ error: 'Slug gerekli.' });
        }

        // Verify ownership via slugByUid
        const userSlugSnap = await db.ref('slugByUid/' + uid).once('value');
        if (!userSlugSnap.exists() || userSlugSnap.val().slug !== slug) {
            return res.status(403).json({ error: 'Bu slug size ait degil.' });
        }

        // Sanitize socials — auto-prefix URLs from usernames
        const cleanSocials = {};
        const allowedKeys = ['instagram', 'twitter', 'youtube', 'linkedin', 'github', 'website', 'tiktok'];
        const socialUrlPrefixes = {
            instagram: 'https://instagram.com/',
            twitter: 'https://x.com/',
            youtube: 'https://youtube.com/@',
            linkedin: 'https://linkedin.com/in/',
            github: 'https://github.com/',
            tiktok: 'https://tiktok.com/@',
            website: ''
        };
        if (socials && typeof socials === 'object') {
            allowedKeys.forEach(key => {
                if (socials[key] && typeof socials[key] === 'string') {
                    let val = socials[key].trim().substring(0, 500);
                    if (val && key !== 'website' && !val.startsWith('http')) {
                        val = val.replace(/^@/, '');
                        val = socialUrlPrefixes[key] + val;
                    }
                    cleanSocials[key] = val;
                }
            });
        }

        // Sanitize content blocks (max 20 blocks)
        let cleanBlocks = [];
        if (Array.isArray(blocks)) {
            cleanBlocks = blocks.slice(0, 20).map((block, idx) => {
                const type = (block.type || '').trim();
                if (type === 'text') {
                    return { type: 'text', content: (block.content || '').trim().substring(0, 2000), id: idx };
                } else if (type === 'image') {
                    return { type: 'image', url: (block.url || '').trim().substring(0, 1000), id: idx };
                } else if (type === 'youtube') {
                    return { type: 'youtube', url: (block.url || '').trim().substring(0, 500), id: idx };
                } else if (type === 'spotify') {
                    return { type: 'spotify', url: (block.url || '').trim().substring(0, 500), id: idx };
                }
                return null;
            }).filter(Boolean);
        }

        // Sanitize background settings
        let cleanBg = {};
        if (background && typeof background === 'object') {
            cleanBg.color = (background.color || '').trim().substring(0, 30);
            cleanBg.imageUrl = (background.imageUrl || '').trim().substring(0, 1000);
            cleanBg.opacity = Math.max(0, Math.min(1, parseFloat(background.opacity) || 1));
            cleanBg.blur = Math.max(0, Math.min(20, parseInt(background.blur) || 0));
            const allowedPatterns = ['none', 'dots', 'grid', 'diagonal', 'cross', 'waves'];
            cleanBg.pattern = allowedPatterns.includes(background.pattern) ? background.pattern : 'none';
        }

        // Ensure blocks and bg are never undefined/null (RTDB drops empty arrays)
        if (cleanBlocks.length === 0) cleanBlocks = [];
        if (Object.keys(cleanBg).length === 0) {
            cleanBg = { color: '', imageUrl: '', opacity: 1, pattern: 'none' };
        }

        // Sanitize styles
        let cleanStyles = { photoStyle: 'circle', btnStyle: 'rounded' };
        if (styles && typeof styles === 'object') {
            const allowedPhotoStyles = ['circle', 'rounded', 'square'];
            const allowedBtnStyles = ['rounded', 'default', 'sharp', 'outline'];
            cleanStyles.photoStyle = allowedPhotoStyles.includes(styles.photoStyle) ? styles.photoStyle : 'circle';
            cleanStyles.btnStyle = allowedBtnStyles.includes(styles.btnStyle) ? styles.btnStyle : 'rounded';
            const allowedIconStyles = ['minimal', 'branded'];
            cleanStyles.socialIconStyle = allowedIconStyles.includes(styles.socialIconStyle) ? styles.socialIconStyle : 'minimal';
            const allowedDisplayModes = ['button', 'icon-only'];
            cleanStyles.socialDisplayMode = allowedDisplayModes.includes(styles.socialDisplayMode) ? styles.socialDisplayMode : 'button';
        }

        // Sanitize customButtons (max 10)
        let cleanCustomButtons = [];
        if (Array.isArray(customButtons)) {
            cleanCustomButtons = customButtons.slice(0, 10).map((btn, idx) => ({
                id: idx,
                title: (btn.title || '').trim().substring(0, 100),
                url: (btn.url || '').trim().substring(0, 1000),
                logoUrl: (btn.logoUrl || '').trim().substring(0, 1000),
                iconId: (btn.iconId || '').trim().substring(0, 100)
            })).filter(btn => btn.title && btn.url);
        }

        // Sanitize layerOrder
        const allowedLayers = ['blocks', 'polls', 'qa', 'links'];
        let cleanLayerOrder = ['blocks', 'polls', 'qa', 'links'];
        if (Array.isArray(layerOrder)) {
            const filtered = layerOrder.filter(l => allowedLayers.includes(l));
            if (filtered.length === allowedLayers.length) {
                cleanLayerOrder = filtered;
            }
        }

        // Sanitize vitrin settings (agency showcase)
        let cleanVitrin = null;
        if (vitrin && typeof vitrin === 'object') {
            cleanVitrin = {
                enabled: !!vitrin.enabled,
                title: (vitrin.title || 'Uyelerimiz').trim().substring(0, 100),
                agencyId: (vitrin.agencyId || '').trim().substring(0, 200)
            };
        }

        // Build page data
        const pageData = {
            uid: uid,
            slug: slug,
            displayName: (displayName || '').trim().substring(0, 100),
            bio: (bio || '').trim().substring(0, 500),
            photoUrl: (photoUrl || '').trim().substring(0, 1000),
            socials: Object.keys(cleanSocials).length > 0 ? cleanSocials : { instagram: '', twitter: '', youtube: '', linkedin: '', github: '', website: '', tiktok: '' },
            blocks: cleanBlocks,
            customButtons: cleanCustomButtons,
            background: cleanBg,
            styles: cleanStyles,
            layerOrder: cleanLayerOrder,
            updatedAt: admin.database.ServerValue.TIMESTAMP
        };
        if (cleanVitrin) pageData.vitrin = cleanVitrin;

        console.log('PUT /page - saving for slug:', slug, 'uid:', uid);

        // Check if page exists — preserve polls/questions references
        const pageSnap = await db.ref('pagesBySlug/' + slug).once('value');

        if (!pageSnap.exists()) {
            pageData.createdAt = admin.database.ServerValue.TIMESTAMP;
        } else {
            const existingData = pageSnap.val();
            pageData.createdAt = existingData.createdAt || admin.database.ServerValue.TIMESTAMP;
            // Preserve polls, questions, and vitrin references
            if (existingData.polls) pageData.polls = existingData.polls;
            if (existingData.questions) pageData.questions = existingData.questions;
            if (!pageData.vitrin && existingData.vitrin) pageData.vitrin = existingData.vitrin;
        }

        // Always use set to ensure complete overwrite (with preserved polls/questions)
        await db.ref('pagesBySlug/' + slug).set(pageData);

        console.log('PUT /page - saved successfully for slug:', slug);
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
        // Return ALL public fields
        const response = {
            uid: data.uid,
            slug: data.slug,
            displayName: data.displayName,
            bio: data.bio,
            photoUrl: data.photoUrl,
            socials: data.socials || {},
            blocks: data.blocks || [],
            customButtons: data.customButtons || [],
            background: data.background || {},
            styles: data.styles || { photoStyle: 'circle', btnStyle: 'rounded', socialIconStyle: 'minimal', socialDisplayMode: 'button' },
            layerOrder: data.layerOrder || ['blocks', 'polls', 'qa', 'links']
        };
        if (data.vitrin) response.vitrin = data.vitrin;
        res.json(response);
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

// ===== POLLS =====
// IMPORTANT: Firebase RTDB requires index rules for queries.
// Add these rules to your Firebase RTDB Rules:
// {
//   "rules": {
//     ".read": false, ".write": false,
//     "polls": { ".indexOn": ["slug"], ".read": true },
//     "questions": { ".indexOn": ["slug"], ".read": true },
//     "pagesBySlug": { ".read": true, "$slug": { ".write": "auth != null" } },
//     "slugByUid": { "$uid": { ".read": "auth != null && auth.uid == $uid", ".write": "auth != null && auth.uid == $uid" } },
//     "pollVotes": { ".read": true, "$pollId": { "$uid": { ".write": "auth != null && auth.uid == $uid" } } },
//     "questionAnswers": { ".read": true, "$qId": { "$ansId": { ".write": "auth != null" } } },
//     "answerLikes": { ".read": true, "$ansId": { "$uid": { ".write": "auth != null && auth.uid == $uid" } } }
//   }
// }

// POST /polls — Create a poll (auth required, page owner)
app.post('/polls', authenticate, async (req, res) => {
    try {
        const uid = req.uid;
        const { slug, question, options, multipleChoice, expiresInHours } = req.body;

        if (!slug || !question || !Array.isArray(options) || options.length < 2 || options.length > 10) {
            return res.status(400).json({ error: 'Soru ve en az 2, en fazla 10 secenek gerekli.' });
        }

        // Verify ownership
        const userSlugSnap = await db.ref('slugByUid/' + uid).once('value');
        if (!userSlugSnap.exists() || userSlugSnap.val().slug !== slug) {
            return res.status(403).json({ error: 'Bu slug size ait degil.' });
        }

        const pollId = 'poll_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
        const cleanOptions = options.slice(0, 10).map((opt, i) => ({
            id: i,
            text: (opt.text || opt || '').toString().trim().substring(0, 200),
            votes: 0
        }));

        const pollData = {
            id: pollId,
            slug: slug,
            uid: uid,
            question: question.trim().substring(0, 500),
            options: cleanOptions,
            multipleChoice: !!multipleChoice,
            totalVotes: 0,
            active: true,
            createdAt: admin.database.ServerValue.TIMESTAMP,
            expiresAt: expiresInHours ? Date.now() + (expiresInHours * 3600000) : null
        };

        await db.ref('polls/' + pollId).set(pollData);

        // Add poll reference to page
        const pagePolls = await db.ref('pagesBySlug/' + slug + '/polls').once('value');
        const currentPolls = pagePolls.exists() ? pagePolls.val() : [];
        const pollList = Array.isArray(currentPolls) ? currentPolls : Object.values(currentPolls);
        pollList.push(pollId);
        await db.ref('pagesBySlug/' + slug + '/polls').set(pollList);

        res.json({ success: true, pollId: pollId });
    } catch (err) {
        console.error('Create poll error:', err);
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// GET /polls/:slug — Get all polls for a page (public)
// Query directly from polls collection by slug field (not dependent on pagesBySlug references)
app.get('/polls/:slug', async (req, res) => {
    try {
        const slug = req.params.slug;
        console.log('GET /polls/' + slug + ' - querying polls collection directly');

        const pollsSnap = await db.ref('polls').orderByChild('slug').equalTo(slug).once('value');

        const polls = [];
        if (pollsSnap.exists()) {
            pollsSnap.forEach(child => {
                const poll = child.val();
                // Check expiry
                if (poll.expiresAt && Date.now() > poll.expiresAt) {
                    poll.active = false;
                }
                polls.push(poll);
            });
        }

        // Sort newest first by createdAt
        polls.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

        console.log('GET /polls/' + slug + ' - found ' + polls.length + ' polls');
        res.json({ polls: polls });
    } catch (err) {
        console.error('Get polls error:', err);
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// POST /polls/:pollId/vote — Vote on a poll (auth required)
app.post('/polls/:pollId/vote', authenticate, async (req, res) => {
    try {
        const uid = req.uid;
        const pollId = req.params.pollId;
        const { optionId } = req.body;

        if (optionId === undefined || optionId === null) {
            return res.status(400).json({ error: 'Secenek ID gerekli.' });
        }

        const pollSnap = await db.ref('polls/' + pollId).once('value');
        if (!pollSnap.exists()) return res.status(404).json({ error: 'Anket bulunamadi.' });

        const poll = pollSnap.val();
        if (!poll.active) return res.status(400).json({ error: 'Bu anket artik aktif degil.' });
        if (poll.expiresAt && Date.now() > poll.expiresAt) return res.status(400).json({ error: 'Bu anketin suresi dolmus.' });

        // Check if already voted
        const voteSnap = await db.ref('pollVotes/' + pollId + '/' + uid).once('value');
        if (voteSnap.exists()) {
            return res.status(400).json({ error: 'Bu ankete zaten oy verdiniz.', existingVote: voteSnap.val() });
        }

        // Validate option
        const optIdx = parseInt(optionId);
        if (isNaN(optIdx) || optIdx < 0 || optIdx >= poll.options.length) {
            return res.status(400).json({ error: 'Gecersiz secenek.' });
        }

        // Record vote
        await db.ref('pollVotes/' + pollId + '/' + uid).set({
            optionId: optIdx,
            votedAt: admin.database.ServerValue.TIMESTAMP
        });

        // Increment vote count
        await db.ref('polls/' + pollId + '/options/' + optIdx + '/votes').transaction(current => (current || 0) + 1);
        await db.ref('polls/' + pollId + '/totalVotes').transaction(current => (current || 0) + 1);

        res.json({ success: true });
    } catch (err) {
        console.error('Vote error:', err);
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// GET /polls/:pollId/my-vote — Check if user voted (auth required)
app.get('/polls/:pollId/my-vote', authenticate, async (req, res) => {
    try {
        const uid = req.uid;
        const pollId = req.params.pollId;
        const voteSnap = await db.ref('pollVotes/' + pollId + '/' + uid).once('value');
        if (voteSnap.exists()) {
            res.json({ voted: true, vote: voteSnap.val() });
        } else {
            res.json({ voted: false });
        }
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// DELETE /polls/:pollId — Delete a poll (auth required, owner only)
app.delete('/polls/:pollId', authenticate, async (req, res) => {
    try {
        const uid = req.uid;
        const pollId = req.params.pollId;
        const pollSnap = await db.ref('polls/' + pollId).once('value');
        if (!pollSnap.exists()) return res.status(404).json({ error: 'Anket bulunamadi.' });
        if (pollSnap.val().uid !== uid) return res.status(403).json({ error: 'Bu anket size ait degil.' });

        const slug = pollSnap.val().slug;
        await db.ref('polls/' + pollId).remove();
        await db.ref('pollVotes/' + pollId).remove();

        // Remove from page's poll list
        const pagePolls = await db.ref('pagesBySlug/' + slug + '/polls').once('value');
        if (pagePolls.exists()) {
            const pollList = Array.isArray(pagePolls.val()) ? pagePolls.val() : Object.values(pagePolls.val());
            const updated = pollList.filter(p => p !== pollId);
            await db.ref('pagesBySlug/' + slug + '/polls').set(updated.length > 0 ? updated : null);
        }

        res.json({ success: true });
    } catch (err) {
        console.error('Delete poll error:', err);
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// PATCH /polls/:pollId — Toggle active state (auth required, owner only)
app.patch('/polls/:pollId', authenticate, async (req, res) => {
    try {
        const uid = req.uid;
        const pollId = req.params.pollId;
        const pollSnap = await db.ref('polls/' + pollId).once('value');
        if (!pollSnap.exists()) return res.status(404).json({ error: 'Anket bulunamadi.' });
        if (pollSnap.val().uid !== uid) return res.status(403).json({ error: 'Bu anket size ait degil.' });

        const newActive = !pollSnap.val().active;
        await db.ref('polls/' + pollId + '/active').set(newActive);
        res.json({ success: true, active: newActive });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// ===== QUESTIONS (Q&A) =====

// POST /questions — Create a question (auth required, page owner)
app.post('/questions', authenticate, async (req, res) => {
    try {
        const uid = req.uid;
        const { slug, question } = req.body;

        if (!slug || !question) return res.status(400).json({ error: 'Slug ve soru gerekli.' });

        const userSlugSnap = await db.ref('slugByUid/' + uid).once('value');
        if (!userSlugSnap.exists() || userSlugSnap.val().slug !== slug) {
            return res.status(403).json({ error: 'Bu slug size ait degil.' });
        }

        const qId = 'q_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
        const qData = {
            id: qId,
            slug: slug,
            uid: uid,
            question: question.trim().substring(0, 500),
            active: true,
            answerCount: 0,
            createdAt: admin.database.ServerValue.TIMESTAMP
        };

        await db.ref('questions/' + qId).set(qData);

        const pageQs = await db.ref('pagesBySlug/' + slug + '/questions').once('value');
        const currentQs = pageQs.exists() ? pageQs.val() : [];
        const qList = Array.isArray(currentQs) ? currentQs : Object.values(currentQs);
        qList.push(qId);
        await db.ref('pagesBySlug/' + slug + '/questions').set(qList);

        res.json({ success: true, questionId: qId });
    } catch (err) {
        console.error('Create question error:', err);
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// GET /questions/:slug — Get all questions for a page (public)
// Query directly from questions collection by slug field
app.get('/questions/:slug', async (req, res) => {
    try {
        const slug = req.params.slug;
        console.log('GET /questions/' + slug + ' - querying questions collection directly');

        const qSnap = await db.ref('questions').orderByChild('slug').equalTo(slug).once('value');

        const questions = [];
        if (qSnap.exists()) {
            const promises = [];
            qSnap.forEach(child => {
                const q = child.val();
                // Get answers for each question
                const p = db.ref('questionAnswers/' + q.id).once('value').then(ansSnap => {
                    q.answers = [];
                    if (ansSnap.exists()) {
                        const ansObj = ansSnap.val();
                        q.answers = Object.values(ansObj).sort((a, b) => (b.likes || 0) - (a.likes || 0));
                    }
                    questions.push(q);
                });
                promises.push(p);
            });
            await Promise.all(promises);
        }

        // Sort newest first
        questions.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

        console.log('GET /questions/' + slug + ' - found ' + questions.length + ' questions');
        res.json({ questions: questions });
    } catch (err) {
        console.error('Get questions error:', err);
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// POST /questions/:questionId/answer — Answer a question (auth required)
app.post('/questions/:questionId/answer', authenticate, async (req, res) => {
    try {
        const uid = req.uid;
        const questionId = req.params.questionId;
        const { text } = req.body;

        if (!text || text.trim().length < 1) return res.status(400).json({ error: 'Cevap metni gerekli.' });

        const qSnap = await db.ref('questions/' + questionId).once('value');
        if (!qSnap.exists()) return res.status(404).json({ error: 'Soru bulunamadi.' });
        if (!qSnap.val().active) return res.status(400).json({ error: 'Bu soru artik aktif degil.' });

        // Get user info
        const userRecord = await admin.auth().getUser(uid);

        const answerId = 'ans_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
        const answerData = {
            id: answerId,
            uid: uid,
            displayName: userRecord.displayName || 'Anonim',
            photoUrl: userRecord.photoURL || '',
            text: text.trim().substring(0, 1000),
            likes: 0,
            createdAt: admin.database.ServerValue.TIMESTAMP
        };

        await db.ref('questionAnswers/' + questionId + '/' + answerId).set(answerData);
        await db.ref('questions/' + questionId + '/answerCount').transaction(c => (c || 0) + 1);

        res.json({ success: true, answerId: answerId });
    } catch (err) {
        console.error('Answer error:', err);
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// POST /questions/:questionId/answers/:answerId/like — Like an answer (auth required)
app.post('/questions/:questionId/answers/:answerId/like', authenticate, async (req, res) => {
    try {
        const uid = req.uid;
        const { questionId, answerId } = req.params;

        const likeSnap = await db.ref('answerLikes/' + answerId + '/' + uid).once('value');
        if (likeSnap.exists()) {
            // Unlike
            await db.ref('answerLikes/' + answerId + '/' + uid).remove();
            await db.ref('questionAnswers/' + questionId + '/' + answerId + '/likes').transaction(c => Math.max(0, (c || 0) - 1));
            return res.json({ success: true, liked: false });
        }

        await db.ref('answerLikes/' + answerId + '/' + uid).set(true);
        await db.ref('questionAnswers/' + questionId + '/' + answerId + '/likes').transaction(c => (c || 0) + 1);
        res.json({ success: true, liked: true });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// DELETE /questions/:questionId — Delete a question (auth required, owner only)
app.delete('/questions/:questionId', authenticate, async (req, res) => {
    try {
        const uid = req.uid;
        const questionId = req.params.questionId;
        const qSnap = await db.ref('questions/' + questionId).once('value');
        if (!qSnap.exists()) return res.status(404).json({ error: 'Soru bulunamadi.' });
        if (qSnap.val().uid !== uid) return res.status(403).json({ error: 'Bu soru size ait degil.' });

        const slug = qSnap.val().slug;
        await db.ref('questions/' + questionId).remove();
        await db.ref('questionAnswers/' + questionId).remove();

        const pageQs = await db.ref('pagesBySlug/' + slug + '/questions').once('value');
        if (pageQs.exists()) {
            const qList = Array.isArray(pageQs.val()) ? pageQs.val() : Object.values(pageQs.val());
            const updated = qList.filter(q => q !== questionId);
            await db.ref('pagesBySlug/' + slug + '/questions').set(updated.length > 0 ? updated : null);
        }

        res.json({ success: true });
    } catch (err) {
        console.error('Delete question error:', err);
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// GET /polls/:pollId/results — Detailed poll results (auth required, owner only)
app.get('/polls/:pollId/results', authenticate, async (req, res) => {
    try {
        const uid = req.uid;
        const pollId = req.params.pollId;
        const pollSnap = await db.ref('polls/' + pollId).once('value');
        if (!pollSnap.exists()) return res.status(404).json({ error: 'Anket bulunamadi.' });
        if (pollSnap.val().uid !== uid) return res.status(403).json({ error: 'Bu anket size ait degil.' });

        const votesSnap = await db.ref('pollVotes/' + pollId).once('value');
        const voters = votesSnap.exists() ? votesSnap.val() : {};
        const voterCount = Object.keys(voters).length;

        const poll = pollSnap.val();
        const options = poll.options.map(opt => ({
            ...opt,
            percentage: poll.totalVotes > 0 ? Math.round((opt.votes / poll.totalVotes) * 100) : 0
        }));

        res.json({
            poll: { ...poll, options: options },
            voterCount: voterCount,
            voters: voters
        });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// ===== Debug: Check page data in RTDB =====
app.get('/debug/page/:slug', async (req, res) => {
    try {
        const slug = req.params.slug;
        const pageSnap = await db.ref('pagesBySlug/' + slug).once('value');
        const slugByUidSnap = await db.ref('slugByUid').orderByChild('slug').equalTo(slug).once('value');

        res.json({
            slug: slug,
            pageExists: pageSnap.exists(),
            pageData: pageSnap.exists() ? pageSnap.val() : null,
            slugByUidExists: slugByUidSnap.exists(),
            slugByUidData: slugByUidSnap.exists() ? slugByUidSnap.val() : null
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ===== ADMIN MIDDLEWARE =====
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

async function authenticateAdmin(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Yetkilendirme gerekli.' });
    }
    const token = authHeader.split('Bearer ')[1];
    try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.uid = decoded.uid;
        req.email = decoded.email;
        if (!ADMIN_EMAILS.includes((decoded.email || '').toLowerCase())) {
            return res.status(403).json({ error: 'Admin yetkisi gerekli.' });
        }
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Gecersiz token.' });
    }
}

// ===== ADMIN: Check admin status =====
app.get('/admin/check', authenticate, async (req, res) => {
    const isAdmin = ADMIN_EMAILS.includes((req.email || '').toLowerCase());
    // Sync admin status to RTDB so client-side security rules work
    if (isAdmin && req.uid) {
        await db.ref('adminUsers/' + req.uid).set(true);
    }
    res.json({ isAdmin });
});

// ===== ADMIN: List all users =====
app.get('/admin/users', authenticateAdmin, async (req, res) => {
    try {
        const slugsSnap = await db.ref('slugByUid').once('value');
        const users = [];
        
        if (slugsSnap.exists()) {
            const slugData = slugsSnap.val();
            const promises = Object.entries(slugData).map(async ([uid, data]) => {
                const slug = data.slug;
                const pageSnap = await db.ref('pagesBySlug/' + slug).once('value');
                const page = pageSnap.exists() ? pageSnap.val() : {};
                
                // Get Firebase Auth user info
                let authUser = {};
                try {
                    authUser = await admin.auth().getUser(uid);
                } catch (e) {}
                
                // Get badges
                const badgesSnap = await db.ref('userBadges/' + uid).once('value');
                const badges = badgesSnap.exists() ? badgesSnap.val() : {};
                
                // Get ban status
                const banSnap = await db.ref('bannedUsers/' + uid).once('value');
                
                // Get subscription
                const subSnap = await db.ref('userSubscriptions/' + uid).once('value');
                const subscription = subSnap.exists() ? subSnap.val().plan : 'basic';
                
                users.push({
                    uid,
                    slug,
                    email: authUser.email || '',
                    displayName: page.displayName || authUser.displayName || '',
                    photoUrl: page.photoUrl || authUser.photoURL || '',
                    bio: page.bio || '',
                    socials: page.socials || {},
                    createdAt: page.createdAt || null,
                    updatedAt: page.updatedAt || null,
                    banned: banSnap.exists(),
                    banReason: banSnap.exists() ? banSnap.val().reason : '',
                    badges: badges,
                    subscription: subscription,
                    lastSignIn: authUser.metadata ? authUser.metadata.lastSignInTime : null,
                    creationTime: authUser.metadata ? authUser.metadata.creationTime : null,
                    provider: authUser.providerData ? authUser.providerData.map(p => p.providerId).join(', ') : ''
                });
            });
            await Promise.all(promises);
        }
        
        // Also fetch Firebase Auth users who have NOT claimed a slug yet
        const uidSet = new Set(users.map(u => u.uid));
        try {
            const listResult = await admin.auth().listUsers(1000);
            for (const authUser of listResult.users) {
                if (!uidSet.has(authUser.uid)) {
                    const banSnap = await db.ref('bannedUsers/' + authUser.uid).once('value');
                    const subSnap = await db.ref('userSubscriptions/' + authUser.uid).once('value');
                    const badgesSnap = await db.ref('userBadges/' + authUser.uid).once('value');
                    users.push({
                        uid: authUser.uid,
                        slug: '',
                        email: authUser.email || '',
                        displayName: authUser.displayName || '',
                        photoUrl: authUser.photoURL || '',
                        bio: '',
                        socials: {},
                        createdAt: null,
                        updatedAt: null,
                        banned: banSnap.exists(),
                        banReason: banSnap.exists() ? banSnap.val().reason : '',
                        badges: badgesSnap.exists() ? badgesSnap.val() : {},
                        subscription: subSnap.exists() ? subSnap.val().plan : 'basic',
                        lastSignIn: authUser.metadata ? authUser.metadata.lastSignInTime : null,
                        creationTime: authUser.metadata ? authUser.metadata.creationTime : null,
                        provider: authUser.providerData ? authUser.providerData.map(p => p.providerId).join(', ') : '',
                        noSlug: true
                    });
                }
            }
        } catch (e) { console.error('Error fetching slugless users:', e); }

        users.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        res.json({ users, totalCount: users.length });
    } catch (err) {
        console.error('Admin list users error:', err);
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// ===== ADMIN: Get single user details =====
app.get('/admin/users/:uid', authenticateAdmin, async (req, res) => {
    try {
        const uid = req.params.uid;
        const slugSnap = await db.ref('slugByUid/' + uid).once('value');
        if (!slugSnap.exists()) return res.status(404).json({ error: 'Kullanici bulunamadi.' });
        
        const slug = slugSnap.val().slug;
        const pageSnap = await db.ref('pagesBySlug/' + slug).once('value');
        const page = pageSnap.exists() ? pageSnap.val() : {};
        
        let authUser = {};
        try { authUser = await admin.auth().getUser(uid); } catch(e) {}
        
        const badgesSnap = await db.ref('userBadges/' + uid).once('value');
        const banSnap = await db.ref('bannedUsers/' + uid).once('value');
        
        // Count polls and questions
        const pollsSnap = await db.ref('polls').orderByChild('uid').equalTo(uid).once('value');
        const questionsSnap = await db.ref('questions').orderByChild('uid').equalTo(uid).once('value');
        
        res.json({
            uid,
            slug,
            email: authUser.email || '',
            displayName: page.displayName || '',
            photoUrl: page.photoUrl || '',
            bio: page.bio || '',
            socials: page.socials || {},
            blocks: page.blocks || [],
            background: page.background || {},
            badges: badgesSnap.exists() ? badgesSnap.val() : {},
            banned: banSnap.exists(),
            banReason: banSnap.exists() ? banSnap.val().reason : '',
            pollCount: pollsSnap.exists() ? Object.keys(pollsSnap.val()).length : 0,
            questionCount: questionsSnap.exists() ? Object.keys(questionsSnap.val()).length : 0,
            lastSignIn: authUser.metadata ? authUser.metadata.lastSignInTime : null,
            creationTime: authUser.metadata ? authUser.metadata.creationTime : null
        });
    } catch (err) {
        console.error('Admin get user error:', err);
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// ===== ADMIN: Ban/Unban user =====
app.post('/admin/users/:uid/ban', authenticateAdmin, async (req, res) => {
    try {
        const uid = req.params.uid;
        const { reason } = req.body;
        await db.ref('bannedUsers/' + uid).set({
            banned: true,
            reason: reason || 'Admin tarafindan engellendi',
            bannedBy: req.uid,
            bannedAt: admin.database.ServerValue.TIMESTAMP
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

app.post('/admin/users/:uid/unban', authenticateAdmin, async (req, res) => {
    try {
        const uid = req.params.uid;
        await db.ref('bannedUsers/' + uid).remove();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// ===== ADMIN: Badge Management =====

// Create a new badge (admin only)
app.post('/admin/badges', authenticateAdmin, async (req, res) => {
    try {
        const { name, imageUrl, description, type, borderRadius } = req.body;
        if (!name || !imageUrl) return res.status(400).json({ error: 'Rozet adi ve gorsel URL gerekli.' });
        
        const badgeId = 'badge_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
        const allowedRadius = ['none', 'small', 'medium', 'full'];
        const badgeData = {
            id: badgeId,
            name: (name || '').trim().substring(0, 50),
            imageUrl: (imageUrl || '').trim().substring(0, 1000),
            description: (description || '').trim().substring(0, 200),
            type: type || 'custom',
            borderRadius: allowedRadius.includes(borderRadius) ? borderRadius : 'none',
            createdBy: req.uid,
            createdAt: admin.database.ServerValue.TIMESTAMP
        };
        
        await db.ref('badges/' + badgeId).set(badgeData);
        res.json({ success: true, badgeId });
    } catch (err) {
        console.error('Create badge error:', err);
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// List all badges
app.get('/admin/badges', authenticateAdmin, async (req, res) => {
    try {
        const snap = await db.ref('badges').once('value');
        const badges = snap.exists() ? Object.values(snap.val()) : [];
        res.json({ badges });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// Delete a badge
app.delete('/admin/badges/:badgeId', authenticateAdmin, async (req, res) => {
    try {
        const badgeId = req.params.badgeId;
        await db.ref('badges/' + badgeId).remove();
        // Also remove from all users
        const usersSnap = await db.ref('userBadges').once('value');
        if (usersSnap.exists()) {
            const updates = {};
            Object.entries(usersSnap.val()).forEach(([uid, badges]) => {
                if (badges[badgeId]) {
                    updates['userBadges/' + uid + '/' + badgeId] = null;
                }
            });
            if (Object.keys(updates).length > 0) await db.ref().update(updates);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// Grant badge to a specific user
app.post('/admin/users/:uid/badges', authenticateAdmin, async (req, res) => {
    try {
        const uid = req.params.uid;
        const { badgeId } = req.body;
        if (!badgeId) return res.status(400).json({ error: 'Badge ID gerekli.' });
        
        // Check badge exists
        const badgeSnap = await db.ref('badges/' + badgeId).once('value');
        if (!badgeSnap.exists()) return res.status(404).json({ error: 'Rozet bulunamadi.' });
        
        await db.ref('userBadges/' + uid + '/' + badgeId).set({
            grantedBy: req.uid,
            grantedAt: admin.database.ServerValue.TIMESTAMP,
            active: false // user needs to activate in panel
        });
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// Revoke badge from user
app.delete('/admin/users/:uid/badges/:badgeId', authenticateAdmin, async (req, res) => {
    try {
        await db.ref('userBadges/' + req.params.uid + '/' + req.params.badgeId).remove();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// Grant badge to ALL users
app.post('/admin/badges/:badgeId/grant-all', authenticateAdmin, async (req, res) => {
    try {
        const badgeId = req.params.badgeId;
        const badgeSnap = await db.ref('badges/' + badgeId).once('value');
        if (!badgeSnap.exists()) return res.status(404).json({ error: 'Rozet bulunamadi.' });
        
        const slugsSnap = await db.ref('slugByUid').once('value');
        if (!slugsSnap.exists()) return res.json({ success: true, count: 0 });
        
        const updates = {};
        Object.keys(slugsSnap.val()).forEach(uid => {
            updates['userBadges/' + uid + '/' + badgeId] = {
                grantedBy: req.uid,
                grantedAt: Date.now(),
                active: false
            };
        });
        
        await db.ref().update(updates);
        res.json({ success: true, count: Object.keys(slugsSnap.val()).length });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// ===== USER: Get my badges =====
app.get('/my-badges', authenticate, async (req, res) => {
    try {
        const uid = req.uid;
        const userBadgesSnap = await db.ref('userBadges/' + uid).once('value');
        const allBadgesSnap = await db.ref('badges').once('value');
        
        const allBadges = allBadgesSnap.exists() ? allBadgesSnap.val() : {};
        const userBadges = userBadgesSnap.exists() ? userBadgesSnap.val() : {};
        
        const result = Object.values(allBadges).map(badge => ({
            ...badge,
            owned: !!userBadges[badge.id],
            active: userBadges[badge.id] ? !!userBadges[badge.id].active : false
        }));
        
        res.json({ badges: result });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// ===== USER: Toggle badge active state =====
app.post('/my-badges/:badgeId/toggle', authenticate, async (req, res) => {
    try {
        const uid = req.uid;
        const badgeId = req.params.badgeId;
        
        const snap = await db.ref('userBadges/' + uid + '/' + badgeId).once('value');
        if (!snap.exists()) return res.status(403).json({ error: 'Bu rozet size ait degil.' });
        
        const current = snap.val();
        const newActive = !current.active;
        await db.ref('userBadges/' + uid + '/' + badgeId + '/active').set(newActive);
        
        res.json({ success: true, active: newActive });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// ===== PUBLIC: Get user badges for display =====
app.get('/badges/:slug', async (req, res) => {
    try {
        const slug = req.params.slug;
        // Find uid from slug
        const pageSnap = await db.ref('pagesBySlug/' + slug).once('value');
        if (!pageSnap.exists()) return res.status(404).json({ error: 'Sayfa bulunamadi.' });
        
        const uid = pageSnap.val().uid;
        const userBadgesSnap = await db.ref('userBadges/' + uid).once('value');
        const allBadgesSnap = await db.ref('badges').once('value');
        
        const allBadges = allBadgesSnap.exists() ? allBadgesSnap.val() : {};
        const userBadges = userBadgesSnap.exists() ? userBadgesSnap.val() : {};
        
        // Only return active badges with all properties including borderRadius
        const activeBadges = Object.entries(userBadges)
            .filter(([id, data]) => data.active && allBadges[id])
            .map(([id]) => ({
                id: allBadges[id].id,
                name: allBadges[id].name,
                imageUrl: allBadges[id].imageUrl,
                description: allBadges[id].description || '',
                type: allBadges[id].type || 'custom',
                borderRadius: allBadges[id].borderRadius || 'none'
            }));
        
        // Check if user has any verified type badge active
        const hasVerified = activeBadges.some(b => b.type === 'verified');
        
        res.json({ badges: activeBadges, verified: hasVerified });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// ===== ADMIN: Delete user completely =====
app.delete('/admin/users/:uid', authenticateAdmin, async (req, res) => {
    try {
        const uid = req.params.uid;
        const slugSnap = await db.ref('slugByUid/' + uid).once('value');
        if (!slugSnap.exists()) return res.status(404).json({ error: 'Kullanici bulunamadi.' });
        const slug = slugSnap.val().slug;

        // Delete all user data
        await db.ref('pagesBySlug/' + slug).remove();
        await db.ref('slugByUid/' + uid).remove();
        await db.ref('userBadges/' + uid).remove();
        await db.ref('bannedUsers/' + uid).remove();
        await db.ref('userSubscriptions/' + uid).remove();

        // Delete polls
        const pollsSnap = await db.ref('polls').orderByChild('uid').equalTo(uid).once('value');
        if (pollsSnap.exists()) {
            const updates = {};
            Object.keys(pollsSnap.val()).forEach(pollId => {
                updates['polls/' + pollId] = null;
                updates['pollVotes/' + pollId] = null;
            });
            await db.ref().update(updates);
        }

        // Delete questions
        const qSnap = await db.ref('questions').orderByChild('uid').equalTo(uid).once('value');
        if (qSnap.exists()) {
            const updates = {};
            Object.keys(qSnap.val()).forEach(qId => {
                updates['questions/' + qId] = null;
                updates['questionAnswers/' + qId] = null;
            });
            await db.ref().update(updates);
        }

        res.json({ success: true, deletedSlug: slug });
    } catch (err) {
        console.error('Delete user error:', err);
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// ===== SUBSCRIPTION SYSTEM =====
// Subscription plans & category access are managed by admin

// GET /subscription-plans — Public: get all plans
app.get('/subscription-plans', async (req, res) => {
    try {
        const snap = await db.ref('subscriptionPlans').once('value');
        const plans = snap.exists() ? snap.val() : {};
        // Default plans if none exist
        if (!plans.basic) {
            const defaults = {
                basic: { id: 'basic', name: 'Basic', order: 1, description: 'Temel ozellikler', color: '#888', categories: {} },
                pro: { id: 'pro', name: 'Pro', order: 2, description: 'Gelismis ozellikler', color: '#3b82f6', categories: {} },
                premium: { id: 'premium', name: 'Premium', order: 3, description: 'Tum ozellikler', color: '#f59e0b', categories: {} }
            };
            await db.ref('subscriptionPlans').set(defaults);
            return res.json({ plans: defaults });
        }
        res.json({ plans });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// GET /my-subscription — Get current user subscription
app.get('/my-subscription', authenticate, async (req, res) => {
    try {
        const uid = req.uid;
        const snap = await db.ref('userSubscriptions/' + uid).once('value');
        if (!snap.exists()) {
            // Default to basic
            return res.json({ plan: 'basic', grantedAt: null });
        }
        res.json(snap.val());
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// GET /my-plan — Get user's current plan
app.get('/my-plan', authenticate, async (req, res) => {
    try {
        const uid = req.uid;
        const snap = await db.ref('userSubscriptions/' + uid).once('value');
        res.json({ plan: snap.exists() ? snap.val().plan : 'basic' });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// GET /plan-locks — Get locked categories for the current user's plan
app.get('/plan-locks', authenticate, async (req, res) => {
    try {
        const uid = req.uid;
        const subSnap = await db.ref('userSubscriptions/' + uid).once('value');
        const userPlan = subSnap.exists() ? subSnap.val().plan : 'basic';
        const configSnap = await db.ref('planAccessConfig').once('value');

        const allCategories = ['profil', 'sosyal', 'butonlar', 'tasarim', 'buton', 'profil-foto', 'icerik', 'anket', 'soru', 'katman', 'rozetler'];
        const defaultAccess = {
            basic: ['profil', 'sosyal', 'butonlar', 'tasarim'],
            pro: ['profil', 'sosyal', 'butonlar', 'tasarim', 'buton', 'profil-foto', 'icerik'],
            premium: allCategories
        };

        let planAccess;
        if (configSnap.exists()) {
            const config = configSnap.val();
            planAccess = config[userPlan] || defaultAccess[userPlan] || [];
        } else {
            planAccess = defaultAccess[userPlan] || [];
        }

        const lockedCategories = allCategories.filter(cat => !planAccess.includes(cat));
        res.json({ plan: userPlan, lockedCategories, allowedCategories: planAccess });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// GET /plan-config — Public: get plan display data
app.get('/plan-config', async (req, res) => {
    try {
        const configSnap = await db.ref('planAccessConfig').once('value');
        const config = configSnap.exists() ? configSnap.val() : null;

        const allCategories = ['profil', 'sosyal', 'butonlar', 'tasarim', 'buton', 'profil-foto', 'icerik', 'anket', 'soru', 'katman', 'rozetler'];
        const catLabels = { profil: 'Profil', sosyal: 'Sosyal Medya', butonlar: 'Ozel Butonlar', tasarim: 'Arka Plan', buton: 'Buton Stili', 'profil-foto': 'Foto Stili', icerik: 'Bloklar', anket: 'Anketler', soru: 'Soru & Cevap', katman: 'Katman Sirasi', rozetler: 'Rozetler' };

        const defaultAccess = {
            basic: ['profil', 'sosyal', 'butonlar', 'tasarim'],
            pro: ['profil', 'sosyal', 'butonlar', 'tasarim', 'buton', 'profil-foto', 'icerik'],
            premium: allCategories
        };

        const access = config || defaultAccess;

        const plans = [
            { id: 'basic', name: 'Basic', desc: 'Ucretsiz plan. Temel ozellikler.',
                features: (access.basic || []).map(c => catLabels[c] || c),
                locked: allCategories.filter(c => !(access.basic || []).includes(c)).map(c => catLabels[c] || c) },
            { id: 'pro', name: 'Pro', desc: 'Gelismis ozellikler ve erisim.',
                features: (access.pro || []).map(c => catLabels[c] || c),
                locked: allCategories.filter(c => !(access.pro || []).includes(c)).map(c => catLabels[c] || c) },
            { id: 'premium', name: 'Premium', desc: 'Tum ozellikler sinirsiz.',
                features: (access.premium || []).map(c => catLabels[c] || c),
                locked: allCategories.filter(c => !(access.premium || []).includes(c)).map(c => catLabels[c] || c) }
        ];

        res.json({ plans });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// ADMIN: GET /admin/plan-config — Get plan access config
app.get('/admin/plan-config', authenticateAdmin, async (req, res) => {
    try {
        const snap = await db.ref('planAccessConfig').once('value');
        res.json({ config: snap.exists() ? snap.val() : null });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// ADMIN: PUT /admin/plan-config — Save plan access config
app.put('/admin/plan-config', authenticateAdmin, async (req, res) => {
    try {
        const { config } = req.body;
        if (!config) return res.status(400).json({ error: 'Config gerekli.' });
        await db.ref('planAccessConfig').set(config);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// ADMIN: POST /admin/change-plan — Change user plan by slug
app.post('/admin/change-plan', authenticateAdmin, async (req, res) => {
    try {
        const { slug, plan } = req.body;
        if (!slug) return res.status(400).json({ error: 'Slug gerekli.' });
        if (!['basic', 'pro', 'premium'].includes(plan)) return res.status(400).json({ error: 'Gecersiz plan.' });

        // Find uid by slug
        const pageSnap = await db.ref('pagesBySlug/' + slug).once('value');
        if (!pageSnap.exists()) return res.status(404).json({ error: 'Kullanici bulunamadi.' });
        const uid = pageSnap.val().uid;

        await db.ref('userSubscriptions/' + uid).set({
            plan: plan,
            grantedBy: req.uid,
            grantedAt: admin.database.ServerValue.TIMESTAMP
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// ADMIN: Update plan category access
app.put('/admin/subscription-plans/:planId', authenticateAdmin, async (req, res) => {
    try {
        const planId = req.params.planId;
        const { categories, description, color } = req.body;
        const updates = {};
        if (categories !== undefined) updates['subscriptionPlans/' + planId + '/categories'] = categories;
        if (description !== undefined) updates['subscriptionPlans/' + planId + '/description'] = description;
        if (color !== undefined) updates['subscriptionPlans/' + planId + '/color'] = color;
        await db.ref().update(updates);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// ADMIN: Set user subscription plan
app.post('/admin/users/:uid/subscription', authenticateAdmin, async (req, res) => {
    try {
        const uid = req.params.uid;
        const { plan } = req.body;
        if (!['basic', 'pro', 'premium'].includes(plan)) return res.status(400).json({ error: 'Gecersiz plan.' });
        await db.ref('userSubscriptions/' + uid).set({
            plan: plan,
            grantedBy: req.uid,
            grantedAt: admin.database.ServerValue.TIMESTAMP
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// ===== ACCESS CODES =====
// ADMIN: Create access code
app.post('/admin/access-codes', authenticateAdmin, async (req, res) => {
    try {
        const { code, badgeId, planUpgrade, maxUses, description } = req.body;
        if (!code || code.length < 3) return res.status(400).json({ error: 'Kod en az 3 karakter olmali.' });
        const codeId = code.toUpperCase().replace(/[^A-Z0-9_-]/g, '');
        const existing = await db.ref('accessCodes/' + codeId).once('value');
        if (existing.exists()) return res.status(409).json({ error: 'Bu kod zaten var.' });
        await db.ref('accessCodes/' + codeId).set({
            id: codeId,
            code: codeId,
            badgeId: badgeId || null,
            planUpgrade: planUpgrade || null,
            maxUses: parseInt(maxUses) || 0,
            usedCount: 0,
            description: (description || '').substring(0, 200),
            createdBy: req.uid,
            createdAt: admin.database.ServerValue.TIMESTAMP,
            active: true
        });
        res.json({ success: true, code: codeId });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// ADMIN: List all access codes
app.get('/admin/access-codes', authenticateAdmin, async (req, res) => {
    try {
        const snap = await db.ref('accessCodes').once('value');
        const codes = snap.exists() ? Object.values(snap.val()) : [];
        res.json({ codes });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// ADMIN: Delete access code
app.delete('/admin/access-codes/:codeId', authenticateAdmin, async (req, res) => {
    try {
        await db.ref('accessCodes/' + req.params.codeId).remove();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// USER: Redeem access code
app.post('/redeem-code', authenticate, async (req, res) => {
    try {
        const uid = req.uid;
        const { code } = req.body;
        if (!code) return res.status(400).json({ error: 'Kod gerekli.' });
        const codeId = code.toUpperCase().replace(/[^A-Z0-9_-]/g, '');
        const codeSnap = await db.ref('accessCodes/' + codeId).once('value');
        if (!codeSnap.exists()) return res.status(404).json({ error: 'Gecersiz kod.' });
        const codeData = codeSnap.val();
        if (!codeData.active) return res.status(400).json({ error: 'Bu kod artik aktif degil.' });
        if (codeData.maxUses > 0 && codeData.usedCount >= codeData.maxUses) return res.status(400).json({ error: 'Bu kodun kullanim limiti dolmus.' });

        // Check if user already used this code
        const usedSnap = await db.ref('codeRedemptions/' + codeId + '/' + uid).once('value');
        if (usedSnap.exists()) return res.status(400).json({ error: 'Bu kodu zaten kullandiniz.' });

        const rewards = [];

        // Grant badge if specified
        if (codeData.badgeId) {
            const badgeSnap = await db.ref('badges/' + codeData.badgeId).once('value');
            if (badgeSnap.exists()) {
                await db.ref('userBadges/' + uid + '/' + codeData.badgeId).set({
                    grantedBy: 'code:' + codeId,
                    grantedAt: admin.database.ServerValue.TIMESTAMP,
                    active: false
                });
                rewards.push({ type: 'badge', badge: badgeSnap.val() });
            }
        }

        // Upgrade plan if specified
        if (codeData.planUpgrade && ['pro', 'premium'].includes(codeData.planUpgrade)) {
            await db.ref('userSubscriptions/' + uid).set({
                plan: codeData.planUpgrade,
                grantedBy: 'code:' + codeId,
                grantedAt: admin.database.ServerValue.TIMESTAMP
            });
            rewards.push({ type: 'plan', plan: codeData.planUpgrade });
        }

        // Record redemption
        await db.ref('codeRedemptions/' + codeId + '/' + uid).set({
            redeemedAt: admin.database.ServerValue.TIMESTAMP
        });
        await db.ref('accessCodes/' + codeId + '/usedCount').transaction(c => (c || 0) + 1);

        res.json({ success: true, rewards });
    } catch (err) {
        console.error('Redeem code error:', err);
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// ===== SHOWCASE PROFILES (Admin managed) =====
app.get('/showcase-profiles', async (req, res) => {
    try {
        const snap = await db.ref('showcaseProfiles').once('value');
        const slugs = snap.exists() ? Object.values(snap.val()) : [];
        const profiles = [];
        for (const item of slugs) {
            const pageSnap = await db.ref('pagesBySlug/' + item.slug).once('value');
            if (pageSnap.exists()) {
                const p = pageSnap.val();
                profiles.push({
                    slug: p.slug,
                    displayName: p.displayName || '',
                    photoUrl: p.photoUrl || '',
                    bio: p.bio || '',
                    background: p.background || {},
                    order: item.order || 0
                });
            }
        }
        profiles.sort((a, b) => (a.order || 0) - (b.order || 0));
        res.json({ profiles });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

app.post('/admin/showcase-profiles', authenticateAdmin, async (req, res) => {
    try {
        const { slug, order } = req.body;
        if (!slug) return res.status(400).json({ error: 'Slug gerekli.' });
        const pageSnap = await db.ref('pagesBySlug/' + slug).once('value');
        if (!pageSnap.exists()) return res.status(404).json({ error: 'Sayfa bulunamadi.' });
        const id = 'sc_' + Date.now();
        await db.ref('showcaseProfiles/' + id).set({ id, slug, order: order || 0, addedAt: admin.database.ServerValue.TIMESTAMP });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

app.delete('/admin/showcase-profiles/:id', authenticateAdmin, async (req, res) => {
    try {
        await db.ref('showcaseProfiles/' + req.params.id).remove();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

app.get('/admin/showcase-profiles', authenticateAdmin, async (req, res) => {
    try {
        const snap = await db.ref('showcaseProfiles').once('value');
        const items = snap.exists() ? Object.values(snap.val()) : [];
        res.json({ items });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// ===== Ban check middleware for page access =====
app.get('/ban-check/:uid', async (req, res) => {
    try {
        const snap = await db.ref('bannedUsers/' + req.params.uid).once('value');
        res.json({ banned: snap.exists() });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// ===== Page View Tracking =====
app.post('/page-view/:slug', async (req, res) => {
    try {
        const slug = req.params.slug;
        const now = new Date();
        const dateKey = now.toISOString().split('T')[0]; // YYYY-MM-DD
        const hourKey = now.getHours().toString();
        await db.ref('pageViews/' + slug + '/daily/' + dateKey).transaction(val => (val || 0) + 1);
        await db.ref('pageViews/' + slug + '/hourly/' + dateKey + '/' + hourKey).transaction(val => (val || 0) + 1);
        await db.ref('pageViews/' + slug + '/total').transaction(val => (val || 0) + 1);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

app.get('/page-stats/:slug', authenticate, async (req, res) => {
    try {
        const slug = req.params.slug;
        // Verify ownership
        const pageSnap = await db.ref('pagesBySlug/' + slug).once('value');
        if (!pageSnap.exists() || pageSnap.val().uid !== req.uid) {
            return res.status(403).json({ error: 'Yetki yok.' });
        }
        const snap = await db.ref('pageViews/' + slug).once('value');
        const data = snap.exists() ? snap.val() : { daily: {}, hourly: {}, total: 0 };
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// ===== Admin Custom Icons =====
app.get('/custom-icons', async (req, res) => {
    try {
        const snap = await db.ref('customIcons').once('value');
        const icons = snap.exists() ? Object.values(snap.val()) : [];
        res.json({ icons });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

app.post('/admin/custom-icons', authenticateAdmin, async (req, res) => {
    try {
        const { name, imageUrl, borderRadius } = req.body;
        if (!name || !imageUrl) return res.status(400).json({ error: 'Isim ve gorsel gerekli.' });
        const id = 'ci_' + Date.now();
        const iconData = {
            id,
            name: name.substring(0, 100),
            imageUrl: imageUrl.substring(0, 1000),
            borderRadius: ['none', 'small', 'medium', 'full'].includes(borderRadius) ? borderRadius : 'medium',
            createdAt: admin.database.ServerValue.TIMESTAMP
        };
        await db.ref('customIcons/' + id).set(iconData);
        res.json({ success: true, icon: iconData });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

app.delete('/admin/custom-icons/:id', authenticateAdmin, async (req, res) => {
    try {
        await db.ref('customIcons/' + req.params.id).remove();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// ===== Documents =====
function generateDocNumber() {
    const num = Math.floor(10000000 + Math.random() * 90000000).toString();
    return num.substring(0, 4) + '-' + num.substring(4);
}

app.post('/documents', authenticate, async (req, res) => {
    try {
        const uid = req.uid;
        const userSlugSnap = await db.ref('slugByUid/' + uid).once('value');
        if (!userSlugSnap.exists()) return res.status(400).json({ error: 'Slug bulunamadi.' });
        const slug = userSlugSnap.val().slug;

        // Generate unique doc number
        let docNumber;
        let attempts = 0;
        do {
            docNumber = generateDocNumber();
            const existing = await db.ref('documents/' + docNumber).once('value');
            if (!existing.exists()) break;
            attempts++;
        } while (attempts < 10);

        // Get page stats
        const statsSnap = await db.ref('pageViews/' + slug).once('value');
        const stats = statsSnap.exists() ? statsSnap.val() : { daily: {}, total: 0 };

        const now = new Date();
        const docData = {
            docNumber,
            slug,
            uid,
            createdAt: now.toISOString(),
            createdAtTimestamp: admin.database.ServerValue.TIMESTAMP,
            stats: {
                total: stats.total || 0,
                daily: stats.daily || {}
            }
        };

        await db.ref('documents/' + docNumber).set(docData);
        // Also index under user
        await db.ref('userDocuments/' + uid + '/' + docNumber).set({ createdAt: now.toISOString() });

        res.json({ success: true, document: docData });
    } catch (err) {
        res.status(500).json({ error: 'Belge olusturulamadi.' });
    }
});

app.get('/documents/:docNumber', async (req, res) => {
    try {
        const docNumber = req.params.docNumber;
        if (!/^\d{4}-\d{4}$/.test(docNumber)) return res.status(400).json({ error: 'Gecersiz belge numarasi.' });
        const snap = await db.ref('documents/' + docNumber).once('value');
        if (!snap.exists()) return res.status(404).json({ error: 'Belge bulunamadi.' });
        res.json(snap.val());
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

app.get('/user-documents/:uid', authenticate, async (req, res) => {
    try {
        const uid = req.params.uid;
        const snap = await db.ref('userDocuments/' + uid).once('value');
        if (!snap.exists()) return res.json({ documents: [] });
        const docKeys = Object.keys(snap.val());
        const docs = [];
        for (const key of docKeys) {
            const docSnap = await db.ref('documents/' + key).once('value');
            if (docSnap.exists()) docs.push(docSnap.val());
        }
        res.json({ documents: docs });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// Admin: list all documents
app.get('/admin/documents', authenticateAdmin, async (req, res) => {
    try {
        const snap = await db.ref('documents').once('value');
        if (!snap.exists()) return res.json({ documents: [] });
        const docs = Object.values(snap.val());
        docs.sort((a, b) => (b.createdAtTimestamp || 0) - (a.createdAtTimestamp || 0));
        res.json({ documents: docs });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// ===== R2 Image Upload (Presigned URL) =====
// POST /upload/presign — Generate presigned PUT URL for R2
app.post('/upload/presign', authenticate, async (req, res) => {
    try {
        const uid = req.uid;
        const { type, target } = req.body; // type: 'avatar' | 'background', target: slug

        if (!type || !['avatar', 'background'].includes(type)) {
            return res.status(400).json({ error: 'Gecersiz tip. avatar veya background olmali.' });
        }

        // Verify ownership
        const userSlugSnap = await db.ref('slugByUid/' + uid).once('value');
        if (!userSlugSnap.exists()) {
            return res.status(403).json({ error: 'Slug bulunamadi.' });
        }

        const contentType = req.body.contentType || 'image/webp';
        const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
        if (!allowedTypes.includes(contentType)) {
            return res.status(400).json({ error: 'Sadece JPEG, PNG ve WebP desteklenir.' });
        }

        const ext = contentType === 'image/jpeg' ? 'jpg' : contentType === 'image/png' ? 'png' : 'webp';
        const folder = type === 'avatar' ? 'avatars' : 'backgrounds';
        const timestamp = Date.now();
        const key = folder + '/' + uid + '-' + timestamp + '.' + ext;

        const command = new PutObjectCommand({
            Bucket: process.env.R2_BUCKET,
            Key: key,
            ContentType: contentType
        });

        const uploadUrl = await getSignedUrl(R2, command, { expiresIn: 300 }); // 5 min
        const publicUrl = 'https://cdn.leng.tr/' + key;

        res.json({ uploadUrl, publicUrl, key });
    } catch (err) {
        console.error('Presign error:', err);
        res.status(500).json({ error: 'Presign URL olusturulamadi.' });
    }
});

// POST /upload/confirm — Confirm upload and save URL to Firebase
app.post('/upload/confirm', authenticate, async (req, res) => {
    try {
        const uid = req.uid;
        const { type, publicUrl } = req.body;

        if (!type || !publicUrl) {
            return res.status(400).json({ error: 'Tip ve URL gerekli.' });
        }

        // Verify ownership
        const userSlugSnap = await db.ref('slugByUid/' + uid).once('value');
        if (!userSlugSnap.exists()) {
            return res.status(403).json({ error: 'Slug bulunamadi.' });
        }
        const slug = userSlugSnap.val().slug;

        // Read current URL to find old R2 key
        let oldKey = null;
        if (type === 'avatar') {
            const oldSnap = await db.ref('pagesBySlug/' + slug + '/photoUrl').once('value');
            const oldUrl = oldSnap.val();
            if (oldUrl && oldUrl.includes('cdn.leng.tr/')) {
                oldKey = oldUrl.split('cdn.leng.tr/')[1];
            }
        } else if (type === 'background') {
            const oldSnap = await db.ref('pagesBySlug/' + slug + '/background/imageUrl').once('value');
            const oldUrl = oldSnap.val();
            if (oldUrl && oldUrl.includes('cdn.leng.tr/')) {
                oldKey = oldUrl.split('cdn.leng.tr/')[1];
            }
        }

        // Delete old object from R2 if exists
        if (oldKey) {
            try {
                await R2.send(new DeleteObjectCommand({
                    Bucket: process.env.R2_BUCKET,
                    Key: oldKey
                }));
                console.log('Deleted old R2 object:', oldKey);
            } catch (delErr) {
                console.warn('Failed to delete old R2 object:', oldKey, delErr.message);
            }
        }

        // Save new URL to Firebase
        if (type === 'avatar') {
            await db.ref('pagesBySlug/' + slug + '/photoUrl').set(publicUrl);
        } else if (type === 'background') {
            await db.ref('pagesBySlug/' + slug + '/background/imageUrl').set(publicUrl);
        }

        res.json({ success: true, publicUrl, deletedOld: oldKey || null });
    } catch (err) {
        console.error('Confirm upload error:', err);
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// ===== ADMIN: Change user slug =====
app.post('/admin/change-slug', authenticateAdmin, async (req, res) => {
    try {
        const { uid, oldSlug, newSlug } = req.body;

        if (!uid || !oldSlug || !newSlug) {
            return res.status(400).json({ error: 'uid, oldSlug ve newSlug gerekli.' });
        }

        // Validate new slug
        if (!/^[a-z0-9]+$/.test(newSlug) || newSlug.length < 2 || newSlug.length > 30) {
            return res.status(400).json({ error: 'Yeni slug gecersiz. 2-30 karakter, sadece kucuk harf ve rakam.' });
        }

        const reserved = ['admin', 'panel', 'api', 'login', 'register', 'settings', 'about', 'contact', 'help', 'support', 'dash', 'kisalt'];
        if (reserved.includes(newSlug)) {
            return res.status(400).json({ error: 'Bu slug kullanilamaz.' });
        }

        // Check if new slug is taken
        const existingPage = await db.ref('pagesBySlug/' + newSlug).once('value');
        if (existingPage.exists()) {
            return res.status(409).json({ error: 'Bu slug zaten kullanimda.' });
        }

        // Get old page data
        const oldPageSnap = await db.ref('pagesBySlug/' + oldSlug).once('value');
        if (!oldPageSnap.exists()) {
            return res.status(404).json({ error: 'Eski sayfa bulunamadi.' });
        }

        const pageData = oldPageSnap.val();
        pageData.slug = newSlug;
        pageData.updatedAt = admin.database.ServerValue.TIMESTAMP;

        // Write new slug data
        await db.ref('pagesBySlug/' + newSlug).set(pageData);
        // Update slugByUid
        await db.ref('slugByUid/' + uid).set({ slug: newSlug });
        // Delete old slug
        await db.ref('pagesBySlug/' + oldSlug).remove();

        // Update polls with new slug
        const pollsSnap = await db.ref('polls').orderByChild('slug').equalTo(oldSlug).once('value');
        if (pollsSnap.exists()) {
            const updates = {};
            Object.keys(pollsSnap.val()).forEach(pollId => {
                updates['polls/' + pollId + '/slug'] = newSlug;
            });
            await db.ref().update(updates);
        }

        // Update questions with new slug
        const qSnap = await db.ref('questions').orderByChild('slug').equalTo(oldSlug).once('value');
        if (qSnap.exists()) {
            const updates = {};
            Object.keys(qSnap.val()).forEach(qId => {
                updates['questions/' + qId + '/slug'] = newSlug;
            });
            await db.ref().update(updates);
        }

        // Move page views
        const viewsSnap = await db.ref('pageViews/' + oldSlug).once('value');
        if (viewsSnap.exists()) {
            await db.ref('pageViews/' + newSlug).set(viewsSnap.val());
            await db.ref('pageViews/' + oldSlug).remove();
        }

        res.json({ success: true, oldSlug, newSlug });
    } catch (err) {
        console.error('Change slug error:', err);
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// ADMIN: POST /admin/find-user-by-email — Find Firebase Auth user by email
app.post('/admin/find-user-by-email', authenticateAdmin, async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'E-posta gerekli.' });
        const userRecord = await admin.auth().getUserByEmail(email);
        const slugSnap = await db.ref('slugByUid/' + userRecord.uid).once('value');
        const slug = slugSnap.exists() ? slugSnap.val().slug : null;
        res.json({
            uid: userRecord.uid,
            email: userRecord.email,
            displayName: userRecord.displayName || '',
            photoURL: userRecord.photoURL || '',
            slug: slug
        });
    } catch (err) {
        if (err.code === 'auth/user-not-found') return res.status(404).json({ error: 'Bu e-posta ile kullanici bulunamadi.' });
        console.error('Find user by email error:', err);
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// ADMIN: POST /admin/transfer-page — Transfer a page from one user to another
app.post('/admin/transfer-page', authenticateAdmin, async (req, res) => {
    try {
        const { slug, fromUid, toEmail } = req.body;
        if (!slug || !fromUid || !toEmail) return res.status(400).json({ error: 'slug, fromUid ve toEmail gerekli.' });

        // Find target user by email
        let targetUser;
        try {
            targetUser = await admin.auth().getUserByEmail(toEmail);
        } catch (e) {
            return res.status(404).json({ error: 'Hedef e-posta ile kullanici bulunamadi. Kullanici once sisteme giris yapmis olmali.' });
        }

        const toUid = targetUser.uid;
        if (fromUid === toUid) return res.status(400).json({ error: 'Kaynak ve hedef kullanici ayni olamaz.' });

        // Check if target user already has a slug
        const targetSlugSnap = await db.ref('slugByUid/' + toUid).once('value');
        if (targetSlugSnap.exists()) {
            return res.status(409).json({ error: 'Hedef kullanicinin zaten bir sayfasi var (' + targetSlugSnap.val().slug + '). Once o sayfayi silmeniz gerekir.' });
        }

        // Verify page exists
        const pageSnap = await db.ref('pagesBySlug/' + slug).once('value');
        if (!pageSnap.exists()) return res.status(404).json({ error: 'Sayfa bulunamadi.' });

        // Transfer: update slugByUid for both users
        await db.ref('slugByUid/' + fromUid).remove();
        await db.ref('slugByUid/' + toUid).set({ slug: slug });

        // Update page data owner info
        await db.ref('pagesBySlug/' + slug + '/transferredAt').set(admin.database.ServerValue.TIMESTAMP);
        await db.ref('pagesBySlug/' + slug + '/transferredFrom').set(fromUid);

        res.json({ success: true, slug, fromUid, toUid, toEmail });
    } catch (err) {
        console.error('Transfer page error:', err);
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// ===== Short Links =====
// POST /short-links — Create a short link (authenticated)
app.post('/short-links', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Yetkisiz.' });
        const token = authHeader.split('Bearer ')[1];
        const decoded = await admin.auth().verifyIdToken(token);
        const uid = decoded.uid;

        const { url } = req.body;
        if (!url) return res.status(400).json({ error: 'URL gerekli.' });

        // Validate URL
        try { new URL(url); } catch (e) { return res.status(400).json({ error: 'Gecerli bir URL girin.' }); }

        // Generate unique short code (uppercase + digits)
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let code, exists = true, attempts = 0;
        while (exists && attempts < 15) {
            code = '';
            for (let i = 0; i < 5; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
            const snap = await db.ref('shortLinks/' + code).once('value');
            exists = snap.exists();
            attempts++;
        }
        if (exists) return res.status(500).json({ error: 'Kod uretilemedi, tekrar deneyin.' });

        await db.ref('shortLinks/' + code).set({
            url: url,
            uid: uid,
            createdAt: admin.database.ServerValue.TIMESTAMP,
            clicks: 0
        });

        res.json({ code, url });
    } catch (err) {
        console.error('Create short link error:', err);
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// GET /short-links — List user's short links (authenticated)
app.get('/short-links', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Yetkisiz.' });
        const token = authHeader.split('Bearer ')[1];
        const decoded = await admin.auth().verifyIdToken(token);
        const uid = decoded.uid;

        const snap = await db.ref('shortLinks').orderByChild('uid').equalTo(uid).once('value');
        const links = [];
        if (snap.exists()) {
            snap.forEach(child => {
                links.push({ code: child.key, ...child.val() });
            });
        }
        links.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        res.json({ links });
    } catch (err) {
        console.error('List short links error:', err);
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// DELETE /short-links/:code — Delete a short link (authenticated, owner only)
app.delete('/short-links/:code', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Yetkisiz.' });
        const token = authHeader.split('Bearer ')[1];
        const decoded = await admin.auth().verifyIdToken(token);
        const uid = decoded.uid;

        const { code } = req.params;
        const snap = await db.ref('shortLinks/' + code).once('value');
        if (!snap.exists()) return res.status(404).json({ error: 'Link bulunamadi.' });
        if (snap.val().uid !== uid) return res.status(403).json({ error: 'Bu link size ait degil.' });

        await db.ref('shortLinks/' + code).remove();
        res.json({ success: true });
    } catch (err) {
        console.error('Delete short link error:', err);
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// GET /r/:code — Redirect short link (public, no auth needed)
app.get('/r/:code', async (req, res) => {
    try {
        const { code } = req.params;
        const snap = await db.ref('shortLinks/' + code).once('value');
        if (!snap.exists()) return res.status(404).json({ error: 'Link bulunamadi.' });

        const data = snap.val();
        // Increment clicks
        await db.ref('shortLinks/' + code + '/clicks').set(admin.database.ServerValue.increment(1));
        res.redirect(302, data.url);
    } catch (err) {
        console.error('Redirect short link error:', err);
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// GET /short-links/resolve/:code — Resolve short link without redirect (public)
app.get('/short-links/resolve/:code', async (req, res) => {
    try {
        const { code } = req.params;
        const snap = await db.ref('shortLinks/' + code).once('value');
        if (!snap.exists()) return res.status(404).json({ error: 'Link bulunamadi.' });
        const data = snap.val();
        // Increment clicks
        await db.ref('shortLinks/' + code + '/clicks').set(admin.database.ServerValue.increment(1));
        res.json({ url: data.url });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatasi.' });
    }
});

// ===== AGENCY ENDPOINTS =====

// POST /admin/agencies — Create agency (admin only)
app.post('/admin/agencies', authenticateAdmin, async (req, res) => {
    try {
        const { name, code, logoUrl, email } = req.body;
        if (!name || !code || !email) return res.status(400).json({ error: 'Ajans adi, kodu ve email gerekli.' });
        // Check code uniqueness
        const existing = await db.ref('agencies').orderByChild('code').equalTo(code.toUpperCase()).once('value');
        if (existing.exists()) return res.status(400).json({ error: 'Bu ajans kodu zaten kullaniliyor.' });
        const agencyId = db.ref('agencies').push().key;
        await db.ref('agencies/' + agencyId).set({
            name, code: code.toUpperCase(), logoUrl: logoUrl || '', email: email.toLowerCase(),
            createdAt: admin.database.ServerValue.TIMESTAMP
        });
        res.json({ id: agencyId, code: code.toUpperCase() });
    } catch (err) { console.error('Create agency error:', err); res.status(500).json({ error: 'Sunucu hatasi.' }); }
});

// GET /admin/agencies — List all agencies (admin only)
app.get('/admin/agencies', authenticateAdmin, async (req, res) => {
    try {
        const snap = await db.ref('agencies').once('value');
        const agencies = [];
        if (snap.exists()) {
            for (const [id, data] of Object.entries(snap.val())) {
                const membersSnap = await db.ref('agencyMembers/' + id).once('value');
                agencies.push({ id, ...data, memberCount: membersSnap.exists() ? Object.keys(membersSnap.val()).length : 0 });
            }
        }
        res.json({ agencies });
    } catch (err) { res.status(500).json({ error: 'Sunucu hatasi.' }); }
});

// DELETE /admin/agencies/:id — Delete agency (admin only)
app.delete('/admin/agencies/:id', authenticateAdmin, async (req, res) => {
    try {
        await db.ref('agencies/' + req.params.id).remove();
        await db.ref('agencyMembers/' + req.params.id).remove();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Sunucu hatasi.' }); }
});

// PUT /admin/agencies/:id — Update agency (admin only)
app.put('/admin/agencies/:id', authenticateAdmin, async (req, res) => {
    try {
        const { name, code, logoUrl, email } = req.body;
        const updates = {};
        if (name) updates.name = name;
        if (code) updates.code = code.toUpperCase();
        if (logoUrl !== undefined) updates.logoUrl = logoUrl;
        if (email) updates.email = email.toLowerCase();
        await db.ref('agencies/' + req.params.id).update(updates);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Sunucu hatasi.' }); }
});

// POST /agency/join — User joins agency by code
app.post('/agency/join', authenticate, async (req, res) => {
    try {
        const { code } = req.body;
        if (!code) return res.status(400).json({ error: 'Ajans kodu gerekli.' });
        const snap = await db.ref('agencies').orderByChild('code').equalTo(code.toUpperCase()).once('value');
        if (!snap.exists()) return res.status(404).json({ error: 'Ajans bulunamadi.' });
        const agencyId = Object.keys(snap.val())[0];
        const agencyData = snap.val()[agencyId];
        // Get user slug
        const slugSnap = await db.ref('slugByUid/' + req.uid + '/slug').once('value');
        const slug = slugSnap.exists() ? slugSnap.val() : '';
        const pageSnap = slug ? await db.ref('pagesBySlug/' + slug).once('value') : null;
        const displayName = (pageSnap && pageSnap.exists()) ? (pageSnap.val().title || slug) : slug;
        await db.ref('agencyMembers/' + agencyId + '/' + req.uid).set({
            joinedAt: admin.database.ServerValue.TIMESTAMP, slug, displayName
        });
        res.json({ success: true, agencyName: agencyData.name });
    } catch (err) { console.error('Agency join error:', err); res.status(500).json({ error: 'Sunucu hatasi.' }); }
});

// GET /agency/my — Get user's current agency
app.get('/agency/my', authenticate, async (req, res) => {
    try {
        const agenciesSnap = await db.ref('agencies').once('value');
        if (!agenciesSnap.exists()) return res.json({ agency: null });
        for (const [id, data] of Object.entries(agenciesSnap.val())) {
            const memberSnap = await db.ref('agencyMembers/' + id + '/' + req.uid).once('value');
            if (memberSnap.exists()) return res.json({ agency: { id, ...data }, member: memberSnap.val() });
        }
        res.json({ agency: null });
    } catch (err) { res.status(500).json({ error: 'Sunucu hatasi.' }); }
});

// POST /agency/leave — User leaves agency
app.post('/agency/leave', authenticate, async (req, res) => {
    try {
        const { agencyId } = req.body;
        await db.ref('agencyMembers/' + agencyId + '/' + req.uid).remove();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Sunucu hatasi.' }); }
});

// GET /agency/panel/:id — Agency panel data (agency email auth)
app.get('/agency/panel/:id', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: 'Yetkilendirme gerekli.' });
        const token = authHeader.split('Bearer ')[1];
        const decoded = await admin.auth().verifyIdToken(token);
        const email = (decoded.email || '').toLowerCase();
        const agencySnap = await db.ref('agencies/' + req.params.id).once('value');
        if (!agencySnap.exists()) return res.status(404).json({ error: 'Ajans bulunamadi.' });
        const agency = agencySnap.val();
        // Check agency email or admin
        if (agency.email !== email && !ADMIN_EMAILS.includes(email)) {
            return res.status(403).json({ error: 'Bu ajansa erisim yetkiniz yok.' });
        }
        // Get members with stats
        const membersSnap = await db.ref('agencyMembers/' + req.params.id).once('value');
        const members = [];
        if (membersSnap.exists()) {
            for (const [uid, memberData] of Object.entries(membersSnap.val())) {
                const slug = memberData.slug;
                const pageSnap = slug ? await db.ref('pagesBySlug/' + slug).once('value') : null;
                const page = pageSnap && pageSnap.exists() ? pageSnap.val() : {};
                const viewsSnap = slug ? await db.ref('pageViews/' + slug).once('value') : null;
                const views = viewsSnap && viewsSnap.exists() ? viewsSnap.val() : { daily: {}, hourly: {}, total: 0 };
                members.push({
                    uid, slug,
                    displayName: memberData.displayName || page.title || slug,
                    photo: page.photo || '',
                    joinedAt: memberData.joinedAt,
                    stats: { total: views.total || 0, daily: views.daily || {}, hourly: views.hourly || {} }
                });
            }
        }
        res.json({ agency: { id: req.params.id, ...agency }, members });
    } catch (err) { console.error('Agency panel error:', err); res.status(500).json({ error: 'Sunucu hatasi.' }); }
});

// GET /agency/auth — Check agency access by email
app.get('/agency/auth', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: 'Yetkilendirme gerekli.' });
        const token = authHeader.split('Bearer ')[1];
        const decoded = await admin.auth().verifyIdToken(token);
        const email = (decoded.email || '').toLowerCase();
        const agenciesSnap = await db.ref('agencies').once('value');
        if (!agenciesSnap.exists()) return res.json({ agencies: [] });
        const myAgencies = [];
        for (const [id, data] of Object.entries(agenciesSnap.val())) {
            if (data.email === email) myAgencies.push({ id, ...data });
        }
        // Also allow admins to see all
        if (ADMIN_EMAILS.includes(email)) {
            for (const [id, data] of Object.entries(agenciesSnap.val())) {
                if (!myAgencies.find(a => a.id === id)) myAgencies.push({ id, ...data });
            }
        }
        res.json({ agencies: myAgencies });
    } catch (err) { res.status(500).json({ error: 'Sunucu hatasi.' }); }
});

// POST /agency/document — Create agency report document
app.post('/agency/document', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: 'Yetkilendirme gerekli.' });
        const token = authHeader.split('Bearer ')[1];
        const decoded = await admin.auth().verifyIdToken(token);
        const email = (decoded.email || '').toLowerCase();
        const { agencyId, memberUid, range } = req.body;
        if (!agencyId) return res.status(400).json({ error: 'Ajans ID gerekli.' });
        const agencySnap = await db.ref('agencies/' + agencyId).once('value');
        if (!agencySnap.exists()) return res.status(404).json({ error: 'Ajans bulunamadi.' });
        const agency = agencySnap.val();
        if (agency.email !== email && !ADMIN_EMAILS.includes(email)) return res.status(403).json({ error: 'Yetkiniz yok.' });
        // Get members
        const membersSnap = await db.ref('agencyMembers/' + agencyId).once('value');
        let members = [];
        if (membersSnap.exists()) {
            for (const [uid, mData] of Object.entries(membersSnap.val())) {
                if (memberUid && memberUid !== uid) continue;
                const slug = mData.slug;
                const pageSnap = slug ? await db.ref('pagesBySlug/' + slug).once('value') : null;
                const page = pageSnap && pageSnap.exists() ? pageSnap.val() : {};
                const viewsSnap = slug ? await db.ref('pageViews/' + slug).once('value') : null;
                const views = viewsSnap && viewsSnap.exists() ? viewsSnap.val() : { daily: {}, total: 0 };
                members.push({ uid, slug, displayName: mData.displayName || page.title || slug, photo: page.photo || '', stats: { total: views.total || 0, daily: views.daily || {} } });
            }
        }
        // Generate doc number
        let docNumber; let attempts = 0;
        do { docNumber = generateDocNumber(); const ex = await db.ref('documents/' + docNumber).once('value'); if (!ex.exists()) break; attempts++; } while (attempts < 10);
        const now = new Date();
        const docData = { docNumber, type: 'agency', agencyId, agencyName: agency.name, agencyCode: agency.code, createdAt: now.toISOString(), createdAtTimestamp: admin.database.ServerValue.TIMESTAMP, range: range || 14, members, slug: 'ajans-' + agency.code.toLowerCase() };
        await db.ref('documents/' + docNumber).set(docData);
        res.json({ success: true, document: docData });
    } catch (err) { console.error('Agency doc error:', err); res.status(500).json({ error: 'Belge olusturulamadi.' }); }
});

// ===== AGENCY BIO + FORM ENDPOINTS =====

// PUT /agency/bio/:id — Save agency bio page settings (full panel features)
app.put('/agency/bio/:id', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: 'Yetkilendirme gerekli.' });
        const token = authHeader.split('Bearer ')[1];
        const decoded = await admin.auth().verifyIdToken(token);
        const email = (decoded.email || '').toLowerCase();
        const uid = decoded.uid;
        const agencySnap = await db.ref('agencies/' + req.params.id).once('value');
        if (!agencySnap.exists()) return res.status(404).json({ error: 'Ajans bulunamadi.' });
        const agency = agencySnap.val();
        if (agency.email !== email && !ADMIN_EMAILS.includes(email)) return res.status(403).json({ error: 'Yetkiniz yok.' });
        const { bio, socials, badge, formFields, bioSlug, displayName, photoUrl, blocks, customButtons, background, styles, layerOrder } = req.body;
        const updates = {};
        if (bio !== undefined) updates.bio = bio;
        if (socials !== undefined) updates.socials = socials;
        if (badge !== undefined) updates.badge = badge;
        if (formFields !== undefined) updates.formFields = formFields;
        if (displayName !== undefined) updates.bioDisplayName = displayName;
        if (photoUrl !== undefined) updates.bioPhotoUrl = photoUrl;
        if (blocks !== undefined) updates.bioBlocks = blocks;
        if (customButtons !== undefined) updates.bioCustomButtons = customButtons;
        if (background !== undefined) updates.bioBackground = background;
        if (styles !== undefined) updates.bioStyles = styles;
        if (layerOrder !== undefined) updates.bioLayerOrder = layerOrder;
        if (bioSlug) updates.bioSlug = bioSlug.toLowerCase().replace(/[^a-z0-9]/g, '');
        await db.ref('agencies/' + req.params.id).update(updates);
        res.json({ success: true });
    } catch (err) { console.error('Agency bio error:', err); res.status(500).json({ error: 'Sunucu hatasi.' }); }
});

// POST /agency/claim-slug/:id — Agency claims a slug for their bio page
app.post('/agency/claim-slug/:id', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: 'Yetkilendirme gerekli.' });
        const token = authHeader.split('Bearer ')[1];
        const decoded = await admin.auth().verifyIdToken(token);
        const email = (decoded.email || '').toLowerCase();
        const uid = decoded.uid;
        const agencySnap = await db.ref('agencies/' + req.params.id).once('value');
        if (!agencySnap.exists()) return res.status(404).json({ error: 'Ajans bulunamadi.' });
        const agency = agencySnap.val();
        if (agency.email !== email && !ADMIN_EMAILS.includes(email)) return res.status(403).json({ error: 'Yetkiniz yok.' });

        const { slug } = req.body;
        if (!slug || slug.length < 2 || slug.length > 30) return res.status(400).json({ error: 'Slug 2-30 karakter arasi olmali.' });
        if (!/^[a-z0-9]+$/.test(slug)) return res.status(400).json({ error: 'Slug sadece kucuk harf ve rakam icermelidir.' });

        const reserved = ['admin', 'panel', 'api', 'login', 'register', 'settings', 'about', 'contact', 'help', 'support', 'dash', 'kisalt'];
        if (reserved.includes(slug)) return res.status(400).json({ error: 'Bu slug kullanilamaz.' });

        // If agency already has a slug and it's the same, just confirm
        if (agency.bioSlug && agency.bioSlug === slug) {
            // Re-ensure page exists
            const pageSnap = await db.ref('pagesBySlug/' + slug).once('value');
            if (!pageSnap.exists()) {
                await db.ref('pagesBySlug/' + slug).set({
                    uid: uid, slug: slug, displayName: agency.name || '', bio: agency.bio || '',
                    photoUrl: agency.logoUrl || '', socials: agency.socials || {}, blocks: [],
                    background: { color: '#000000', imageUrl: '', opacity: 1, pattern: 'none' },
                    isAgency: true, agencyId: req.params.id,
                    createdAt: admin.database.ServerValue.TIMESTAMP, updatedAt: admin.database.ServerValue.TIMESTAMP
                });
            }
            return res.json({ success: true, slug });
        }

        // If agency had a different slug before, release it
        if (agency.bioSlug && agency.bioSlug !== slug) {
            const oldPage = await db.ref('pagesBySlug/' + agency.bioSlug).once('value');
            if (oldPage.exists() && oldPage.val().isAgency && oldPage.val().agencyId === req.params.id) {
                await db.ref('pagesBySlug/' + agency.bioSlug).remove();
            }
        }

        // Check if slug taken by someone else (not this agency)
        const existingPage = await db.ref('pagesBySlug/' + slug).once('value');
        if (existingPage.exists()) {
            const ep = existingPage.val();
            if (!ep.isAgency || ep.agencyId !== req.params.id) {
                return res.status(409).json({ error: 'Bu slug baskasi tarafindan alinmis.' });
            }
        }

        // Also check slugByUid (personal slugs)
        // No need — pagesBySlug check covers it

        // Create page
        await db.ref('pagesBySlug/' + slug).set({
            uid: uid, slug: slug, displayName: agency.name || '', bio: agency.bio || '',
            photoUrl: agency.logoUrl || '', socials: agency.socials || {}, blocks: [],
            background: { color: '#000000', imageUrl: '', opacity: 1, pattern: 'none' },
            isAgency: true, agencyId: req.params.id,
            createdAt: admin.database.ServerValue.TIMESTAMP, updatedAt: admin.database.ServerValue.TIMESTAMP
        });

        // Save slug to agency
        await db.ref('agencies/' + req.params.id).update({ bioSlug: slug });

        res.json({ success: true, slug });
    } catch (err) { console.error('Agency claim slug error:', err); res.status(500).json({ error: 'Sunucu hatasi.' }); }
});

// PUT /agency/page/:id — Save full agency bio page data (like /page PUT for users)
app.put('/agency/page/:id', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: 'Yetkilendirme gerekli.' });
        const token = authHeader.split('Bearer ')[1];
        const decoded = await admin.auth().verifyIdToken(token);
        const email = (decoded.email || '').toLowerCase();
        const agencySnap = await db.ref('agencies/' + req.params.id).once('value');
        if (!agencySnap.exists()) return res.status(404).json({ error: 'Ajans bulunamadi.' });
        const agency = agencySnap.val();
        if (agency.email !== email && !ADMIN_EMAILS.includes(email)) return res.status(403).json({ error: 'Yetkiniz yok.' });

        const slug = agency.bioSlug;
        if (!slug) return res.status(400).json({ error: 'Ajans icin slug tanimlanmamis.' });

        const { displayName, bio, photoUrl, socials, blocks, customButtons, background, styles, layerOrder } = req.body;
        const updateData = { updatedAt: admin.database.ServerValue.TIMESTAMP };
        if (displayName !== undefined) updateData.displayName = displayName;
        if (bio !== undefined) updateData.bio = bio;
        if (photoUrl !== undefined) updateData.photoUrl = photoUrl;
        if (socials !== undefined) updateData.socials = socials;
        if (blocks !== undefined) updateData.blocks = blocks;
        if (customButtons !== undefined) updateData.customButtons = customButtons;
        if (background !== undefined) updateData.background = background;
        if (styles !== undefined) updateData.styles = styles;
        if (layerOrder !== undefined) updateData.layerOrder = layerOrder;

        await db.ref('pagesBySlug/' + slug).update(updateData);
        res.json({ success: true });
    } catch (err) { console.error('Agency page save error:', err); res.status(500).json({ error: 'Sunucu hatasi.' }); }
});

// GET /agency/public/:code — Public agency bio page data
app.get('/agency/public/:code', async (req, res) => {
    try {
        const snap = await db.ref('agencies').orderByChild('code').equalTo(req.params.code.toUpperCase()).once('value');
        if (!snap.exists()) return res.status(404).json({ error: 'Ajans bulunamadi.' });
        const agencyId = Object.keys(snap.val())[0];
        const agency = snap.val()[agencyId];
        const membersSnap = await db.ref('agencyMembers/' + agencyId).once('value');
        const membersList = [];
        if (membersSnap.exists()) {
            for (const [uid, mData] of Object.entries(membersSnap.val())) {
                const slug = mData.slug;
                const pageSnap = slug ? await db.ref('pagesBySlug/' + slug).once('value') : null;
                const page = pageSnap && pageSnap.exists() ? pageSnap.val() : {};
                membersList.push({ slug, displayName: mData.displayName || page.title || slug, photo: page.photo || '' });
            }
        }
        res.json({
            id: agencyId, name: agency.name, code: agency.code, logoUrl: agency.logoUrl || '',
            bio: agency.bio || '', socials: agency.socials || {}, badge: agency.badge || {},
            formFields: agency.formFields || [], members: membersList
        });
    } catch (err) { res.status(500).json({ error: 'Sunucu hatasi.' }); }
});

// GET /agency/vitrin/:agencyId — Public vitrin members for bio page
app.get('/agency/vitrin/:agencyId', async (req, res) => {
    try {
        const agencyId = req.params.agencyId;
        const agencySnap = await db.ref('agencies/' + agencyId).once('value');
        if (!agencySnap.exists()) return res.status(404).json({ error: 'Ajans bulunamadi.' });
        const agency = agencySnap.val();
        const membersSnap = await db.ref('agencyMembers/' + agencyId).once('value');
        const membersList = [];
        if (membersSnap.exists()) {
            for (const [uid, mData] of Object.entries(membersSnap.val())) {
                const slug = mData.slug;
                if (!slug) continue;
                const pageSnap = await db.ref('pagesBySlug/' + slug).once('value');
                const page = pageSnap && pageSnap.exists() ? pageSnap.val() : {};
                membersList.push({
                    slug,
                    displayName: mData.displayName || page.displayName || slug,
                    photo: page.photoUrl || mData.photo || '',
                    background: page.background || {}
                });
            }
        }
        res.json({
            agencyName: agency.name || '',
            agencyLogo: agency.logoUrl || '',
            members: membersList
        });
    } catch (err) { res.status(500).json({ error: 'Sunucu hatasi.' }); }
});

// POST /agency/form-submit/:code — Public form submission
app.post('/agency/form-submit/:code', async (req, res) => {
    try {
        const snap = await db.ref('agencies').orderByChild('code').equalTo(req.params.code.toUpperCase()).once('value');
        if (!snap.exists()) return res.status(404).json({ error: 'Ajans bulunamadi.' });
        const agencyId = Object.keys(snap.val())[0];
        const { answers } = req.body;
        const submissionId = db.ref('agencyFormSubmissions/' + agencyId).push().key;
        await db.ref('agencyFormSubmissions/' + agencyId + '/' + submissionId).set({
            answers: answers || {}, submittedAt: admin.database.ServerValue.TIMESTAMP
        });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Sunucu hatasi.' }); }
});

// GET /agency/form-submissions/:id — Get form submissions (agency owner)
app.get('/agency/form-submissions/:id', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: 'Yetkilendirme gerekli.' });
        const token = authHeader.split('Bearer ')[1];
        const decoded = await admin.auth().verifyIdToken(token);
        const email = (decoded.email || '').toLowerCase();
        const agencySnap = await db.ref('agencies/' + req.params.id).once('value');
        if (!agencySnap.exists()) return res.status(404).json({ error: 'Ajans bulunamadi.' });
        const agency = agencySnap.val();
        if (agency.email !== email && !ADMIN_EMAILS.includes(email)) return res.status(403).json({ error: 'Yetkiniz yok.' });
        const snap = await db.ref('agencyFormSubmissions/' + req.params.id).once('value');
        const submissions = [];
        if (snap.exists()) {
            for (const [id, data] of Object.entries(snap.val())) submissions.push({ id, ...data });
        }
        submissions.sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
        res.json({ submissions });
    } catch (err) { res.status(500).json({ error: 'Sunucu hatasi.' }); }
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
