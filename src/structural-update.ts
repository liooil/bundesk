import { open } from 'node:fs/promises'

export type BunExecutableContainer = 'pe64' | 'elf64' | 'macho64'
export type StructuralRegionKind = 'runtime' | 'platform' | 'bun'

export interface StructuralRegion {
  kind: StructuralRegionKind
  name: string
  reuseClass: string
  offset: number
  size: number
}

export interface BunModuleInspection {
  index: number
  name: string
  contentsSize: number
  sourcemapSize: number
  bytecodeSize: number
}

export interface BunGraphInspection {
  sectionOffset: number
  sectionSize: number
  graphSize: number
  moduleCount: number
  modules: BunModuleInspection[]
}

export interface BunExecutableInspection {
  parserId: string
  container: BunExecutableContainer
  size: number
  sha256: string
  runtimeFingerprint: string
  bun: BunGraphInspection
  regions: StructuralRegion[]
}

export interface StructuralReuseCopy {
  sourceOffset: number
  targetOffset: number
  size: number
}

export interface StructuralDownloadRange {
  start: number
  end: number
}

export interface StructuralReusePlan {
  container: BunExecutableContainer
  targetSize: number
  reusedBytes: number
  downloadBytes: number
  copies: StructuralReuseCopy[]
  downloads: StructuralDownloadRange[]
}

export interface StructuralReconstructionProgress {
  phase: 'inspecting-current' | 'reconstructing' | 'downloading' | 'verifying'
  downloaded: number
  downloadTotal: number
  reused: number
  targetTotal: number
}

export interface ReconstructStructuralUpdateOptions {
  currentPath: string
  outputPath: string
  targetUrl: string
  targetSha256: string
  targetSize?: number
  headers?: Record<string, string>
  ifRange?: string
  signal?: AbortSignal
  onProgress?: (progress: StructuralReconstructionProgress) => void
}

export class StructuralRangeUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StructuralRangeUnsupportedError'
  }
}

export class StructuralReconstructionMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(`Index-free structural reconstruction SHA-256 mismatch: expected ${expected}, received ${actual}`)
    this.name = 'StructuralReconstructionMismatchError'
  }
}

interface ParsedContainer {
  parserId: string
  container: BunExecutableContainer
  regions: StructuralRegion[]
  bun: BunGraphInspection
}

interface RemoteLayout {
  container: BunExecutableContainer
  targetSize: number
  regions: StructuralRegion[]
}

interface ElfSectionTable {
  offset: number
  size: number
  entrySize: number
  count: number
  stringTableIndex: number
}

const BUN_TRAILER = new TextEncoder().encode('\n---- Bun! ----\n')
const OFFSETS_SIZE = 32
const MODULE_RECORD_SIZE = 52
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export async function inspectBunExecutable(path: string): Promise<BunExecutableInspection> {
  const file = Bun.file(path)
  if (!(await file.exists()) || file.size <= 0) throw new Error(`Executable does not exist or is empty: ${path}`)
  return inspectBunExecutableBytes(new Uint8Array(await file.arrayBuffer()))
}

export function inspectBunExecutableBytes(bytes: Uint8Array): BunExecutableInspection {
  const parsed = parseContainer(bytes)
  const runtimeHasher = new Bun.CryptoHasher('sha256')
  for (const region of parsed.regions) {
    if (region.kind !== 'runtime') continue
    runtimeHasher.update(textEncoder.encode(`${region.reuseClass}:${region.size}:`))
    runtimeHasher.update(bytes.subarray(region.offset, region.offset + region.size))
  }
  return {
    parserId: parsed.parserId,
    container: parsed.container,
    size: bytes.byteLength,
    sha256: sha256(bytes),
    runtimeFingerprint: runtimeHasher.digest('hex'),
    bun: parsed.bun,
    regions: parsed.regions,
  }
}

/**
 * Plans optimistic reuse without a target-side index. Only target runtime
 * sections with the same container identity and byte length are copied.
 * Headers, platform resources, signatures, gaps, and the complete `.bun`
 * section are always fetched. The caller must verify the final target digest.
 */
