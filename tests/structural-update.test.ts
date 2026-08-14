import { afterAll, describe, expect, it } from 'bun:test'
import { copyFile, mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildDesktopApp,
  inspectBunExecutable,
  reconstructStructuralUpdate,
  type BunExecutableContainer,
} from '../src/index'
import { inspectExecutable, installUpdate } from '../src/runtime/updater'

const temporaryDirectories: string[] = []

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((path) => rm(path, { recursive: true, force: true })))
})

describe('index-free structural updates', () => {
  it.skipIf(process.platform !== 'win32')('parses ordinary PE, ELF, and Mach-O Bun layouts without modifying them', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'bundesk-structural-containers-'))
    temporaryDirectories.push(outputDirectory)
    const targets: Array<[Bun.Build.CompileTarget, BunExecutableContainer, string]> = [
      ['bun-windows-x64', 'pe64', 'fixture.exe'],
      ['bun-linux-x64', 'elf64', 'fixture-linux'],
      ['bun-darwin-arm64', 'macho64', 'fixture-macos'],
    ]
    for (const [target, container, name] of targets) {
      const output = await buildDesktopApp({
        root: import.meta.dir,
        entrypoint: 'fixtures/hello.ts',
        outfile: join(outputDirectory, name),
        target,
        minify: true,
        define: { __FIXTURE_VERSION__: JSON.stringify('1.0.0') },
        runtime: target === 'bun-windows-x64' ? { executablePath: process.execPath } : undefined,
      })
      const executablePath = output.bundle?.executablePath ?? output.outfile
      const inspection = await inspectBunExecutable(executablePath)
      expect(inspection.container).toBe(container)
      expect(inspection.regions.filter((region) => region.kind === 'bun')).toHaveLength(1)
      expect(inspection.regions.filter((region) => region.kind === 'runtime').length).toBeGreaterThan(0)
      expect(inspection.regions.some((region) => region.name === '.bupd' || region.name === '.bundesk.update')).toBe(false)
      const executable = Bun.file(executablePath)
      const server = Bun.serve({
        port: 0,
        fetch(request) {
          const range = request.headers.get('range')?.match(/^bytes=(\d+)-(\d+)$/)
          if (!range) return new Response(executable)
          const start = Number.parseInt(range[1]!, 10)
          const end = Number.parseInt(range[2]!, 10)
          return new Response(executable.slice(start, end + 1), {
            status: 206,
            headers: {
              'content-length': String(end - start + 1),
              'content-range': `bytes ${start}-${end}/${executable.size}`,
            },
          })
        },
      })
      try {
        const rebuiltPath = join(outputDirectory, `${name}.rebuilt`)
        await reconstructStructuralUpdate({
          currentPath: executablePath,
          outputPath: rebuiltPath,
          targetUrl: `http://127.0.0.1:${server.port}/${name}`,
          targetSize: executable.size,
          targetSha256: output.sha256,
        })
        expect((await inspectExecutable(rebuiltPath)).sha256).toBe(output.sha256)
      } finally {
        server.stop(true)
      }
    }
  }, 180_000)

  it('reconstructs from layout ranges and falls back when optimistic runtime reuse is wrong', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'bundesk-structural-range-'))
    temporaryDirectories.push(outputDirectory)
    const currentPath = join(outputDirectory, process.platform === 'win32' ? 'current.exe' : 'current')
    const targetPath = join(outputDirectory, process.platform === 'win32' ? 'target.exe' : 'target')
    const rebuiltPath = join(outputDirectory, process.platform === 'win32' ? 'rebuilt.exe' : 'rebuilt')
    const fallbackPath = join(outputDirectory, process.platform === 'win32' ? 'fallback.exe' : 'fallback')
    const target = process.platform === 'win32'
      ? 'bun-windows-x64'
      : process.platform === 'darwin'
        ? (process.arch === 'arm64' ? 'bun-darwin-arm64' : 'bun-darwin-x64')
        : (process.arch === 'arm64' ? 'bun-linux-arm64' : 'bun-linux-x64')
    const common = {
      root: import.meta.dir,
      entrypoint: 'fixtures/hello.ts',
      target: target as Bun.Build.CompileTarget,
      minify: true,
      runtime: process.platform === 'win32' ? { executablePath: process.execPath } : undefined,
    }
    await buildDesktopApp({
      ...common,
      outfile: currentPath,
      define: { __FIXTURE_VERSION__: JSON.stringify('1.0.0') },
    })
    const targetBuild = await buildDesktopApp({
      ...common,
      outfile: targetPath,
      define: { __FIXTURE_VERSION__: JSON.stringify('1.0.1') },
    })
    const targetFile = Bun.file(targetPath)
    let rangeBytesServed = 0
    let fullResponses = 0
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const range = request.headers.get('range')?.match(/^bytes=(\d+)-(\d+)$/)
        if (!range) {
          fullResponses++
          return new Response(targetFile, { headers: { 'content-length': String(targetFile.size) } })
        }
        const start = Number.parseInt(range[1]!, 10)
        const end = Number.parseInt(range[2]!, 10)
        rangeBytesServed += end - start + 1
        return new Response(targetFile.slice(start, end + 1), {
          status: 206,
          headers: {
            'accept-ranges': 'bytes',
            'content-length': String(end - start + 1),
            'content-range': `bytes ${start}-${end}/${targetFile.size}`,
          },
        })
      },
    })
    try {
      const plan = await reconstructStructuralUpdate({
        currentPath,
        outputPath: rebuiltPath,
        targetUrl: `http://127.0.0.1:${server.port}/target`,
        targetSize: targetFile.size,
        targetSha256: targetBuild.sha256,
      })
      const [targetInfo, rebuiltInfo, targetInspection, currentInspection] = await Promise.all([
        inspectExecutable(targetPath),
        inspectExecutable(rebuiltPath),
        inspectBunExecutable(targetPath),
        inspectBunExecutable(currentPath),
      ])
      expect(rebuiltInfo).toMatchObject({ size: targetInfo.size, sha256: targetInfo.sha256 })
      expect(plan.reusedBytes).toBeGreaterThan(targetFile.size * 0.8)
      expect(rangeBytesServed).toBeLessThan(targetFile.size * 0.2)
      expect(fullResponses).toBe(0)
      const bunRegion = targetInspection.regions.find((region) => region.kind === 'bun')!
      expect(plan.copies.some((copy) => copy.targetOffset === bunRegion.offset)).toBe(false)
      expect(plan.downloads.some((range) => range.start <= bunRegion.offset && range.end >= bunRegion.offset + bunRegion.size - 1)).toBe(true)

      const probe = Bun.spawn([rebuiltPath, '--probe'], { stdout: 'pipe', stderr: 'pipe' })
      const [probeExitCode, probeStdout, probeStderr] = await Promise.all([
        probe.exited,
        new Response(probe.stdout).text(),
        new Response(probe.stderr).text(),
      ])
      expect(probeExitCode).toBe(0)
      expect(probeStderr).toBe('')
      expect(probeStdout.trim()).toBe('desktop-fixture 1.0.1')

      await copyFile(currentPath, fallbackPath)
      const runtimeRegion = currentInspection.regions.find((region) => region.kind === 'runtime')!
      const fallbackFile = await open(fallbackPath, 'r+')
      try {
        const byte = Buffer.alloc(1)
        await fallbackFile.read(byte, 0, 1, runtimeRegion.offset)
        byte[0] = byte[0]! ^ 1
        await fallbackFile.write(byte, 0, 1, runtimeRegion.offset)
      } finally {
        await fallbackFile.close()
      }
      await installUpdate({
        url: `http://127.0.0.1:${server.port}/target`,
        size: targetInfo.size,
        sha256: targetInfo.sha256,
        structural: {},
      }, { targetPath: fallbackPath })
      expect((await inspectExecutable(fallbackPath)).sha256).toBe(targetInfo.sha256)
      expect(fullResponses).toBe(1)
    } finally {
      server.stop(true)
    }
  }, 180_000)
})
