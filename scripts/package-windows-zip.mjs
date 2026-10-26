import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');

function readOption(argv, name) {
  const prefix = `--${name}=`;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === `--${name}`) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`参数 --${name} 缺少取值`);
      return value;
    }
    if (argv[index].startsWith(prefix)) return argv[index].slice(prefix.length);
  }
  return undefined;
}

function normalizeArch(value) {
  const arch = (value || '').toLowerCase();
  if (arch === 'x64' || arch === 'x86_64' || arch === 'amd64') return 'x64';
  if (arch === 'arm64' || arch === 'aarch64') return 'arm64';
  throw new Error(`不支持的架构: ${value}（仅支持 x64 / arm64）`);
}

function dosDateTime(date) {
  const year = Math.max(date.getFullYear(), 1980);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

// 只用 Node 内置模块生成 ZIP，避免依赖系统 zip 命令，Windows / Linux 上行为一致。
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const payload = deflateRawSync(entry.data, { level: 9 });
    const checksum = crc32(entry.data);
    const stamp = dosDateTime(entry.date);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    // 置 UTF-8 标志位，中文文件名在资源管理器中才不会乱码。
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, payload);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(stamp.time, 12);
    header.writeUInt16LE(stamp.date, 14);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(payload.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE((0o644 << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    offset += local.length + name.length + payload.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, directory, end]);
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

const argv = process.argv.slice(2);
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const version = readOption(argv, 'version') || packageJson.version;
const rustTarget = readOption(argv, 'target') || '';
const arch = normalizeArch(readOption(argv, 'arch') || (rustTarget.includes('aarch64') ? 'arm64' : process.arch));
const releaseDir = rustTarget
  ? join(repoRoot, 'src-tauri', 'target', rustTarget, 'release')
  : join(repoRoot, 'src-tauri', 'target', 'release');
const outDir = resolve(readOption(argv, 'out-dir') || join(repoRoot, 'src-tauri', 'target', 'portable'));

const explicitExe = readOption(argv, 'exe');
const candidates = explicitExe
  ? [resolve(repoRoot, explicitExe)]
  : ['coolapk_desktop.exe', 'coolapk-desktop.exe'].map((name) => join(releaseDir, name));
const exePath = candidates.find((path) => existsSync(path));

if (!exePath) {
  throw new Error(
    `未找到 Windows 可执行文件，请先执行 npm run tauri -- build --no-bundle\n已检查：${candidates.join('、')}`,
  );
}

const exeStat = statSync(exePath);
if (!exeStat.isFile() || exeStat.size <= 0) throw new Error(`Windows 可执行文件无效或为空: ${exePath}`);

const exeData = readFileSync(exePath);
if (exeData[0] !== 0x4d || exeData[1] !== 0x5a) throw new Error(`不是有效的 PE 可执行文件: ${exePath}`);

const folder = `coolapk-desktop_${version}_${arch}-portable`;
const readme = [
  `酷安桌面客户端 ${version}（Windows ${arch === 'arm64' ? 'ARM64' : 'x64'} 便携版）`,
  '',
  '使用方法',
  '1. 解压到任意目录（建议不要放在系统目录），双击 coolapk-desktop.exe 运行。',
  '2. 无需安装，整个目录可以直接移动或复制到 U 盘使用。',
  '3. 需要系统已安装 WebView2 运行时；Windows 11 与已更新的 Windows 10 默认自带。',
  '',
  '升级方式',
  '- 直接下载新版本的 portable 压缩包，解压后覆盖本目录即可。',
  '- 也可以在应用内使用「检查更新」，便携版会下载单文件更新包并在退出后原位替换。',
  '',
  `文件校验（SHA256）：${createHash('sha256').update(exeData).digest('hex')}`,
  '',
].join('\r\n');
const readmeData = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(readme, 'utf8')]);

const zipName = `${folder}.zip`;
const zipPath = join(outDir, zipName);
mkdirSync(outDir, { recursive: true });
writeFileSync(zipPath, buildZip([
  { name: `${folder}/coolapk-desktop.exe`, data: exeData, date: exeStat.mtime },
  { name: `${folder}/README.txt`, data: readmeData, date: exeStat.mtime },
]));

const zipData = readFileSync(zipPath);
console.log(`便携压缩包：${zipPath}`);
console.log(`体积：${formatSize(zipData.length)}（可执行文件 ${formatSize(exeData.length)}）`);
console.log(`SHA256：${createHash('sha256').update(zipData).digest('hex')}`);