export function planStructuralUpdate(
  target: { container: BunExecutableContainer; targetSize: number; regions: StructuralRegion[] },
  current: BunExecutableInspection,
): StructuralReusePlan {
  if (target.container !== current.container) throw new Error(`Structural update container mismatch: ${current.container} -> ${target.container}`)
  if (!Number.isSafeInteger(target.targetSize) || target.targetSize <= 0) throw new Error('Structural update target size is invalid')
  const sources = new Map<string, StructuralRegion>()
  for (const region of current.regions) {
    if (region.kind === 'runtime') sources.set(regionMatchKey(region), region)
  }
  const copies: StructuralReuseCopy[] = []
  for (const region of target.regions) {
    if (region.offset + region.size > target.targetSize) throw new Error(`Target region ${region.name} exceeds target size`)
    if (region.kind !== 'runtime') continue
    const source = sources.get(regionMatchKey(region))
    if (source) copies.push({ sourceOffset: source.offset, targetOffset: region.offset, size: region.size })
  }
  copies.sort((left, right) => left.targetOffset - right.targetOffset)
  const mergedCopies: StructuralReuseCopy[] = []
  for (const copy of copies) {
    const previous = mergedCopies.at(-1)
    if (previous && previous.targetOffset + previous.size === copy.targetOffset && previous.sourceOffset + previous.size === copy.sourceOffset) {
      previous.size += copy.size
    } else {
      mergedCopies.push({ ...copy })
    }
  }
  const downloads: StructuralDownloadRange[] = []
  let cursor = 0
  let reusedBytes = 0
  for (const copy of mergedCopies) {
    if (copy.targetOffset < cursor) throw new Error('Target runtime regions overlap')
    if (copy.targetOffset > cursor) downloads.push({ start: cursor, end: copy.targetOffset - 1 })
    cursor = copy.targetOffset + copy.size
    reusedBytes += copy.size
  }
  if (cursor < target.targetSize) downloads.push({ start: cursor, end: target.targetSize - 1 })
  return {
    container: target.container,
    targetSize: target.targetSize,
    reusedBytes,
    downloadBytes: target.targetSize - reusedBytes,
    copies: mergedCopies,
    downloads,
  }
}

export async function reconstructStructuralUpdate(options: ReconstructStructuralUpdateOptions): Promise<StructuralReusePlan> {
  const expectedSha256 = options.targetSha256.replace(/^sha256:/i, '').toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error('Index-free structural updates require a valid target SHA-256')
  const remote = await fetchRemoteLayout({
    url: options.targetUrl,
    targetSize: options.targetSize,
    headers: options.headers,
    ifRange: options.ifRange,
    signal: options.signal,
  })
  options.onProgress?.({ phase: 'inspecting-current', downloaded: 0, downloadTotal: 0, reused: 0, targetTotal: remote.targetSize })
  const current = await inspectBunExecutable(options.currentPath)
  const plan = planStructuralUpdate(remote, current)
  const currentFile = await open(options.currentPath, 'r')
  const outputFile = await open(options.outputPath, 'w+', 0o700)
  let downloaded = 0
  try {
    await outputFile.truncate(plan.targetSize)
    const copyBuffer = Buffer.allocUnsafe(1024 * 1024)
    for (const copy of plan.copies) {
      let remaining = copy.size
      let sourceOffset = copy.sourceOffset
      let targetOffset = copy.targetOffset
      while (remaining > 0) {
        if (options.signal?.aborted) throw options.signal.reason ?? new Error('Update cancelled')
        const size = Math.min(remaining, copyBuffer.byteLength)
        const { bytesRead } = await currentFile.read(copyBuffer, 0, size, sourceOffset)
        if (bytesRead !== size) throw new Error(`Current executable ended while copying runtime region at ${copy.sourceOffset}`)
        await writeAll(outputFile, copyBuffer.subarray(0, bytesRead), targetOffset)
        sourceOffset += bytesRead
        targetOffset += bytesRead
        remaining -= bytesRead
      }
      options.onProgress?.({ phase: 'reconstructing', downloaded, downloadTotal: plan.downloadBytes, reused: plan.reusedBytes, targetTotal: plan.targetSize })
    }
    for (const range of plan.downloads) {
      const response = await fetchExactRange(options.targetUrl, range.start, range.end, plan.targetSize, options.headers, options.ifRange, options.signal)
      const reader = response.body!.getReader()
      let rangeBytes = 0
      const expected = range.end - range.start + 1
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        if (rangeBytes + value.byteLength > expected) throw new Error(`Range ${range.start}-${range.end} exceeded its declared length`)
        await writeAll(outputFile, value, range.start + rangeBytes)
        rangeBytes += value.byteLength
        downloaded += value.byteLength
        options.onProgress?.({ phase: 'downloading', downloaded, downloadTotal: plan.downloadBytes, reused: plan.reusedBytes, targetTotal: plan.targetSize })
      }
      if (rangeBytes !== expected) throw new Error(`Range ${range.start}-${range.end} length mismatch: expected ${expected}, received ${rangeBytes}`)
    }
    await outputFile.sync()
  } finally {
    await Promise.all([currentFile.close(), outputFile.close()])
  }
  options.onProgress?.({ phase: 'verifying', downloaded, downloadTotal: plan.downloadBytes, reused: plan.reusedBytes, targetTotal: plan.targetSize })
  const actualSha256 = await sha256File(options.outputPath)
  if (actualSha256 !== expectedSha256) throw new StructuralReconstructionMismatchError(expectedSha256, actualSha256)
  return plan
}

