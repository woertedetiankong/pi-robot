import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, win32, posix, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export function candidates(platform, home, env) {
  const path = platform === 'win32' ? win32 : posix;
  const executable = platform === 'win32' ? 'herdr.exe' : 'herdr';
  return [...new Set([
    executable,
    ...(env.HERDR_INSTALL_DIR ? [path.join(env.HERDR_INSTALL_DIR, executable)] : []),
    ...(platform === 'win32'
      ? [path.join(home, '.herdr', 'packages', 'standalone', 'current', executable), path.join(home, '.local', 'bin', executable)]
      : [path.join(home, '.local', 'bin', executable)]),
  ])];
}

export function findHerdr({ platform, home, env, run }) {
  for (const command of candidates(platform, home, env)) {
    const result = run(command, ['--version'], { env, encoding: 'utf8', timeout: 10_000, windowsHide: true });
    if (!result.error && result.status === 0 && /^herdr\s+\d+\./im.test(result.stdout || '')) {
      return { command, version: result.stdout.trim() };
    }
  }
  return undefined;
}

export async function installHerdr(options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const run = options.run ?? spawnSync;
  const request = options.request ?? fetch;
  const log = options.log ?? console.log;
  if (/^(1|true|yes)$/i.test(env.PI_ROBOT_SKIP_HERDR || '')) {
    log('[pi-robot] Herdr installation skipped (PI_ROBOT_SKIP_HERDR).');
    return { status: 'skipped' };
  }
  const context = { platform, home, env, run };
  const existing = findHerdr(context);
  if (existing) {
    log(`[pi-robot] Using existing ${existing.version}: ${existing.command}`);
    return { status: 'existing', ...existing };
  }
  if (!['win32', 'darwin', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
    throw new Error(`Herdr automatic installation does not support ${platform}/${arch}. See https://herdr.dev/docs/install/`);
  }
  const windows = platform === 'win32';
  const url = `https://herdr.dev/install.${windows ? 'ps1' : 'sh'}`;
  log(`[pi-robot] Herdr not found. Downloading the official installer: ${url}`);
  const response = await request(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Herdr installer download failed: HTTP ${response.status}`);
  if (response.url && new URL(response.url).protocol !== 'https:') throw new Error('Herdr installer must use HTTPS.');
  const source = await response.text();
  if (!source.trim() || /^\s*<!doctype html|^\s*<html/i.test(source)) throw new Error('Herdr returned an invalid installer.');
  const temporaryRoot = resolve(tmpdir());
  const temporary = await mkdtemp(join(temporaryRoot, 'pi-robot-herdr-'));
  try {
    const script = join(temporary, windows ? 'install.ps1' : 'install.sh');
    await writeFile(script, source, { mode: 0o600 });
    const command = windows ? 'powershell.exe' : 'sh';
    const args = windows
      ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script]
      : [script];
    // Use argument arrays, never interpolate paths into shell code. The upstream
    // installer chooses the stable release and verifies its downloaded checksum.
    const result = run(command, args, { env, stdio: 'inherit', timeout: 600_000, windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Official Herdr installer exited with code ${result.status ?? result.signal}.`);
    const installed = findHerdr(context);
    if (!installed) throw new Error('Installer finished, but herdr --version could not be verified. Check PATH and retry.');
    log(`[pi-robot] Installed ${installed.version}: ${installed.command}`);
    log('[pi-robot] Open a new terminal, run herdr, then run pi inside a Herdr pane. Follow any PATH instructions printed above.');
    return { status: 'installed', ...installed };
  } finally {
    // Only the directory returned by mkdtemp is removed; no user install paths.
    if (dirname(resolve(temporary)) !== temporaryRoot) throw new Error('Unexpected temporary installer path.');
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await installHerdr(); }
  catch (error) {
    console.error(`[pi-robot] Herdr setup failed: ${error.message}`);
    console.error('[pi-robot] Retry: npm run setup:herdr in this package directory, or rerun pi install.');
    console.error('[pi-robot] To install only the pi plugins, set PI_ROBOT_SKIP_HERDR=1 before installing.');
    process.exitCode = 1;
  }
}
