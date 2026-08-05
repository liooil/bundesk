import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export function validateAppId(appId: string): string {
  const normalized = appId.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) {
    throw new Error('appId must be 1-128 characters using letters, numbers, dot, underscore, or hyphen')
  }
  return normalized
}

export function getAppDataDirectory(appId: string): string {
  const safeAppId = validateAppId(appId)
  if (process.platform === 'win32') {
    return resolve(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), safeAppId)
  }
  if (process.platform === 'darwin') {
    return resolve(join(homedir(), 'Library', 'Application Support'), safeAppId)
  }
  return resolve(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), safeAppId)
}
