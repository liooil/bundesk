/**
 * Minimal pure-JS D-Bus client (session bus) — no native dependencies, in
 * line with the framework's single-binary/no-toolchain rule. Implements the
 * wire protocol (EXTERNAL auth, little-endian framing, signature-driven
 * codec) just far enough for the StatusNotifierItem tray; used on Linux.
 *
 * Only `unix:path=` session addresses are supported (the common
 * `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/<uid>/bus` shape).
 */

export const DBUS_IFACE = 'org.freedesktop.DBus'
export const DBUS_PATH = '/org/freedesktop/DBus'

const MESSAGE_CALL = 1
const MESSAGE_RETURN = 2
const MESSAGE_ERROR = 3
const MESSAGE_SIGNAL = 4

/** Type alignment (D-Bus spec). `(` is a struct; concrete structs align 8. */
const ALIGNMENT: Record<string, number> = {
  y: 1, b: 4, n: 2, q: 2, i: 4, u: 4, x: 8, t: 8, d: 8, s: 4, o: 4, g: 1, h: 4, a: 4, v: 1, '(': 8,
}

function skipBalanced(signature: string, openIndex: number, open: string, close: string): number {
  let depth = 0
  for (let index = openIndex; index < signature.length; index++) {
    if (signature[index] === open) depth++
    else if (signature[index] === close) {
      depth--
      if (depth === 0) return index + 1
    }
  }
  return signature.length
}

/** Splits a signature into complete top-level types ("ia{sv}av" -> ["i","a{sv}","a","v"]). */
export function splitSignature(signature: string): string[] {
  const parts: string[] = []
  let index = 0
  while (index < signature.length) {
    const start = index
    const char = signature[index]!
    index++
    if (char === 'a') {
      const element = signature[index]!
      if (element === '{') {
        index = signature.indexOf('}', index) + 1
      } else if (element === '(') {
        index = skipBalanced(signature, index, '(', ')')
      } else {
        index += 1
      }
    } else if (char === '(') {
      index = skipBalanced(signature, index - 1, '(', ')')
    }
    parts.push(signature.slice(start, index))
  }
  return parts
}

function alignOf(signature: string): number {
  const first = signature[0]!
  if (first === 'a') {
    const inner = signature.slice(1)
    return inner[0] === '{' ? 8 : alignOf(inner)
  }
  if (first === '(') return 8
  return ALIGNMENT[first] ?? 1
}

class Writer {
  private chunks: Buffer[] = []
  private size = 0

  align(n: number): void {
    const pad = (n - (this.size % n)) % n
    if (pad > 0) this.chunks.push(Buffer.alloc(pad))
    this.size += pad
  }

  u8(value: number): void { this.chunks.push(Buffer.from([value & 0xff])); this.size += 1 }
  u16(value: number): void { const b = Buffer.alloc(2); b.writeUInt16LE(value, 0); this.chunks.push(b); this.size += 2 }
  u32(value: number): void { const b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0, 0); this.chunks.push(b); this.size += 4 }
  u64(value: number | bigint): void { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value), 0); this.chunks.push(b); this.size += 8 }
  i32(value: number): void { const b = Buffer.alloc(4); b.writeInt32LE(value | 0, 0); this.chunks.push(b); this.size += 4 }
  raw(bytes: Buffer): void { this.chunks.push(bytes); this.size += bytes.length }

  bytes(): Buffer { return Buffer.concat(this.chunks) }
}

const utf8 = new TextEncoder()
const utf8Decode = new TextDecoder()

