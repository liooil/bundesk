declare const __FIXTURE_VERSION__: string

if (Bun.argv.includes('--probe')) {
  console.log(`desktop-fixture ${__FIXTURE_VERSION__}`)
}
