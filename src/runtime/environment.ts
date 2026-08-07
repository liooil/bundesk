import { basename } from 'node:path'

/**
 * App environment resolution for the framework.
 *
 * The mode only fills DEFAULTS: any behavior the user configured explicitly
 * (e.g. `server: { development: false }`) always wins over the mode.
 *
 * Priority (highest first):
 *   1. CLI flag: `--mode=development` / `--mode=production` (or `--mode <value>`)
 *   2. `BUNDESK_ENV` env var — framework-specific override, so apps that
 *      need NODE_ENV for their own purposes can pin it independently
 *   3. `NODE_ENV` env var (standard; only 'development'/'production' are
 *      meaningful)
 *   4. Default: 'production' when the process is a compiled single binary
 *      (anything other than bun itself), 'development' when running under bun
 *
 * Values other than 'development'/'production' are never consumed: a CLI
 * `--mode=staging` or a NODE_ENV=staging falls through untouched (the flag
 * remains an app argument, the env var stays for the app to read).
 *
 * The flag is `--mode` (run mode), NOT `--env`, so it cannot be confused
 * with docker-style `--env=NAME=VALUE` variable injection.
 */

export type AppEnvironment = 'development' | 'production'

const DEVELOPMENT = 'development'
const PRODUCTION = 'production'

export function isAppEnvironment(value: string | undefined): value is AppEnvironment {
  return value === DEVELOPMENT || value === PRODUCTION
}

/** True when the current process is a compiled single binary, not bun itself. */
export function isPackagedRuntime(): boolean {
  const exe = basename(process.execPath).toLowerCase()
  return exe !== 'bun' && exe !== 'bun.exe' && exe !== 'bun-debug' && exe !== 'bun-debug.exe'
}

export interface ResolveEnvironmentOptions {
  /** override the packaged detection (tests); defaults to isPackagedRuntime() */
  packaged?: boolean
  /** env var accessor (tests); defaults to process.env */
  env?: Record<string, string | undefined>
}

/** Extracts `--mode=...` / `--mode ...` from argv; invalid values are ignored. */
function cliEnvironment(args: string[]): AppEnvironment | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg.startsWith('--mode=')) {
      const value = arg.slice('--mode='.length)
      if (isAppEnvironment(value)) return value
    } else if (arg === '--mode') {
      const value = args[index + 1]
      if (isAppEnvironment(value)) return value
    }
  }
  return undefined
}

export function resolveAppEnvironment(args: string[], options: ResolveEnvironmentOptions = {}): AppEnvironment {
  const envVars = options.env ?? process.env
  return (
    cliEnvironment(args)
    ?? (isAppEnvironment(envVars.BUNDESK_ENV) ? envVars.BUNDESK_ENV : undefined)
    ?? (isAppEnvironment(envVars.NODE_ENV) ? envVars.NODE_ENV : undefined)
    ?? ((options.packaged ?? isPackagedRuntime()) ? PRODUCTION : DEVELOPMENT)
  )
}
