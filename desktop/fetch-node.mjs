// Downloads the official Node build for one target into desktop/.cache/node/, checked against
// nodejs.org's SHASUMS256.txt. electron-builder then ships it as resources/node/ (see electron-builder.yml).
//   node desktop/fetch-node.mjs <win32|linux> <x64|arm64>
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = process.env.NODE_VERSION || '26.13.0';
const [platform = process.platform, arch = process.arch] = process.argv.slice(2);
if (!['win32', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
  console.error('usage: node desktop/fetch-node.mjs <win32|linux> <x64|arm64>');
  process.exit(2);
}
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '.cache', 'node');
const base = `https://nodejs.org/dist/v${VERSION}`;
const get = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
};
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const sums = (await get(`${base}/SHASUMS256.txt`)).toString();
const expect = (file) => {
  const line = sums.split('\n').find((l) => l.endsWith(`  ${file}`));
  if (!line) throw new Error(`${file} not in SHASUMS256.txt`);
  return line.split(/\s+/)[0];
};

if (platform === 'win32') {
  const file = `win-${arch}/node.exe`;  // nodejs.org publishes the bare exe: no zip to unpack
  const buf = await get(`${base}/${file}`);
  if (sha(buf) !== expect(file)) throw new Error('checksum mismatch for node.exe');
  fs.writeFileSync(path.join(OUT, 'node.exe'), buf);
} else {
  const name = `node-v${VERSION}-linux-${arch}`;
  const buf = await get(`${base}/${name}.tar.xz`);
  if (sha(buf) !== expect(`${name}.tar.xz`)) throw new Error('checksum mismatch for the Node tarball');
  const tmp = path.join(OUT, 'node.tar.xz');
  fs.writeFileSync(tmp, buf);
  execFileSync('tar', ['-xJf', tmp, '-C', OUT, '--strip-components=2', `${name}/bin/node`]);
  fs.rmSync(tmp);
  fs.chmodSync(path.join(OUT, 'node'), 0o755);
}
console.log(`Node ${VERSION} (${platform}-${arch}) -> ${OUT}`);
