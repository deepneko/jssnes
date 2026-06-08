import { createServer } from 'http';
import { readFile, stat } from 'fs/promises';
import { join, extname, normalize } from 'path';

const DIST_DIR = join(import.meta.dirname, 'dist');
const PORT = process.env.PORT || 8080;

const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
};

createServer(async (req, res) => {
    const requestPath = normalize(decodeURIComponent(req.url.split('?')[0]));
    let filePath = join(DIST_DIR, requestPath);
    if (!filePath.startsWith(DIST_DIR)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }
    try {
        const fileStat = await stat(filePath);
        if (fileStat.isDirectory()) filePath = join(filePath, 'index.html');
    } catch {
        // fall through to readFile, which will 404 below
    }
    try {
        const data = await readFile(filePath);
        const contentType = MIME_TYPES[extname(filePath)] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    } catch {
        res.writeHead(404);
        res.end('Not found');
    }
}).listen(PORT, () => {
    console.log(`Serving ${DIST_DIR} on port ${PORT}`);
});
