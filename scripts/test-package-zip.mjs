import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), 'package-windows-zip.mjs');
const version = JSON.parse(readFileSync(resolve(dirname(scriptPath), '..', 'package.json'), 'utf8')).version;

function readZip(path) {
  const buffer = readFileSync(path);
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, '缺少 ZIP 结束记录');
  const entries = new Map();
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let index = 0; index < buffer.readUInt16LE(eocd + 10); index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, '中央目录签名错误');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const payload = buffer.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, method === 8 ? inflateRawSync(payload) : Buffer.from(payload));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'coolapk-zip-'));
  const exe = join(root, 'coolapk_desktop.exe');
  const data = Buffer.alloc(4096);
  data.write('MZ', 0);
  for (let index = 2; index < data.length; index += 1) data[index] = (index * 31) % 251;
  writeFileSync(exe, data);
  return { root, exe, data };
}

function run(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' });
}

test('打包便携压缩包：解压后含可执行文件与说明，内容一致', () => {
  const { root, exe, data } = createFixture();
  try {
    const outDir = join(root, 'out');
    const result = run(['--exe', exe, '--out-dir', outDir, '--arch', 'x64']);
    assert.equal(result.status, 0, result.stderr);

    const zipPath = join(outDir, `coolapk-desktop_${version}_x64-portable.zip`);
    const entries = readZip(zipPath);
    const folder = `coolapk-desktop_${version}_x64-portable`;
    assert.deepEqual([...entries.keys()].sort(), [`${folder}/README.txt`, `${folder}/coolapk-desktop.exe`].sort());
    assert.ok(entries.get(`${folder}/coolapk-desktop.exe`).equals(data));
    assert.ok(entries.get(`${folder}/README.txt`).toString('utf8').includes(version));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('打包便携压缩包：按架构命名，缺可执行文件时失败', () => {
  const { root, exe } = createFixture();
  try {
    const outDir = join(root, 'out');
    assert.equal(run(['--exe', exe, '--out-dir', outDir, '--arch', 'arm64']).status, 0);
    assert.ok(readZip(join(outDir, `coolapk-desktop_${version}_arm64-portable.zip`)).size === 2);

    const missing = run(['--exe', join(root, 'missing.exe'), '--out-dir', outDir]);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /未找到 Windows 可执行文件/);

    mkdirSync(join(root, 'not-pe'), { recursive: true });
    const notPe = join(root, 'not-pe', 'fake.exe');
    writeFileSync(notPe, Buffer.from('not an executable'));
    const invalid = run(['--exe', notPe, '--out-dir', outDir]);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /不是有效的 PE 可执行文件/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
