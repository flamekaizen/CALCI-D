/**
 * Builds the Calci web app (../CALCI-W) for native shells and copies it into app/.
 *
 *   node scripts/sync-web.mjs            # build CALCI-W and copy
 *   node scripts/sync-web.mjs --no-build # copy an existing ../CALCI-W/dist-native
 *
 * Set CALCI_WEB_DIR to point at the web repo if it is not a sibling folder.
 */
import { execSync } from 'node:child_process';
import { cpSync, existsSync, rmSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';

const web = resolve(process.env.CALCI_WEB_DIR ?? '../CALCI-W');
const out = resolve('app');
if (!existsSync(web)) {
  console.error(`Web project not found at ${web}. Clone https://github.com/flamekaizen/CALCI-W next to this repo or set CALCI_WEB_DIR.`);
  process.exit(1);
}
if (!process.argv.includes('--no-build')) {
  if (!existsSync(resolve(web, 'node_modules'))) execSync('npm ci', { cwd: web, stdio: 'inherit' });
  execSync('npm run build:native', { cwd: web, stdio: 'inherit' });
}
const dist = resolve(web, 'dist-native');
if (!existsSync(dist)) {
  console.error('dist-native not found — run without --no-build.');
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
cpSync(dist, out, { recursive: true });
rmSync(resolve(out, 'embed-demo.html'), { force: true });
// window / installer icons
mkdirSync('build', { recursive: true });
for (const [from, to] of [
  ['icons/icon.ico', 'build/icon.ico'],
  ['icons/icon-512.png', 'build/icon.png'],
  ['icons/icon-1024.png', 'build/icon-1024.png'],
]) {
  if (existsSync(resolve(out, from))) copyFileSync(resolve(out, from), resolve(to));
}
writeFileSync(resolve(out, '.synced'), new Date().toISOString());
console.log(`Copied ${dist} → ${out}`);
