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
        const { slug, displayName, bio, photoUrl, socials, blocks, background } = req.body;

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
            const allowedPatterns = ['none', 'dots', 'grid', 'diagonal', 'cross', 'waves'];
            cleanBg.pattern = allowedPatterns.includes(background.pattern) ? background.pattern : 'none';
        }

        // Ensure blocks and bg are never undefined/null (RTDB drops empty arrays)
        if (cleanBlocks.length === 0) cleanBlocks = [];
        if (Object.keys(cleanBg).length === 0) {
            cleanBg = { color: '', imageUrl: '', opacity: 1, pattern: 'none' };
        }

        // Build page data
        const pageData = {
            uid: uid,
            slug: slug,
            displayName: (displayName || '').trim().substring(0, 100),
            bio: (bio || '').trim().substring(0, 500),
            photoUrl: (photoUrl || '').trim().substring(0, 1000),
            socials: Object.keys(cleanSocials).length > 0 ? cleanSocials : { instagram: '', twitter: '', youtube: '', linkedin: '', github: '', website: '' },
            blocks: cleanBlocks,
            background: cleanBg,
            updatedAt: admin.database.ServerValue.TIMESTAMP
        };

        console.log('PUT /page - saving for slug:', slug, 'uid:', uid);

        // Check if page exists — always use set to ensure full data
        const pageSnap = await db.ref('pagesBySlug/' + slug).once('value');

        if (!pageSnap.exists()) {
            pageData.createdAt = admin.database.ServerValue.TIMESTAMP;
        } else {
            pageData.createdAt = pageSnap.val().createdAt || admin.database.ServerValue.TIMESTAMP;
        }

        // Always use set (not update) to ensure complete overwrite
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
        // Return only public fields
        res.json({
            slug: data.slug,
            displayName: data.displayName,
            bio: data.bio,
            photoUrl: data.photoUrl,
            socials: data.socials || {},
            blocks: data.blocks || [],
            background: data.background || {},
            hasPolls: !!(data.polls && (Array.isArray(data.polls) ? data.polls.length : Object.keys(data.polls).length)),
            hasQuestions: !!(data.questions && (Array.isArray(data.questions) ? data.questions.length : Object.keys(data.questions).length))
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

// ===== POLLS =====

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
app.get('/polls/:slug', async (req, res) => {
    try {
        const slug = req.params.slug;
        const pageSnap = await db.ref('pagesBySlug/' + slug + '/polls').once('value');
        if (!pageSnap.exists()) return res.json({ polls: [] });

        const pollIds = pageSnap.val();
        const pollList = Array.isArray(pollIds) ? pollIds : Object.values(pollIds);

        const polls = [];
        for (const pid of pollList) {
            const pollSnap = await db.ref('polls/' + pid).once('value');
            if (pollSnap.exists()) {
                const poll = pollSnap.val();
                // Check expiry
                if (poll.expiresAt && Date.now() > poll.expiresAt) {
                    poll.active = false;
                }
                polls.push(poll);
            }
        }

        res.json({ polls: polls.reverse() }); // newest first
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
app.get('/questions/:slug', async (req, res) => {
    try {
        const slug = req.params.slug;
        const pageSnap = await db.ref('pagesBySlug/' + slug + '/questions').once('value');
        if (!pageSnap.exists()) return res.json({ questions: [] });

        const qIds = pageSnap.val();
        const qList = Array.isArray(qIds) ? qIds : Object.values(qIds);

        const questions = [];
        for (const qid of qList) {
            const qSnap = await db.ref('questions/' + qid).once('value');
            if (qSnap.exists()) {
                const q = qSnap.val();
                // Get answers
                const ansSnap = await db.ref('questionAnswers/' + qid).once('value');
                q.answers = [];
                if (ansSnap.exists()) {
                    const ansObj = ansSnap.val();
                    q.answers = Object.values(ansObj).sort((a, b) => (b.likes || 0) - (a.likes || 0));
                }
                questions.push(q);
            }
        }

        res.json({ questions: questions.reverse() });
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
