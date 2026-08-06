import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * cc() and dlopen() need a real native path. Dev runs resolve to the repo
 * file and are passed through untouched; compiled single binaries resolve to
 * Bun's embedded virtual filesystem (`B:/~BUN/...` on Windows,
 * `/$bunfs/...` on Linux) which only Bun.file can read, so those bytes are
 * materialized to a real temp file.
 */
export async function materializeNativePath(importedPath: string, tempName: string): Promise<string> {
  if (!importedPath.includes('~BUN') && !importedPath.startsWith('/$bunfs/')) return importedPath
  const bytes = new Uint8Array(await Bun.file(importedPath).arrayBuffer())
  const realPath = join(tmpdir(), tempName)
  await writeFile(realPath, bytes)
  return realPath
}
