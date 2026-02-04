const express = require('express');
const path = require('path');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;

// Firebase Admin SDK initialization
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT 
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : null;

if (serviceAccount) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://maps-52b00-default-rtdb.europe-west1.firebasedatabase.app"
    });
}

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve index.html for root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve form.html
app.get('/form', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'form.html'));
});

// Serve admin.html
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Serve musteri.html for /musteri route
app.get('/musteri', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'musteri.html'));
});

// Dynamic customer routes (slug-based)
// This handles routes like /ali, /mehmet, etc.
app.get('/:slug', async (req, res, next) => {
    const slug = req.params.slug.toLowerCase();
    
    // Skip if it's a known static file or route
    const staticRoutes = ['index.html', 'form.html', 'admin.html', 'musteri.html', 'favicon.ico'];
    if (staticRoutes.includes(slug) || slug.includes('.')) {
        return next();
    }
    
    // Check if slug exists in Firebase
    if (admin.apps.length > 0) {
        try {
            const db = admin.database();
            const snapshot = await db.ref('musteriler').orderByChild('slug').equalTo(slug).once('value');
            
            if (snapshot.exists()) {
                // Serve the customer panel
                res.sendFile(path.join(__dirname, 'public', 'musteri.html'));
            } else {
                // Slug not found, redirect to home
                res.redirect('/');
            }
        } catch (error) {
            console.error('Firebase error:', error);
            res.redirect('/');
        }
    } else {
        // If Firebase Admin is not configured, just serve the customer panel
        // The client-side will handle validation
        res.sendFile(path.join(__dirname, 'public', 'musteri.html'));
    }
});

// Handle .html extensions for backward compatibility
app.get('/index.html', (req, res) => {
    res.redirect('/');
});

app.get('/form.html', (req, res) => {
    res.redirect('/form');
});

app.get('/admin.html', (req, res) => {
    res.redirect('/admin');
});

app.get('/musteri.html', (req, res) => {
    res.redirect('/musteri');
});

// 404 handler
app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handler
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Bir şeyler yanlış gitti!');
});

app.listen(PORT, () => {
    console.log(`Server ${PORT} portunda çalışıyor`);
    console.log(`Ana Sayfa: http://localhost:${PORT}`);
    console.log(`Form: http://localhost:${PORT}/form`);
    console.log(`Admin: http://localhost:${PORT}/admin`);
    console.log(`Müşteri Paneli: http://localhost:${PORT}/musteri`);
});

module.exports = app;
