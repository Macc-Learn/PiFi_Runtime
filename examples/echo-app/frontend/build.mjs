// Builds the echo front-end into one classic script (IIFE) plus static files.
//   node examples/echo-app/frontend/build.mjs [outDir]   (default: ./dist next to this file)
import { build } from 'vite';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(process.argv[2] ?? path.join(here, 'dist'));

await build({
  configFile: false,
  logLevel: 'warn',
  build: {
    outDir,
    emptyOutDir: true,
    lib: { entry: path.join(here, 'app.js'), name: 'echoApp', formats: ['iife'], fileName: () => 'echo.js' },
    minify: true,
  },
});
await mkdir(outDir, { recursive: true });
for (const f of ['index.html', 'style.css']) await copyFile(path.join(here, f), path.join(outDir, f));
console.log(`echo front-end built into ${outDir}`);
