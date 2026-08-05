#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { buildDesktopApp } from './index'
import type { DesktopAppConfig } from './index'

const args = parseArgs({
  args: Bun.argv.slice(2),
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
