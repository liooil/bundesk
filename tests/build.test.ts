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
    const outputDirectory = await mkdtemp(join(tmpdir(), 'bun-desktop-app-test-'))
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
        title: 'Desktop Fixture',
        version: '1.2.3',
        description: 'bun-desktop-app integration fixture',
        publisher: 'bun-desktop-app',
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
    expect(versionStdout.trim()).toBe('Desktop Fixture|1.2.3')
  }, 120_000)

  it.skipIf(process.platform !== 'linux')('builds a runnable Linux executable', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'bun-desktop-app-test-'))
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
})
