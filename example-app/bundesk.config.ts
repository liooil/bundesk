/**
 * Build config for the example app — one config per platform; the CI matrix
 * builds each target on its native runner (macOS also needs a Mac host for
 * the ad-hoc codesign in the .app bundle).
 *
 * The Windows icon is generated at build time (a tiny BMP-based .ico) so no
 * binary asset has to be committed.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type DesktopAppConfig } from '../src/index'

const here = dirname(fileURLToPath(import.meta.url))

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

const base = {
  root: here,
  entrypoint: 'src/main.ts',
  minify: true,
  define: {
    __EXAMPLE_APP_VERSION__: JSON.stringify('0.1.0'),
  },
}

const windowsConfig: DesktopAppConfig = {
  ...base,
  target: 'bun-windows-x64',
  outfile: 'dist/example-app.exe',
  windows: {
    console: 'detached',
    icon: windowsIcon,
    title: 'BunDesk Example App',
    publisher: 'BunDesk',
    version: '0.1.0',
    description: 'BunDesk framework example app',
    copyright: 'Copyright (C) 2026 BunDesk',
  },
}

const linuxConfig: DesktopAppConfig = {
  ...base,
  target: 'bun-linux-x64',
  outfile: 'dist/example-app-linux',
}

const darwinArm64Config: DesktopAppConfig = {
  ...base,
  target: 'bun-darwin-arm64',
  outfile: 'dist/example-app-macos.app',
  macos: {
    bundleIdentifier: 'com.bundesk.example-app',
    displayName: 'BunDesk Example App',
    minimumSystemVersion: '11.0',
  },
}

const darwinX64Config: DesktopAppConfig = {
  ...base,
  target: 'bun-darwin-x64',
  outfile: 'dist/example-app-macos-x64.app',
  macos: {
    bundleIdentifier: 'com.bundesk.example-app',
    displayName: 'BunDesk Example App',
    minimumSystemVersion: '11.0',
  },
}

// Each CI runner builds only its native targets (macOS must host the .app
// build for the ad-hoc codesign).
export default process.platform === 'win32'
  ? [windowsConfig]
  : process.platform === 'linux'
    ? [linuxConfig]
    : [darwinArm64Config, darwinX64Config]
