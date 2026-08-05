import { randomBytes } from 'node:crypto'
import { chmod, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileHandle } from 'node:fs/promises'
import { getAppDataDirectory, validateAppId } from './paths'

export interface SecondInstanceEvent {
  argv: string[]
  cwd: string
  pid: number
  receivedAt: string
}

export interface AcquireSingleInstanceOptions {
  appId: string
  dataDirectory?: string
  argv?: string[]
  cwd?: string
  onSecondInstance?: (event: SecondInstanceEvent) => void | Promise<unknown>
  timeoutMs?: number
}

export interface PrimaryInstance {
  kind: 'primary'
  dataDirectory: string
  release(): Promise<void>
}

export interface ForwardedInstance {
  kind: 'secondary'
  status: number
  accepted: boolean
  /** JSON-serializable value returned by the primary's onSecondInstance handler. */
  result?: unknown
}

export type SingleInstanceResult = PrimaryInstance | ForwardedInstance

interface InstanceRecord {
  appId: string
  pid: number
  port: number
  token: string
  createdAt: string
}

export class SingleInstanceUnavailableError extends Error {
  constructor(appId: string) {
    super(`The primary ${appId} instance is starting but did not accept the forwarded launch`)
    this.name = 'SingleInstanceUnavailableError'
  }
}

export async function acquireSingleInstance(options: AcquireSingleInstanceOptions): Promise<SingleInstanceResult> {
  const appId = validateAppId(options.appId)
  const dataDirectory = options.dataDirectory ?? getAppDataDirectory(appId)
  const lockPath = join(dataDirectory, 'instance.lock')
  const recordPath = join(dataDirectory, 'instance.json')
  const timeoutMs = options.timeoutMs ?? 4_000
  await mkdir(dataDirectory, { recursive: true })

  for (let attempt = 0; attempt < 2; attempt++) {
    let lock: FileHandle | undefined
    try {
      lock = await open(lockPath, 'wx', 0o600)
      await lock.writeFile(String(process.pid))
      return await startPrimaryInstance({
        appId,
        dataDirectory,
        recordPath,
        lockPath,
        lock,
        onSecondInstance: options.onSecondInstance,
      })
    } catch (error) {
      if (lock) await lock.close().catch(() => undefined)
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const record = await readInstanceRecord(recordPath)
      if (record?.appId === appId) {
        const forwarded = await forwardLaunch(record, {
          argv: options.argv ?? process.argv.slice(2),
          cwd: options.cwd ?? process.cwd(),
          pid: process.pid,
          receivedAt: new Date().toISOString(),
        })
        if (forwarded) return forwarded
      }
      await Bun.sleep(50)
    }

    const ownerPid = Number.parseInt(await readFile(lockPath, 'utf8').catch(() => ''), 10)
    if (Number.isInteger(ownerPid) && isProcessAlive(ownerPid)) {
      throw new SingleInstanceUnavailableError(appId)
    }
    await Promise.all([
      rm(recordPath, { force: true }),
      rm(lockPath, { force: true }),
    ])
  }

  throw new SingleInstanceUnavailableError(appId)
}

async function startPrimaryInstance(options: {
  appId: string
  dataDirectory: string
  recordPath: string
  lockPath: string
  lock: FileHandle
  onSecondInstance?: (event: SecondInstanceEvent) => void | Promise<unknown>
}): Promise<PrimaryInstance> {
  const token = randomBytes(32).toString('hex')
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== '/second-instance' || request.method !== 'POST') {
        return new Response('Not found', { status: 404 })
      }
      if (request.headers.get('authorization') !== `Bearer ${token}`) {
        return new Response('Unauthorized', { status: 401 })
      }
      const declaredSize = Number.parseInt(request.headers.get('content-length') ?? '0', 10)
      if (declaredSize > 1024 * 1024) return new Response('Payload too large', { status: 413 })

      let event: SecondInstanceEvent
      try {
        event = validateSecondInstanceEvent(await request.json())
      } catch (error) {
        return new Response(error instanceof Error ? error.message : 'Invalid payload', { status: 400 })
      }

      try {
        const result = await options.onSecondInstance?.(event)
        return Response.json(result === undefined ? { accepted: true } : { accepted: true, result })
      } catch (error) {
        console.error('[BunDesk] onSecondInstance failed:', error)
        return Response.json({ accepted: false }, { status: 500 })
      }
    },
  })
  if (server.port === undefined) {
    await server.stop(true)
    await options.lock.close()
    await rm(options.lockPath, { force: true })
    throw new Error('Single-instance IPC server did not bind a TCP port')
  }

  const record: InstanceRecord = {
    appId: options.appId,
    pid: process.pid,
    port: server.port,
    token,
    createdAt: new Date().toISOString(),
  }
  await writeFile(options.recordPath, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 })
  await chmod(options.recordPath, 0o600).catch(() => undefined)

  let released = false
  return {
    kind: 'primary',
    dataDirectory: options.dataDirectory,
    async release() {
      if (released) return
      released = true
      await server.stop(true)
      await options.lock.close()
      await Promise.all([
        rm(options.recordPath, { force: true }),
        rm(options.lockPath, { force: true }),
      ])
    },
  }
}

async function readInstanceRecord(path: string): Promise<InstanceRecord | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<InstanceRecord>
    if (
      typeof value.appId !== 'string' ||
      !Number.isInteger(value.pid) ||
      !Number.isInteger(value.port) ||
      typeof value.token !== 'string' ||
      value.token.length < 32 ||
      typeof value.createdAt !== 'string'
    ) return null
    return value as InstanceRecord
  } catch {
    return null
  }
}

async function forwardLaunch(record: InstanceRecord, event: SecondInstanceEvent): Promise<ForwardedInstance | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${record.port}/second-instance`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${record.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(1_500),
    })
    if (response.status === 401 || response.status === 404) return null
    const payload = await response.json().catch(() => null) as { accepted?: boolean; result?: unknown } | null
    return {
      kind: 'secondary',
      status: response.status,
      accepted: payload?.accepted === true,
      result: 'result' in (payload ?? {}) ? payload?.result : undefined,
    }
  } catch {
    return null
  }
}

function validateSecondInstanceEvent(value: unknown): SecondInstanceEvent {
  if (!value || typeof value !== 'object') throw new Error('Invalid second-instance payload')
  const candidate = value as Partial<SecondInstanceEvent>
  if (!Array.isArray(candidate.argv) || candidate.argv.some((arg) => typeof arg !== 'string')) {
    throw new Error('argv must be an array of strings')
  }
  if (typeof candidate.cwd !== 'string' || typeof candidate.pid !== 'number' || typeof candidate.receivedAt !== 'string') {
    throw new Error('Invalid second-instance fields')
  }
  return candidate as SecondInstanceEvent
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
