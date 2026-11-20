// web/foar-runtime.js → web/foar-runtime.min.js: the copy the website serves and
// `foar build` writes next to your app. The readable source stays the one to
// edit; this file is generated and committed (the Rust build embeds it without
// Node). test/tooling.test.js fails when it's out of date.
//   node scripts/build-runtime.mjs [--check]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { minify } from 'terser';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'web/foar-runtime.js');
const OUT = path.join(root, 'web/foar-runtime.min.js');

export async function buildRuntime() {
  const version = /^version = "([^"]+)"/m.exec(fs.readFileSync(path.join(root, 'Cargo.toml'), 'utf8'))[1];
  const { code } = await minify(fs.readFileSync(SRC, 'utf8'), {
    module: true,
    ecma: 2022,
    compress: { passes: 2 },
    mangle: true,
    format: { comments: false },
  });
  return `/*! FOAR runtime ${version} (MIT). Minified from web/foar-runtime.js: https://github.com/josmanvis/FOAR */\n${code}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = await buildRuntime();
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (current !== out) {
      console.error('web/foar-runtime.min.js is out of date: run `node scripts/build-runtime.mjs`');
      process.exit(1);
    }
    console.log('✓ web/foar-runtime.min.js is up to date');
  } else {
    fs.writeFileSync(OUT, out);
    console.log(`✓ wrote web/foar-runtime.min.js (${out.length} bytes)`);
  }
}
