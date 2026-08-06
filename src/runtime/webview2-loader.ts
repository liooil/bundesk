import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ZipReader, BlobReader, BlobWriter } from '@zip.js/zip.js'

/**
 * WebView2Loader.dll provisioning.
 *
 * The loader is the supported way to discover the WebView2 runtime (the
 * unified runtime's client DLL only exports the unstable
 * `CreateWebViewEnvironmentWithOptionsInternal`, so bypassing the loader is
 * not viable). Instead of committing the 164 KB binary to the repository, it
 * is downloaded from the official Microsoft.Web.WebView2 NuGet package on
 * first use and materialized at the package's fixed import location
 * (`src/webview2-loader.dll`), which is gitignored:
 *
 * - dev (`bun app.ts`): webview2.ts awaits `ensureWebView2Loader()` before its
 *   dynamic import of the DLL, so the file exists when resolved;
 * - build (`bunx bundesk`): buildDesktopApp awaits `ensureWebView2Loader()`
 *   before Bun.build, so `bun build --compile` embeds the file into the
 *   single binary.
 *
 * The version and SHA-256 are pinned; a change in either re-downloads.
 * The download only runs on a cold cache, so repeat builds are free.
 */

export const WEBVIEW2_LOADER_VERSION = '1.0.4129.50'
const NUGET_URL = `https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/${WEBVIEW2_LOADER_VERSION}`
const NUGET_DLL_ENTRY = 'runtimes/win-x64/native/WebView2Loader.dll'
const LOADER_SHA256 = 'a9a09232c25805323d4cfb3fc8f545a190a9c8a99c93262ea99d0b88df99ec90'

/** The fixed import location for `../webview2-loader.dll` from src/runtime/. */
function loaderTargetPath(): string {
  return join(import.meta.dir, '..', 'webview2-loader.dll')
}

let ensurePromise: Promise<string> | null = null

export async function ensureWebView2Loader(): Promise<string> {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      const path = loaderTargetPath()
      // Compiled single binaries resolve the import to Bun's embedded
      // filesystem (B:\~BUN\root or B:/~BUN/root); the loader is already in
      // the executable and there is nothing to provision (and nothing to
      // write to).
      if (import.meta.dir.includes('~BUN')) return path
      if (await Bun.file(path).exists()) return path

      const response = await fetch(NUGET_URL)
      if (!response.ok) {
        throw new Error(`Failed to download the WebView2 SDK (${response.status} ${response.statusText}): ${NUGET_URL}`)
      }
      const reader = new ZipReader(new BlobReader(await response.blob()))
      try {
        const entry = (await reader.getEntries()).find((candidate) => candidate.filename === NUGET_DLL_ENTRY)
        if (!entry || !('getData' in entry)) {
          throw new Error(`WebView2 SDK ${WEBVIEW2_LOADER_VERSION} does not contain ${NUGET_DLL_ENTRY}`)
        }
        const bytes = new Uint8Array(await (await entry.getData(new BlobWriter())).arrayBuffer())
        const hasher = new Bun.CryptoHasher('sha256')
        hasher.update(bytes)
        const digest = hasher.digest('hex')
        if (digest !== LOADER_SHA256) {
          throw new Error(`WebView2Loader.dll SHA-256 mismatch: expected ${LOADER_SHA256}, received ${digest}`)
        }
        await mkdir(import.meta.dir, { recursive: true })
        await writeFile(path, bytes)
        return path
      } finally {
        await reader.close()
      }
    })()
  }
  return ensurePromise
}
