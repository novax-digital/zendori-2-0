/**
 * Builds the embeddable bundles served as static assets:
 *   src/widget/main.ts     → public/widget.js  (chat widget, Phase 2)
 *   src/form-embed/main.ts → public/form.js    (form builder embed, Phase 10)
 * Single self-contained IIFEs. Wired into "predev" / "prebuild" /
 * "build:embeds" in package.json (replaces build-widget.mjs).
 */
import { build } from 'esbuild';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

const bundles = [
  { entry: ['src', 'widget', 'main.ts'], out: 'widget.js' },
  { entry: ['src', 'form-embed', 'main.ts'], out: 'form.js' },
];

for (const bundle of bundles) {
  const entry = path.join(scriptDir, '..', ...bundle.entry);
  const outfile = path.join(scriptDir, '..', 'public', bundle.out);
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
  console.log(`${bundle.out} built (${sizeKb.toFixed(1)} kB minified)`);
}
