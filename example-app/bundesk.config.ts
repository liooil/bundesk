/**
 * Build config for the example playground — one config per platform; the CI
 * matrix builds each target on its native runner (macOS also needs a Mac host
 * for the ad-hoc codesign in the .app bundle).
 *
 * Icons are generated at build time (a tiny BMP-based .ico and a PNG-based
 * .icns) so no binary asset has to be committed. Set BUNDESK_EXAMPLE_CONSOLE
 * to `detached`, `hidden`, or `inherit` to exercise each Windows console mode.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  defineConfig,
  type DesktopAppConfig,
  type DesktopMacosOptions,
  type WindowsConsoleMode,
} from '../src/index'

const here = dirname(fileURLToPath(import.meta.url))
const EXAMPLE_APP_VERSION = (process.env.BUNDESK_EXAMPLE_VERSION ?? readRootPackageVersion()).replace(/^v/, '')

function readRootPackageVersion(): string {
  const packageJson = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version?: string }
  return packageJson.version ?? '0.0.0'
}

/** Minimal valid ICO: ICONDIR + one 16x16 32bpp BMP entry (solid color). */
function buildIconFile(color: [number, number, number, number]): string {
  const [blue, green, red, alpha] = color
  const size = 16
  const xorSize = size * size * 4
  const andSize = (size * size) / 8
  const iconDir = Buffer.alloc(6)
  iconDir.writeUInt16LE(1, 2) // type: icon
  iconDir.writeUInt16LE(1, 4) // count
  const entry = Buffer.alloc(16)
  entry.writeUInt8(size, 0)
  entry.writeUInt8(size, 1)
  entry.writeUInt16LE(1, 4) // planes
  entry.writeUInt16LE(32, 6) // bit count
  entry.writeUInt32LE(40 + xorSize + andSize, 8) // bytes in resource
  entry.writeUInt32LE(22, 12) // image offset
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0) // biSize
  header.writeInt32LE(size, 4) // biWidth
  header.writeInt32LE(size * 2, 8) // biHeight (XOR + AND)
  header.writeUInt16LE(1, 12) // biPlanes
  header.writeUInt16LE(32, 14) // biBitCount
  header.writeUInt32LE(xorSize + andSize, 20) // biSizeImage
  const xor = Buffer.alloc(xorSize)
  for (let offset = 0; offset < xorSize; offset += 4) {
    xor[offset] = blue
    xor[offset + 1] = green
    xor[offset + 2] = red
    xor[offset + 3] = alpha
  }
  const file = Buffer.concat([iconDir, entry, header, xor, Buffer.alloc(andSize)])
  const iconPath = join(here, '.generated', 'icon.ico')
  mkdirSync(dirname(iconPath), { recursive: true })
  writeFileSync(iconPath, file)
  return iconPath
}

const windowsIcon = buildIconFile([0x36, 0x84, 0xff, 0xff])
const macosIcon = buildMacIconFile()

/** Minimal ICNS: a sequence of PNG-backed icon elements with an icns header. */
function buildMacIconFile(): string {
  const elements = ([
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024],
  ] as const).map(([type, size]) => {
    const png = buildPngIcon(size)
    const header = Buffer.alloc(8)
    header.write(type, 0, 4, 'ascii')
    header.writeUInt32BE(png.length + 8, 4)
    return Buffer.concat([header, png])
  })
  const body = Buffer.concat(elements)
  const header = Buffer.alloc(8)
  header.write('icns', 0, 4, 'ascii')
  header.writeUInt32BE(body.length + 8, 4)
  const iconPath = join(here, '.generated', 'icon.icns')
  writeFileSync(iconPath, Buffer.concat([header, body]))
  return iconPath
}

/** Solid-color PNG with a simple split tile, for generated PWA/app icons. */
function buildPngIcon(size: number): Buffer {
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  const border = Math.max(2, Math.floor(size / 16))
  for (let y = 0; y < size; y++) {
    const rowStart = y * (stride + 1)
    raw[rowStart] = 0
    for (let x = 0; x < size; x++) {
      const insideRing = x >= border && x < size - border && y >= border && y < size - border
      const insideTile = insideRing && ((x >= size / 2) !== (y >= size / 2))
      const [blue, green, red, alpha] = insideTile
        ? [0xff, 0xff, 0xff, 0xff]
        : [0x36, 0x84, 0xff, 0xff]
      const offset = rowStart + 1 + x * 4
      raw[offset] = blue
      raw[offset + 1] = green
      raw[offset + 2] = red
      raw[offset + 3] = alpha
    }
  }
  return encodePng(size, size, raw)
}

function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(rgba)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBytes = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0)
  return Buffer.concat([length, typeBytes, data, crc])
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function windowsConsoleMode(): WindowsConsoleMode {
  const value = process.env.BUNDESK_EXAMPLE_CONSOLE
  if (value === 'hidden' || value === 'inherit') return value
  return 'detached'
}

const base = {
  root: here,
  entrypoint: 'src/main.ts',
  minify: true,
  define: {
    __EXAMPLE_APP_VERSION__: JSON.stringify(EXAMPLE_APP_VERSION),
  },
}

const windowsConfig: DesktopAppConfig = {
  ...base,
  target: 'bun-windows-x64',
  outfile: 'dist/example-app.exe',
  runtime: {
    /** Cross-builds on Linux download the Bun runtime here; native Windows builds use process.execPath. */
    cacheDir: join(here, '.cache', 'bundesk-runtime'),
  },
  windows: {
    console: windowsConsoleMode(),
    icon: windowsIcon,
    title: 'BunDesk Playground',
    publisher: 'BunDesk',
    version: EXAMPLE_APP_VERSION,
    description: 'BunDesk framework feature playground',
    copyright: 'Copyright (C) 2026 BunDesk',
  },
}

const linuxConfig: DesktopAppConfig = {
  ...base,
  target: 'bun-linux-x64',
  outfile: 'dist/example-app-linux',
}

const macosOptions: DesktopMacosOptions = {
  bundleIdentifier: 'com.bundesk.example-app',
  displayName: 'BunDesk Playground',
  icon: macosIcon,
  version: EXAMPLE_APP_VERSION,
  minimumSystemVersion: '11.0',
  documentTypes: [{
    extension: '.bundesk-demo',
    name: 'BunDesk demo document',
    role: 'Editor',
  }],
  urlTypes: [{
    scheme: 'bundesk-example',
    name: 'BunDesk Example App',
  }],
}

const darwinArm64Config: DesktopAppConfig = {
  ...base,
  target: 'bun-darwin-arm64',
  outfile: 'dist/example-app-macos.app',
  macos: { ...macosOptions },
}

const darwinX64Config: DesktopAppConfig = {
  ...base,
  target: 'bun-darwin-x64',
  outfile: 'dist/example-app-macos-x64.app',
  macos: { ...macosOptions },
}

// Each CI runner builds only its native targets (macOS must host the .app
// build for the ad-hoc codesign). The forced-target package scripts select a
// non-native platform explicitly through BUNDESK_EXAMPLE_PLATFORM.
const buildPlatform = process.env.BUNDESK_EXAMPLE_PLATFORM === 'win32'
  || process.env.BUNDESK_EXAMPLE_PLATFORM === 'linux'
  || process.env.BUNDESK_EXAMPLE_PLATFORM === 'darwin'
  ? process.env.BUNDESK_EXAMPLE_PLATFORM
  : process.platform

export default buildPlatform === 'win32'
  ? [windowsConfig]
  : buildPlatform === 'linux'
    ? [linuxConfig]
    : [darwinArm64Config, darwinX64Config]
