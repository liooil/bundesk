#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import {
  buildDesktopApp,
  inspectBunExecutable,
  type DesktopAppConfig,
} from './index'

const rawArgs = Bun.argv.slice(2)
if (rawArgs[0] === 'update') {
  try {
    await runUpdateCommand(rawArgs.slice(1))
    process.exit(0)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

const args = parseArgs({
  args: rawArgs,
  options: {
    config: { type: 'string', short: 'c', default: 'bundesk.config.ts' },
    target: { type: 'string', short: 't' },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
  allowPositionals: false,
})

if (args.values.help) {
  console.log(`BunDesk

Usage:
  bundesk [--config bundesk.config.ts] [--target bun-windows-x64]
  bundesk update inspect <executable>

Options:
  -c, --config <path>  Config module exporting one config or an array
  -t, --target <name>  Override the target in every config
  -h, --help           Show this help
`)
  process.exit(0)
}

const configPath = resolve(args.values.config)
if (!existsSync(configPath)) {
  console.error(`Config file not found: ${configPath}`)
  process.exit(1)
}

try {
  // The config path is selected at runtime, so it cannot be a static import.
  const module = await import(pathToFileURL(configPath).href)
  const exported = module.default as DesktopAppConfig | DesktopAppConfig[] | undefined
  if (!exported) throw new Error(`Config module must have a default export: ${configPath}`)

  const configs = Array.isArray(exported) ? exported : [exported]
  if (configs.length === 0) throw new Error('Config array must not be empty')

  for (const source of configs) {
    const config = args.values.target
      ? { ...source, target: args.values.target as Bun.Build.CompileTarget }
      : source
    console.log(`Building ${config.entrypoint} -> ${config.outfile} (${config.target ?? 'bun-windows-x64'})`)
    const output = await buildDesktopApp(config)
    console.log(`Built ${output.outfile}`)
    console.log(`Size ${output.size} bytes`)
    console.log(`SHA256 ${output.sha256.toUpperCase()}`)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

async function runUpdateCommand(commandArgs: string[]): Promise<void> {
  const command = commandArgs[0]
  const parsed = parseArgs({
    args: commandArgs.slice(1),
    options: {
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: true,
  })
  if (parsed.values.help || !command) {
    console.log(`BunDesk structural updates

Usage:
  bundesk update inspect <executable>

No update index is generated or embedded. At update time, BunDesk parses the
installed and remote executable layouts, optimistically copies runtime
sections with matching names and sizes, downloads every other byte range, and
accepts the result only when the complete target SHA-256 matches.
`)
    return
  }
  if (command !== 'inspect') throw new Error(`Unknown update command: ${command}`)
  const target = parsed.positionals[0]
  if (!target || parsed.positionals.length !== 1) throw new Error(`bundesk update ${command} requires one executable path`)
  const targetPath = resolve(target)
  if (!existsSync(targetPath)) throw new Error(`Executable not found: ${targetPath}`)
  const inspection = await inspectBunExecutable(targetPath)
  const reusableBytes = inspection.regions
    .filter((region) => region.kind === 'runtime')
    .reduce((total, region) => total + region.size, 0)
  console.log(JSON.stringify({
    parserId: inspection.parserId,
    container: inspection.container,
    size: inspection.size,
    sha256: inspection.sha256,
    runtimeFingerprint: inspection.runtimeFingerprint,
    regionCount: inspection.regions.length,
    reusableBytes,
    bun: {
      sectionOffset: inspection.bun.sectionOffset,
      sectionSize: inspection.bun.sectionSize,
      moduleCount: inspection.bun.modules.length,
      modules: inspection.bun.modules.map((module) => ({
        name: module.name,
        contents: module.contentsSize,
        sourcemap: module.sourcemapSize,
        bytecode: module.bytecodeSize,
      })),
    },
  }, null, 2))
}