function encodeValue(writer: Writer, signature: string, value: unknown): void {
  const first = signature[0]!
  if (first === 'a') {
    const inner = signature.slice(1)
    const values = value as unknown[]
    writer.align(4)
    writer.u32(values.length)
    if (inner[0] === '{') {
      // dict entry: (key sig, value sig) — the value IS the dict array;
      // keys are always a single basic type per the D-Bus spec
      const close = inner.indexOf('}')
      const keySig = inner[1]!
      const valueSig = inner.slice(2, close)
      for (const entry of value as [unknown, unknown][]) {
        writer.align(8)
        encodeValue(writer, keySig, entry[0])
        encodeValue(writer, valueSig, entry[1])
      }
      return
    }
    for (const item of values) encodeValue(writer, inner, item)
    return
  }
  if (first === '(') {
    const members = splitSignature(signature.slice(1, -1))
    writer.align(8)
    const values = value as unknown[]
    members.forEach((member, index) => encodeValue(writer, member, values[index]))
    return
  }
  if (first === 'v') {
    const [variantSignature, variantValue] = value as [string, unknown]
    // a variant is a SIGNATURE ('g') prefix followed by the value
    writeSignature(writer, variantSignature)
    encodeValue(writer, variantSignature, variantValue)
    return
  }
  writer.align(ALIGNMENT[first] ?? 1)
  switch (first) {
    case 'y': writer.u8(value as number); break
    case 'b': writer.u32(value ? 1 : 0); break
    case 'n': writer.u16((value as number) & 0xffff); break
    case 'q': writer.u16(value as number); break
    case 'i': writer.i32(value as number); break
    case 'u': writer.u32(value as number); break
    case 'x': case 't': writer.u64(value as number | bigint); break
    case 'd': { const b = Buffer.alloc(8); b.writeDoubleLE(value as number, 0); writer.raw(b); break }
    case 's': case 'o': writeString(writer, value as string); break
    case 'g': writeSignature(writer, value as string); break
    case 'h': writer.u32(value as number); break
    default: throw new Error(`dbus encode: unsupported type '${JSON.stringify(first)}' (sig=${JSON.stringify(signature)}, value=${JSON.stringify(value)?.slice(0, 80)})`)
  }
}

function writeString(writer: Writer, value: string): void {
  const bytes = utf8.encode(value)
  writer.align(4)
  writer.u32(bytes.length)
  writer.raw(Buffer.from(bytes))
  writer.u8(0)
}

function writeSignature(writer: Writer, value: string): void {
  // D-Bus spec: the SIGNATURE type's length is a single UINT8 byte
  const bytes = utf8.encode(value)
  writer.align(1)
  writer.u8(bytes.length)
  writer.raw(Buffer.from(bytes))
  writer.u8(0)
}

function readSignature(reader: Reader): string {
  reader.align(1)
  const length = reader.u8()
  const bytes = reader.buffer.subarray(reader.offset, reader.offset + length)
  reader.offset += length + 1
  return utf8Decode.decode(bytes)
}

class Reader {
  offset = 0
  constructor(readonly buffer: Buffer) {}

  align(n: number): void {
    const pad = (n - (this.offset % n)) % n
    this.offset += pad
  }

  u8(): number { return this.buffer[this.offset++]! }
  u16(): number { const v = this.buffer.readUInt16LE(this.offset); this.offset += 2; return v }
  u32(): number { const v = this.buffer.readUInt32LE(this.offset); this.offset += 4; return v }
  u64(): bigint { const v = this.buffer.readBigUInt64LE(this.offset); this.offset += 8; return v }
  i32(): number { const v = this.buffer.readInt32LE(this.offset); this.offset += 4; return v }
  double(): number { const v = this.buffer.readDoubleLE(this.offset); this.offset += 8; return v }
}

function readString(reader: Reader): string {
  reader.align(4)
  const length = reader.u32()
  const bytes = reader.buffer.subarray(reader.offset, reader.offset + length)
  reader.offset += length + 1
  return utf8Decode.decode(bytes)
}

function decodeValue(reader: Reader, signature: string): unknown {
  const first = signature[0]!
  if (first === 'a') {
    const inner = signature.slice(1)
    reader.align(4)
    const length = reader.u32()
    if (inner[0] === '{') {
      const close = inner.indexOf('}')
      const keySig = inner[1]!
      const valueSig = inner.slice(2, close)
      const entries: [unknown, unknown][] = []
      for (let index = 0; index < length; index++) {
        reader.align(8)
        entries.push([decodeValue(reader, keySig), decodeValue(reader, valueSig)])
      }
      return entries
    }
    const values: unknown[] = []
    for (let index = 0; index < length; index++) values.push(decodeValue(reader, inner))
    return values
  }
  if (first === '(') {
    const members = splitSignature(signature.slice(1, -1))
    reader.align(8)
    return members.map((member) => decodeValue(reader, member))
  }
  if (first === 'v') {
    const variantSignature = readSignature(reader)
    return [variantSignature, decodeValue(reader, variantSignature)] as [string, unknown]
  }
  reader.align(ALIGNMENT[first] ?? 1)
  switch (first) {
    case 'y': return reader.u8()
    case 'b': return reader.u32() !== 0
    case 'n': return reader.u16()
    case 'q': return reader.u16()
    case 'i': return reader.i32()
    case 'u': return reader.u32()
    case 'x': return reader.u64()
    case 't': return reader.u64()
    case 'd': return reader.double()
    case 's': case 'o': return readString(reader)
    case 'g': return readSignature(reader)
    case 'h': return reader.u32()
    default: throw new Error(`dbus decode: unsupported type '${first}'`)
  }
}