async function fetchRemoteLayout(options: {
  url: string
  targetSize?: number
  headers?: Record<string, string>
  ifRange?: string
  signal?: AbortSignal
}): Promise<RemoteLayout> {
  const initialEnd = Math.min((options.targetSize ?? 4096) - 1, 4095)
  const initial = await fetchRangeBytes(options.url, 0, initialEnd, options.targetSize, options.headers, options.ifRange, options.signal)
  const targetSize = options.targetSize ?? initial.total
  if (targetSize !== initial.total) throw new Error(`Target size changed: expected ${targetSize}, received ${initial.total}`)
  const container = detectContainer(initial.bytes)
  if (container === 'pe64') {
    const required = peHeadersEnd(initial.bytes)
    const headers = required <= initial.bytes.byteLength
      ? initial.bytes
      : (await fetchRangeBytes(options.url, 0, required - 1, targetSize, options.headers, options.ifRange, options.signal)).bytes
    return { container, targetSize, regions: parsePeRegions(headers, targetSize, false) }
  }
  if (container === 'elf64') {
    const location = elfSectionTableLocation(initial.bytes)
    const table = (await fetchRangeBytes(options.url, location.offset, location.offset + location.size - 1, targetSize, options.headers, options.ifRange, options.signal)).bytes
    const stringHeaderOffset = location.stringTableIndex * location.entrySize
    const stringOffset = readU64(table, stringHeaderOffset + 24)
    const stringSize = readU64(table, stringHeaderOffset + 32)
    const strings = (await fetchRangeBytes(options.url, stringOffset, stringOffset + stringSize - 1, targetSize, options.headers, options.ifRange, options.signal)).bytes
    return { container, targetSize, regions: parseElfRegions(table, strings, location, targetSize, false) }
  }
  const commandBytes = readU32(initial.bytes, 20)
  const commandsEnd = 32 + commandBytes
  const commands = commandsEnd <= initial.bytes.byteLength
    ? initial.bytes
    : (await fetchRangeBytes(options.url, 0, commandsEnd - 1, targetSize, options.headers, options.ifRange, options.signal)).bytes
  return { container, targetSize, regions: parseMachoRegions(commands, targetSize, false) }
}

function parseContainer(bytes: Uint8Array): ParsedContainer {
  const container = detectContainer(bytes)
  if (container === 'pe64') {
    const regions = parsePeRegions(bytes, bytes.byteLength, true)
    const bunRegion = requireBunRegion(regions, 'PE executable does not contain .bun')
    return { parserId: 'bun-standalone-pe64-layout-v1', container, regions, bun: parseBunGraph(bytes, bunRegion.offset, bunRegion.size) }
  }
  if (container === 'elf64') {
    const location = elfSectionTableLocation(bytes)
    requireRange(bytes, location.offset, location.size, 'ELF section table')
    const table = bytes.subarray(location.offset, location.offset + location.size)
    const stringHeaderOffset = location.stringTableIndex * location.entrySize
    const stringOffset = readU64(table, stringHeaderOffset + 24)
    const stringSize = readU64(table, stringHeaderOffset + 32)
    requireRange(bytes, stringOffset, stringSize, 'ELF section names')
    const regions = parseElfRegions(table, bytes.subarray(stringOffset, stringOffset + stringSize), location, bytes.byteLength, true)
    const bunRegion = requireBunRegion(regions, 'ELF executable does not contain .bun')
    return { parserId: 'bun-standalone-elf64-layout-v1', container, regions, bun: parseBunGraph(bytes, bunRegion.offset, bunRegion.size) }
  }
  const regions = parseMachoRegions(bytes, bytes.byteLength, true)
  const bunRegion = requireBunRegion(regions, 'Mach-O executable does not contain __BUN,__bun')
  return { parserId: 'bun-standalone-macho64-layout-v1', container, regions, bun: parseBunGraph(bytes, bunRegion.offset, bunRegion.size) }
}

