const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(__dirname));

// Route for home page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Route for form page
app.get('/form.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'form.html'));
});

// Route for admin page
app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// Dynamic customer panel routes with slug
// This handles paths like /ali, /mehmet, etc.
app.get('/:slug', (req, res) => {
    const slug = req.params.slug;
    
    // Ignore common files and paths
    const ignoredPaths = ['index.html', 'form.html', 'admin.html', 'musteri.html', 'favicon.ico', 'robots.txt'];
    
    if (ignoredPaths.includes(slug)) {
        return res.sendFile(path.join(__dirname, slug));
    }
    
    // If file extension exists, try to serve as static file
    if (slug.includes('.')) {
        return res.sendFile(path.join(__dirname, slug), (err) => {
            if (err) {
                res.status(404).send('File not found');
            }
        });
    }
    
    // Otherwise, serve customer panel
    res.sendFile(path.join(__dirname, 'musteri.html'));
});

// 404 handler
app.use((req, res) => {
    res.status(404).send(`
        <!DOCTYPE html>
        <html lang="tr">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>404 - Sayfa Bulunamadı</title>
            <style>
                * {
                    margin: 0;
                    padding: 0;
                    box-sizing: border-box;
                }
                body {
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    min-height: 100vh;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: white;
                    text-align: center;
                    padding: 2rem;
                }
                .error-container {
                    background: rgba(255, 255, 255, 0.95);
                    backdrop-filter: blur(10px);
                    border-radius: 20px;
                    padding: 3rem;
                    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
                    color: #333;
                }
                h1 {
                    font-size: 4rem;
                    color: #667eea;
                    margin-bottom: 1rem;
                }
                p {
                    font-size: 1.2rem;
                    color: #666;
                    margin-bottom: 2rem;
                }
                a {
                    display: inline-block;
                    padding: 1rem 2rem;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    text-decoration: none;
                    border-radius: 10px;
                    font-weight: 600;
                    transition: transform 0.3s;
                }
                a:hover {
                    transform: translateY(-2px);
                }
            </style>
        </head>
        <body>
            <div class="error-container">
                <h1>404</h1>
                <p>Aradığınız sayfa bulunamadı.</p>
                <a href="/">Ana Sayfaya Dön</a>
            </div>
        </body>
        </html>
    `);
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    console.log(`Customer panels are accessible via: http://localhost:${PORT}/[slug]`);
    console.log(`Example: http://localhost:${PORT}/ali`);
});
