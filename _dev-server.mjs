import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const PORT = 8843;
const ROOT = dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css' };

createServer(async (req, res) => {
  let caminho = req.url.split('?')[0];
  if (caminho === '/') caminho = '/index.html';
  try {
    const conteudo = await readFile(join(ROOT, caminho));
    res.writeHead(200, { 'Content-Type': TYPES[extname(caminho)] || 'application/octet-stream' });
    res.end(conteudo);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(PORT, () => console.log(`dev server on ${PORT}`));