function detectContainer(bytes: Uint8Array): BunExecutableContainer {
  if (bytes.byteLength >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) return 'pe64'
  if (bytes.byteLength >= 6 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46 && bytes[4] === 2 && bytes[5] === 1) return 'elf64'
  if (bytes.byteLength >= 4 && readU32(bytes, 0) === 0xfeedfacf) return 'macho64'
  throw new Error('Unsupported executable container; expected PE64, little-endian ELF64, or little-endian Mach-O 64')
}

function parsePeRegions(bytes: Uint8Array, fileSize: number, requireContents: boolean): StructuralRegion[] {
  const peOffset = readU32(bytes, 0x3c)
  requireRange(bytes, peOffset, 24, 'PE header')
  if (readU32(bytes, peOffset) !== 0x4550) throw new Error('Invalid PE signature')
  const sectionCount = readU16(bytes, peOffset + 6)
  const optionalSize = readU16(bytes, peOffset + 20)
  const optionalOffset = peOffset + 24
  requireRange(bytes, optionalOffset, optionalSize, 'PE optional header')
  if (readU16(bytes, optionalOffset) !== 0x20b) throw new Error('Only PE32+ is supported')
  const tableOffset = optionalOffset + optionalSize
  requireRange(bytes, tableOffset, sectionCount * 40, 'PE section table')
  const regions: StructuralRegion[] = []
  for (let index = 0; index < sectionCount; index++) {
    const header = tableOffset + index * 40
    const name = readFixedString(bytes, header, 8)
    const size = readU32(bytes, header + 16)
    const offset = readU32(bytes, header + 20)
    if (!size) continue
    requireFileRange(fileSize, offset, size, `PE section ${name || index}`)
    if (requireContents) requireRange(bytes, offset, size, `PE section ${name || index}`)
    const kind = sectionKind('pe64', name)
    regions.push({ kind, name, offset, size, reuseClass: `pe:${index}:${name}` })
  }
  return regions.sort((left, right) => left.offset - right.offset)
}

function peHeadersEnd(bytes: Uint8Array): number {
  const peOffset = readU32(bytes, 0x3c)
  requireRange(bytes, peOffset, 24, 'PE header')
  return peOffset + 24 + readU16(bytes, peOffset + 20) + readU16(bytes, peOffset + 6) * 40
}

function elfSectionTableLocation(bytes: Uint8Array): ElfSectionTable {
  requireRange(bytes, 0, 64, 'ELF header')
  if (bytes[4] !== 2 || bytes[5] !== 1) throw new Error('Only little-endian ELF64 is supported')
  const offset = readU64(bytes, 0x28)
  const entrySize = readU16(bytes, 0x3a)
  const count = readU16(bytes, 0x3c)
  const stringTableIndex = readU16(bytes, 0x3e)
  if (entrySize < 64 || !count || stringTableIndex >= count) throw new Error('Invalid ELF section table')
  return { offset, size: entrySize * count, entrySize, count, stringTableIndex }
}

function parseElfRegions(
  table: Uint8Array,
  strings: Uint8Array,
  location: ElfSectionTable,
  fileSize: number,
  requireContents: boolean,
): StructuralRegion[] {
  requireRange(table, 0, location.size, 'ELF section table')
  const regions: StructuralRegion[] = []
  for (let index = 0; index < location.count; index++) {
    const header = index * location.entrySize
    const name = readNullTerminatedString(strings, readU32(table, header))
    const type = readU32(table, header + 4)
    const offset = readU64(table, header + 24)
    const size = readU64(table, header + 32)
    if (!size || type === 8) continue
    requireFileRange(fileSize, offset, size, `ELF section ${name || index}`)
    const kind = sectionKind('elf64', name)
    regions.push({ kind, name, offset, size, reuseClass: `elf:${index}:${name}` })
  }
  void requireContents
  return regions.sort((left, right) => left.offset - right.offset)
}

