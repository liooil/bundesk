/**
 * Termux detection relies on the environment variables Termux sets for every
 * process it spawns (`PREFIX` points inside the Termux data directory). Bun
 * inside Termux reports `linux` (glibc proot environments) or `android`
 * (native builds), so the environment is the only reliable signal.
 */
export function isTermux(): boolean {
  const prefix = process.env.PREFIX
  return Boolean(prefix && prefix.includes('com.termux'))
}
