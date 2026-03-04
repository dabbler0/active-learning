#!/usr/bin/env node
/**
 * Build script: bundles src/main.js → dist/bundle.js and copies static assets.
 *
 * CSS strategy:
 *   src/app.css        — copied to dist/ and linked from index.html normally
 *   src/print/*.css    — imported with loader 'text' so they become JS strings
 *                        (needed for inlining into print popup windows)
 */
import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';

const watch = process.argv.includes('--watch');
const dist  = 'dist';

fs.mkdirSync(dist, { recursive: true });

// Copy static assets
fs.copyFileSync('index.html',    path.join(dist, 'index.html'));
fs.copyFileSync('src/app.css',   path.join(dist, 'app.css'));
// Copy paged.js polyfill so it can be loaded by the print popup window
fs.copyFileSync(
  'node_modules/pagedjs/dist/paged.polyfill.js',
  path.join(dist, 'pagedjs.polyfill.js')
);

const ctx = await esbuild.context({
  entryPoints: ['src/main.js'],
  bundle:      true,
  outfile:     path.join(dist, 'bundle.js'),
  format:      'esm',
  sourcemap:   watch ? 'inline' : false,
  minify:      !watch,
  logLevel:    'info',
  loader: {
    // Print CSS files are imported as plain text strings for inline use
    '.css': 'text',
  },
  // Don't apply 'text' loader to app.css — it's NOT imported from JS.
  // The entrypoint is main.js and app.css is only referenced via <link> in HTML.
});

if (watch) {
  await ctx.watch();
  console.log('Watching… (Ctrl-C to stop)');
} else {
  await ctx.rebuild();
  await ctx.dispose();
  const stat = fs.statSync(path.join(dist, 'bundle.js'));
  console.log(`\n✓ dist/bundle.js  ${(stat.size / 1024).toFixed(0)} KB`);
  console.log('  dist/app.css');
  console.log('  dist/index.html');
  console.log('\nOpen dist/index.html or: python3 -m http.server --directory dist\n');
}
