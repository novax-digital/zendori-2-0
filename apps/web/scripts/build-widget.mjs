/**
 * Builds the embeddable chat widget bundle: src/widget/main.ts → public/widget.js
 * (single self-contained IIFE, served by Next.js as a static asset).
 * Wired into "build:widget" / "prebuild" / "predev" in package.json.
 */
import { build } from 'esbuild';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(scriptDir, '..', 'src', 'widget', 'main.ts');
const outfile = path.join(scriptDir, '..', 'public', 'widget.js');

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  platform: 'browser',
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
});

const sizeKb = statSync(outfile).size / 1024;
console.log(`widget.js built (${sizeKb.toFixed(1)} kB minified)`);