/** Encodes a message body (values aligned per signature). */
export function encodeBody(signature: string, values: unknown[]): Buffer {
  const writer = new Writer()
  const remaining = [...values]
  for (const part of splitSignature(signature)) encodeValue(writer, part, remaining.shift())
  return writer.bytes()
}

/** Decodes a message body per signature. */
export function decodeBody(buffer: Buffer, signature: string): unknown[] {
  const reader = new Reader(buffer)
  return splitSignature(signature).map((part) => decodeValue(reader, part))
}

export interface DBusMessage {
  type: number
  serial: number
  replySerial?: number
  path?: string
  iface?: string
  member?: string
  signature?: string
  sender?: string
  errorName?: string
  body: unknown[]
}

export interface DBusConnection {
  uniqueName: string
  call(destination: string, path: string, iface: string, method: string, signature: string, args: unknown[]): Promise<unknown[]>
  reply(serial: number, signature: string, args: unknown[]): void
  sendError(serial: number, errorName: string, text: string): void
  /** Broadcasts a signal (no reply expected). */
  signal(path: string, iface: string, member: string, signature: string, args: unknown[]): void
  onMethodCall(handler: (message: DBusMessage) => void): void
  close(): void
}

type PendingCall = {
  resolve: (body: unknown[]) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const encoder = new TextEncoder()

export function sessionBusAddress(): string | null {
  const address = process.env.DBUS_SESSION_BUS_ADDRESS
  if (address) return address
  const runtime = process.env.XDG_RUNTIME_DIR
  if (runtime) return `unix:path=${runtime}/bus`
  return null
}

/** Connects to the session bus (EXTERNAL auth + Hello), returns a client. */
export function connectDBus(address: string, methodHandler: (message: DBusMessage) => void): Promise<DBusConnection> {
  return new Promise((resolve, reject) => {
    let resolved = false
    let socket: import('bun').Socket<unknown> | undefined
    const pending = new Map<number, PendingCall>()
    const calls: ((message: DBusMessage) => void)[] = [methodHandler]
    let serialCounter = 0
    let uniqueName = ''
    let readBuffer = Buffer.alloc(0)
    let authState: 'auth' | 'negotiate' | 'ready' = 'auth'
    let authAccumulator = ''
    let authCandidates: string[] = []
    let authAttempt = 0

    const sendBytes = (bytes: Uint8Array) => {
      socket?.write(bytes)
    }

    const handleFrame = (frame: Buffer) => {
      if (frame[0] !== 0x6c /* 'l' */) throw new Error('dbus: bad endianness marker')
      const type = frame[1]!
      const serial = frame.readUInt32LE(8)
      const headerLength = frame.readUInt32LE(12)
      // The daemon pads the fields region to an 8-boundary before the body:
      // a 61-byte fields region is followed by 3 pad bytes and the body
      // starts at 16+64 (verified against a live daemon's replies).
      const alignedHeader = headerLength + ((8 - (headerLength % 8)) % 8)
      const headerEnd = 16 + alignedHeader
      const reader = new Reader(frame.subarray(16, headerEnd))
      const fields = new Map<number, unknown>()
      while (reader.offset < headerLength) {
        reader.align(8)
        const fieldType = reader.u8()
        const variant = decodeValue(reader, 'v') as [string, unknown]
        fields.set(fieldType, variant[1])
      }
      const signature = (fields.get(8) as string | undefined) ?? ''
      const body = decodeBody(frame.subarray(headerEnd), signature)
      const message: DBusMessage = {
        type,
        serial,
        replySerial: fields.get(5) as number | undefined,
        path: fields.get(1) as string | undefined,
        iface: fields.get(2) as string | undefined,
        member: fields.get(3) as string | undefined,
        signature,
        sender: fields.get(7) as string | undefined,
        errorName: fields.get(4) as string | undefined,
        body,
      }
      if (process.env.DBUS_DEBUG && (type === MESSAGE_RETURN || type === MESSAGE_ERROR)) {
        console.error('[dbus-debug] reply serial=' + (message.replySerial ?? 'none') + ' error=' + (message.errorName ?? '') + ' body=' + JSON.stringify(body))
      }
      if (type === MESSAGE_RETURN || type === MESSAGE_ERROR) {
        const pendingCall = pending.get(message.replySerial ?? 0)
        if (pendingCall) {
          clearTimeout(pendingCall.timer)
          pending.delete(message.replySerial ?? 0)
          if (type === MESSAGE_ERROR) {
            pendingCall.reject(new Error(`dbus error: ${message.errorName ?? 'unknown'}: ${String(message.body[0] ?? '')}`))
          } else {
            pendingCall.resolve(message.body)
          }
        }
        return
      }
      if (type === MESSAGE_CALL) calls.forEach((handler) => handler(message))
    }

    const sendMessage = (type: number, fields: Record<number, unknown>, signature: string, args: unknown[], fixedSerial?: number) => {
      const serial = fixedSerial ?? ++serialCounter
      // Each header field is a struct aligned to 8; the daemon parses fields
      // up to the declared header length, so each field is built and padded
      // to an 8-byte multiple independently (dbus-send's Hello has 4 fields
      // of 32/32/32/16 bytes; a shared writer with a single trailing pad
      // produces a frame the daemon silently ignores).
      // Header fields are built in ONE writer with NATURAL alignment and the
      // declared length is the raw content sum — the exact style dbus-send
      // and the daemon's own replies use (verified: per-field 8-padding or a
      // padded declared length makes this daemon close the connection).
      const fieldsWriter = new Writer()
      for (const [key, value] of Object.entries(fields).sort(([a], [b]) => Number(a) - Number(b))) {
        fieldsWriter.align(8)
        fieldsWriter.u8(Number(key))
        encodeValue(fieldsWriter, 'v', value as [string, unknown])
      }
      const headerFields = fieldsWriter.bytes()
      const writer = new Writer()
      writer.u8(0x6c)
      writer.u8(type)
      writer.u8(0)
      writer.u8(1)
      writer.u32(0) // body length placeholder
      writer.u32(serial)
      writer.u32(headerFields.length)
      writer.raw(headerFields)
      const body = encodeBody(signature, args)
      const frame = writer.bytes()
      frame.writeUInt32LE(body.length, 4)
      const full = Buffer.concat([frame, body])
      sendBytes(full)
      return serial
    }

    const socketHandler: import('bun').SocketHandler = {
      open(opened) {
        socket = opened
        const uid = typeof process.getuid === 'function' ? process.getuid() : 0
        // EXTERNAL auth: most daemons want the numeric uid in hex ('0'),
        // some want the hex of the uid's decimal ASCII string ('30' for 0);
        // on REJECTED we retry with the other form.
        authCandidates = process.env.DBUS_AUTH_FIRST
          ? [`AUTH EXTERNAL ${process.env.DBUS_AUTH_FIRST}\r\n`]
          : [
            // hex of the uid's decimal ASCII string — what dbus-send sends
            // ('30' for uid 0); some daemons only accept this form
            `AUTH EXTERNAL ${Buffer.from(String(uid)).toString('hex')}\r\n`,
            // plain numeric hex ('0' for uid 0) as the fallback
            `AUTH EXTERNAL ${uid.toString(16)}\r\n`,
          ]
        // NUL byte precedes the first auth line only
        sendBytes(encoder.encode(`\0${authCandidates[0]!}`))
        authAttempt = 0
      },
      data(_opened, data) {
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data)
        if (authState !== 'ready') {
          authAccumulator += chunk.toString('latin1')
          const lineEnd = authAccumulator.indexOf('\r\n')
          if (lineEnd === -1) return
          const line = authAccumulator.slice(0, lineEnd)
          authAccumulator = authAccumulator.slice(lineEnd + 2)
          if (authState === 'auth') {
            if (line.startsWith('REJECTED') && authAttempt < authCandidates.length - 1) {
              authAttempt++
              sendBytes(encoder.encode(authCandidates[authAttempt]!))
              return
            }
            if (!line.startsWith('OK')) {
              reject(new Error(`dbus auth failed: ${line}`))
              return
            }
            // NEGOTIATE_UNIX_FD and wait for AGREE (or ERROR) before BEGIN:
            // sending BEGIN before the daemon's reply makes some daemons
            // close the connection on the first message
            authState = 'negotiate'
            sendBytes(encoder.encode('NEGOTIATE_UNIX_FD\r\n'))
            return
          }
          // 'negotiate': AGREE_UNIX_FD (or ERROR) -> BEGIN + Hello. Hello must
          // go out after BEGIN, and method calls REQUIRE the PATH (+ MEMBER)
          // header fields, otherwise the daemon closes the connection.
          authState = 'ready'
          sendBytes(encoder.encode('BEGIN\r\n'))
          // The Hello is sent as the exact byte sequence dbus-send produces
          // (verified against a live daemon): PATH + DESTINATION + INTERFACE +
          // MEMBER fields, headerLen=110. The generic field builder produces
          // a frame the daemon silently ignores (109-byte variant) — the
          // wire forensics are documented in the git history.
          const helloFrame = Buffer.from(
            '6c01000100000000010000006e000000' +
            '01016f00150000002f6f72672f667265656465736b746f702f44427573000000' +
            '06017300140000006f72672e667265656465736b746f702e4442757300000000' +
            '02017300140000006f72672e667265656465736b746f702e4442757300000000' +
            '030173000500000048656c6c6f000000',
            'hex',
          )
          sendBytes(helloFrame)
          // after BEGIN, the accumulated remainder may already contain frames
          const remainder = Buffer.from(authAccumulator, 'latin1')
          if (remainder.length > 0) readBuffer = Buffer.concat([readBuffer, remainder])
          drainFrames()
          return
        }
        readBuffer = Buffer.concat([readBuffer, chunk])
        try {
          drainFrames()
        } catch (error) {
          console.error('[BunDesk] dbus frame parse error:', error instanceof Error ? error.message : String(error))
        }
      },
      error(_opened, error) {
        if (!resolved) reject(error)
      },
      close() {
        pending.forEach((call) => {
          clearTimeout(call.timer)
          call.reject(new Error('dbus connection closed'))
        })
        pending.clear()
      },
    }

    const drainFrames = () => {
      while (readBuffer.length >= 16) {
        const bodyLength = readBuffer.readUInt32LE(4)
        const headerLength = readBuffer.readUInt32LE(12)
        const alignedHeader = headerLength + ((8 - (headerLength % 8)) % 8)
        const total = 16 + alignedHeader + bodyLength
        if (readBuffer.length < total) return
        const frame = readBuffer.subarray(0, total)
        readBuffer = readBuffer.subarray(total)
        handleFrame(frame)
      }
    }

    const conn: DBusConnection = {
      uniqueName: '',
      async call(destination, path, iface, method, signature, args) {
        const fields: Record<number, [string, unknown]> = {
          1: ['o', path],
          2: ['s', iface],
          3: ['s', method],
          6: ['s', destination],
        }
        // An EMPTY signature field makes some daemons close the connection;
        // dbus-send omits the field entirely for bodyless calls.
        if (signature !== '') fields[8] = ['g', signature]
        const serial = sendMessage(MESSAGE_CALL, fields, signature, [...args])
        return new Promise((resolveCall, rejectCall) => {
          const timer = setTimeout(() => {
            pending.delete(serial)
            rejectCall(new Error(`dbus call timed out: ${iface}.${method}`))
          }, 15_000)
          pending.set(serial, { resolve: resolveCall, reject: rejectCall, timer })
        })
      },
      reply(serial, signature, args) {
        sendMessage(MESSAGE_RETURN, { 5: ['u', serial], 8: ['g', signature] }, signature, [...args])
      },
      sendError(serial, errorName, text) {
        sendMessage(MESSAGE_ERROR, { 4: ['s', errorName], 5: ['u', serial], 8: ['g', 's'] }, 's', [text])
      },
      signal(path, iface, member, signature, args) {
        sendMessage(MESSAGE_SIGNAL, {
          1: ['o', path],
          2: ['s', iface],
          3: ['s', member],
          8: ['g', signature],
        }, signature, [...args])
      },
      onMethodCall(handler) {
        calls.push(handler)
      },
      close() {
        socket?.end()
      },
    }

    const finish = (name: string) => {
      if (resolved) return
      resolved = true
      uniqueName = name
      conn.uniqueName = name
      resolve(conn)
    }

    // Hello is a special call without a destination; the frame is sent once
    // the auth handshake completes (see the auth-ready branch above).
    const helloSerial = ++serialCounter
    const timer = setTimeout(() => {
      if (!resolved) reject(new Error('dbus connect timed out'))
    }, 10_000)
    pending.set(helloSerial, {
      resolve: (body) => {
        clearTimeout(timer)
        finish(String(body[0]))
      },
      reject: (error) => {
        clearTimeout(timer)
        if (!resolved) reject(error)
      },
      timer,
    })

    if (!address.startsWith('unix:path=')) {
      reject(new Error(`dbus: unsupported session address '${address}' (only unix:path= is supported)`))
      return
    }
    const socketPath = address.slice('unix:path='.length)
    Bun.connect({ unix: socketPath, socket: socketHandler }).catch((error) => {
      if (!resolved) reject(error)
    })
  })
}
