import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getAppDataDirectory } from './paths'

export type StickyPortOptions = boolean | { dataDirectory?: string }

export interface StickyPortState {
  enabled: boolean
  preferredPort: number
  recordPath: string | null
}

interface StickyPortRecord {
  port: number
}

const RECORD_NAME = 'server-port.json'

export async function readStickyPort(appId: string, options: StickyPortOptions | undefined): Promise<StickyPortState> {
  if (options === false) return { enabled: false, preferredPort: 0, recordPath: null }

  const dataDirectory = typeof options === 'object' && options.dataDirectory
    ? options.dataDirectory
    : getAppDataDirectory(appId)
  const recordPath = join(dataDirectory, RECORD_NAME)

  try {
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as Partial<StickyPortRecord>
    if (Number.isInteger(record.port) && (record.port as number) > 0 && (record.port as number) <= 65_535) {
      return { enabled: true, preferredPort: record.port as number, recordPath }
    }
  } catch {
    // A missing or malformed record is equivalent to the first launch.
  }

  return { enabled: true, preferredPort: 0, recordPath }
}

export async function writeStickyPort(state: StickyPortState, port: number | undefined): Promise<void> {
  if (!state.enabled || !state.recordPath || typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65_535) return
  await mkdir(dirname(state.recordPath), { recursive: true })
  await writeFile(state.recordPath, JSON.stringify({ port } satisfies StickyPortRecord), {
    encoding: 'utf8',
    mode: 0o600,
  })
}