function parseMachoRegions(bytes: Uint8Array, fileSize: number, requireContents: boolean): StructuralRegion[] {
  requireRange(bytes, 0, 32, 'Mach-O header')
  const commandCount = readU32(bytes, 16)
  const commandBytes = readU32(bytes, 20)
  requireRange(bytes, 32, commandBytes, 'Mach-O load commands')
  const regions: StructuralRegion[] = []
  let commandOffset = 32
  let sectionIndex = 0
  for (let commandIndex = 0; commandIndex < commandCount; commandIndex++) {
    const command = readU32(bytes, commandOffset)
    const commandSize = readU32(bytes, commandOffset + 4)
    if (commandSize < 8 || commandOffset + commandSize > 32 + commandBytes) throw new Error('Invalid Mach-O load command')
    if (command === 0x19) {
      const sectionCount = readU32(bytes, commandOffset + 64)
      if (72 + sectionCount * 80 > commandSize) throw new Error('Invalid Mach-O section table')
      for (let localIndex = 0; localIndex < sectionCount; localIndex++, sectionIndex++) {
        const header = commandOffset + 72 + localIndex * 80
        const name = readFixedString(bytes, header, 16)
        const segment = readFixedString(bytes, header + 16, 16)
        const size = readU64(bytes, header + 40)
        const offset = readU32(bytes, header + 48)
        const sectionType = readU32(bytes, header + 64) & 0xff
        if (!size || !offset || [1, 0x0c, 0x12].includes(sectionType)) continue
        const fullName = `${segment},${name}`
        requireFileRange(fileSize, offset, size, `Mach-O section ${fullName}`)
        if (requireContents) requireRange(bytes, offset, size, `Mach-O section ${fullName}`)
        const kind = sectionKind('macho64', fullName)
        regions.push({ kind, name: fullName, offset, size, reuseClass: `macho:${sectionIndex}:${fullName}` })
      }
    }
    commandOffset += commandSize
  }
  return regions.sort((left, right) => left.offset - right.offset)
}

function sectionKind(container: BunExecutableContainer, name: string): StructuralRegionKind {
  if ((container === 'pe64' || container === 'elf64') && name === '.bun') return 'bun'
  if (container === 'macho64' && name === '__BUN,__bun') return 'bun'
  if (container === 'pe64' && name === '.rsrc') return 'platform'
  return 'runtime'
}

function requireBunRegion(regions: StructuralRegion[], message: string): StructuralRegion {
  const region = regions.find((candidate) => candidate.kind === 'bun')
  if (!region) throw new Error(message)
  return region
}

function parseBunGraph(bytes: Uint8Array, sectionOffset: number, sectionSize: number): BunGraphInspection {
  const graphSize = readU64(bytes, sectionOffset)
  const graphOffset = sectionOffset + 8
  if (graphSize < OFFSETS_SIZE + BUN_TRAILER.byteLength || graphOffset + graphSize > sectionOffset + sectionSize) throw new Error('Invalid Bun graph length')
  const trailerOffset = graphOffset + graphSize - BUN_TRAILER.byteLength
  if (!equalBytes(bytes.subarray(trailerOffset, trailerOffset + BUN_TRAILER.byteLength), BUN_TRAILER)) throw new Error('Invalid Bun graph trailer')
  const offsetsOffset = trailerOffset - OFFSETS_SIZE
  const byteCount = readU64(bytes, offsetsOffset)
  const modulesOffset = readU32(bytes, offsetsOffset + 8)
  const modulesSize = readU32(bytes, offsetsOffset + 12)
  const entryPoint = readU32(bytes, offsetsOffset + 16)
  if (byteCount + OFFSETS_SIZE + BUN_TRAILER.byteLength !== graphSize || !modulesSize || modulesSize % MODULE_RECORD_SIZE !== 0 || modulesOffset + modulesSize > byteCount) {
    throw new Error('Invalid Bun graph offsets')
  }
  const moduleCount = modulesSize / MODULE_RECORD_SIZE
  if (entryPoint >= moduleCount) throw new Error('Invalid Bun graph entry point')
  const modules: BunModuleInspection[] = []
  for (let index = 0; index < moduleCount; index++) {
    const record = graphOffset + modulesOffset + index * MODULE_RECORD_SIZE
    const nameOffset = readU32(bytes, record)
    const nameSize = readU32(bytes, record + 4)
    const contentsSize = readU32(bytes, record + 12)
    const sourcemapSize = readU32(bytes, record + 20)
    const bytecodeSize = readU32(bytes, record + 28)
    if (nameOffset + nameSize > byteCount) throw new Error(`Bun module ${index} name is out of bounds`)
    modules.push({ index, name: textDecoder.decode(bytes.subarray(graphOffset + nameOffset, graphOffset + nameOffset + nameSize)), contentsSize, sourcemapSize, bytecodeSize })
  }
  return { sectionOffset, sectionSize, graphSize, moduleCount, modules }
}

