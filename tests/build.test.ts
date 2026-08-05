import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDesktopApp } from '../src/index'

const temporaryDirectories: string[] = []

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((path) => rm(path, { recursive: true, force: true })))
})

describe('buildDesktopApp', () => {
  it.skipIf(process.platform !== 'win32')('builds a runnable detached-console Windows executable with metadata', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'bundesk-test-'))
    temporaryDirectories.push(outputDirectory)
    const outfile = join(outputDirectory, 'fixture.exe')

    const output = await buildDesktopApp({
      root: import.meta.dir,
      entrypoint: 'fixtures/hello.ts',
      outfile,
      minify: true,
      define: {
        __FIXTURE_VERSION__: JSON.stringify('1.2.3'),
      },
      windows: {
        console: 'detached',
        title: 'BunDesk Fixture',
        version: '1.2.3',
        description: 'BunDesk integration fixture',
        publisher: 'BunDesk',
      },
      runtime: {
        executablePath: process.execPath,
      },
    })

    expect(output.outfile).toBe(outfile)
    expect(output.size).toBeGreaterThan(1_000_000)
    expect(output.sha256).toMatch(/^[a-f0-9]{64}$/)

    const child = Bun.spawn([outfile, '--probe'], { stdout: 'pipe', stderr: 'pipe' })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
    expect(stdout.trim()).toBe('desktop-fixture 1.2.3')

    const executableBytes = await Bun.file(outfile).arrayBuffer()
    expect(new TextDecoder().decode(executableBytes)).toContain('consoleAllocationPolicy')

    const versionProbe = Bun.spawn([
      'powershell.exe',
      '-NoLogo',
      '-NoProfile',
      '-Command',
      '$info = (Get-Item -LiteralPath $env:BUN_DESKTOP_APP_FIXTURE).VersionInfo; "$($info.ProductName)|$($info.FileVersion)"',
    ], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, BUN_DESKTOP_APP_FIXTURE: outfile },
    })
    const [versionExitCode, versionStdout, versionStderr] = await Promise.all([
      versionProbe.exited,
      new Response(versionProbe.stdout).text(),
      new Response(versionProbe.stderr).text(),
    ])
    expect(versionExitCode).toBe(0)
    expect(versionStderr).toBe('')
    expect(versionStdout.trim()).toBe('BunDesk Fixture|1.2.3')
  }, 120_000)

  it.skipIf(process.platform !== 'linux')('builds a runnable Linux executable', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'bundesk-test-'))
    temporaryDirectories.push(outputDirectory)
    const outfile = join(outputDirectory, 'fixture')

    const output = await buildDesktopApp({
      root: import.meta.dir,
      entrypoint: 'fixtures/hello.ts',
      outfile,
      target: process.arch === 'arm64' ? 'bun-linux-arm64' : 'bun-linux-x64',
      minify: true,
      define: {
        __FIXTURE_VERSION__: JSON.stringify('1.2.3'),
      },
    })
    const child = Bun.spawn([output.outfile, '--probe'], { stdout: 'pipe', stderr: 'pipe' })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
    expect(stdout.trim()).toBe('desktop-fixture 1.2.3')
  }, 120_000)

  it.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')('cross-compiles a macOS .app bundle', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'bundesk-darwin-test-'))
    temporaryDirectories.push(outputDirectory)
    const bundlePath = join(outputDirectory, 'Fixture.app')

    const output = await buildDesktopApp({
      root: import.meta.dir,
      entrypoint: 'fixtures/hello.ts',
      outfile: bundlePath,
      target: 'bun-darwin-arm64',
      minify: true,
      define: {
        __FIXTURE_VERSION__: JSON.stringify('1.2.3'),
      },
      macos: {
        bundleIdentifier: 'dev.bundesk.fixture',
        displayName: 'BunDesk Fixture',
        version: '1.2.3',
        documentTypes: [{ extension: '.demo', name: 'BunDesk Document' }],
        urlTypes: [{ scheme: 'bundesk-fixture' }],
        codesign: false,
      },
    })

    expect(output.outfile).toBe(bundlePath)
    expect(output.bundle?.signed).toBe(false)
    const executableBytes = new Uint8Array(await Bun.file(output.bundle!.executablePath).arrayBuffer())
    expect([...executableBytes.slice(0, 4)]).toEqual([0xcf, 0xfa, 0xed, 0xfe])
    const plist = await Bun.file(output.bundle!.infoPlistPath).text()
    expect(plist).toContain('<key>CFBundleExecutable</key><string>Fixture</string>')
    expect(plist).toContain('<key>CFBundleIdentifier</key><string>dev.bundesk.fixture</string>')
    expect(plist).toContain('CFBundleDocumentTypes')
    expect(plist).toContain('bundesk-fixture')
  }, 240_000)

  it.skipIf(process.platform !== 'linux' || process.arch !== 'x64')('cross-compiles a detached-console Windows executable on Linux', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'bundesk-cross-test-'))
    temporaryDirectories.push(outputDirectory)
    const output = await buildDesktopApp({
      root: import.meta.dir,
      entrypoint: 'fixtures/hello.ts',
      outfile: join(outputDirectory, 'fixture.exe'),
      target: 'bun-windows-x64',
      minify: true,
      define: {
        __FIXTURE_VERSION__: JSON.stringify('1.2.3'),
      },
      windows: {
        console: 'detached',
        title: 'BunDesk Cross Fixture',
        version: '1.2.3',
      },
      runtime: {
        cacheDir: join(outputDirectory, 'runtime-cache'),
      },
    })
    const bytes = new Uint8Array(await Bun.file(output.outfile).arrayBuffer())
    expect([...bytes.slice(0, 2)]).toEqual([0x4d, 0x5a])
    expect(new TextDecoder().decode(bytes)).toContain('consoleAllocationPolicy')
  }, 180_000)
})
