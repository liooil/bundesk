/**
 * Cross-platform wrapper for the forced-target build scripts. It exports the
 * requested platform from bundesk.config.ts via BUNDESK_EXAMPLE_PLATFORM and
 * then lets the regular CLI apply the exact Bun compile target. Pass `native`
 * instead of a target to build every config exported for that platform (used
 * for the two macOS architectures).
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [platform = '', target = 'native'] = Bun.argv.slice(2)
if (!['win32', 'linux', 'darwin'].includes(platform) || (target !== 'native' && !target.startsWith('bun-'))) {
  console.error('Usage: bun bin/build-target.ts <win32|linux|darwin> [bun-compile-target|native]')
  process.exit(2)
}

const exampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cliPath = resolve(exampleRoot, '..', 'src', 'cli.ts')
const args = [process.execPath, cliPath, '-c', 'bundesk.config.ts']
if (target !== 'native') args.push('-t', target)
const child = Bun.spawn(args, {
  cwd: exampleRoot,
  env: { ...process.env, BUNDESK_EXAMPLE_PLATFORM: platform },
  stdio: ['inherit', 'inherit', 'inherit'],
})
process.exit(await child.exited)