async function fetchRangeBytes(
  url: string,
  start: number,
  end: number,
  total: number | undefined,
  headersInit: Record<string, string> | undefined,
  ifRange: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ bytes: Uint8Array; total: number }> {
  const response = await fetchExactRange(url, start, end, total, headersInit, ifRange, signal)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength !== end - start + 1) throw new Error(`Range ${start}-${end} length mismatch`)
  return { bytes, total: parseContentRange(response.headers.get('content-range')).total }
}

async function fetchExactRange(
  url: string,
  start: number,
  end: number,
  total: number | undefined,
  headersInit: Record<string, string> | undefined,
  ifRange: string | undefined,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const headers = new Headers(headersInit)
  headers.set('range', `bytes=${start}-${end}`)
  headers.set('accept-encoding', 'identity')
  if (ifRange) headers.set('if-range', ifRange)
  const response = await fetch(url, { headers, signal })
  if (response.status === 200) throw new StructuralRangeUnsupportedError(`Update server ignored Range for ${start}-${end}`)
  if (response.status !== 206 || !response.body) throw new Error(`Update range request failed (${response.status} ${response.statusText}): ${start}-${end}`)
  const parsed = parseContentRange(response.headers.get('content-range'))
  if (parsed.start !== start || parsed.end !== end || (total !== undefined && parsed.total !== total)) {
    throw new Error(`Content-Range mismatch: expected bytes ${start}-${end}/${total ?? '*'}, received ${response.headers.get('content-range')}`)
  }
  return response
}

function parseContentRange(value: string | null): { start: number; end: number; total: number } {
  const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+)$/i)
  if (!match) throw new Error(`Invalid Content-Range header: ${value ?? '<missing>'}`)
  return { start: Number.parseInt(match[1]!, 10), end: Number.parseInt(match[2]!, 10), total: Number.parseInt(match[3]!, 10) }
}

async function writeAll(file: Awaited<ReturnType<typeof open>>, bytes: Uint8Array, position: number): Promise<void> {
  let written = 0
  while (written < bytes.byteLength) {
    const result = await file.write(bytes, written, bytes.byteLength - written, position + written)
    if (result.bytesWritten <= 0) throw new Error(`Failed to write reconstructed executable at ${position + written}`)
    written += result.bytesWritten
  }
}

async function sha256File(path: string): Promise<string> {
  const file = Bun.file(path)
  const hasher = new Bun.CryptoHasher('sha256')
  const chunkSize = 16 * 1024 * 1024
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    hasher.update(await file.slice(offset, Math.min(file.size, offset + chunkSize)).arrayBuffer())
  }
  return hasher.digest('hex')
}

function regionMatchKey(region: StructuralRegion): string {
  return `${region.reuseClass}:${region.size}`
}

function sha256(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(bytes)
  return hasher.digest('hex')
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
}

function requireFileRange(fileSize: number, offset: number, size: number, label: string): void {
  if (!Number.isSafeInteger(fileSize) || !Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > fileSize) {
    throw new Error(`${label} is out of bounds`)
  }
}

function requireRange(bytes: Uint8Array, offset: number, size: number, label: string): void {
  requireFileRange(bytes.byteLength, offset, size, label)
}

function readU16(bytes: Uint8Array, offset: number): number {
  requireRange(bytes, offset, 2, 'u16')
  return bytes[offset]! | bytes[offset + 1]! << 8
}

function readU32(bytes: Uint8Array, offset: number): number {
  requireRange(bytes, offset, 4, 'u32')
  return (bytes[offset]! | bytes[offset + 1]! << 8 | bytes[offset + 2]! << 16 | bytes[offset + 3]! << 24) >>> 0
}

function readU64(bytes: Uint8Array, offset: number): number {
  const value = readU32(bytes, offset + 4) * 0x1_0000_0000 + readU32(bytes, offset)
  if (!Number.isSafeInteger(value)) throw new Error('64-bit offset exceeds JavaScript safe integer range')
  return value
}

function readFixedString(bytes: Uint8Array, offset: number, size: number): string {
  requireRange(bytes, offset, size, 'fixed string')
  let end = offset
  while (end < offset + size && bytes[end] !== 0) end++
  return textDecoder.decode(bytes.subarray(offset, end))
}

function readNullTerminatedString(bytes: Uint8Array, offset: number): string {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.byteLength) throw new Error('String offset is out of bounds')
  let end = offset
  while (end < bytes.byteLength && bytes[end] !== 0) end++
  if (end === bytes.byteLength) throw new Error('String is not null terminated')
  return textDecoder.decode(bytes.subarray(offset, end))
}
