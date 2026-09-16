import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { candidates, installHerdr } from '../scripts/install-herdr.mjs';

const base = { platform: 'linux', arch: 'x64', home: '/home/test user', env: {}, log() {} };
const missing = { status: null, error: new Error('ENOENT') };

test('existing Herdr is reused without downloading or upgrading', async () => {
  const result = await installHerdr({ ...base, run: () => ({ status: 0, stdout: 'herdr 0.9.0\n' }), request: () => assert.fail('download') });
  assert.equal(result.status, 'existing');
});

test('opt-out performs no probes, downloads or installation', async () => {
  assert.equal((await installHerdr({ ...base, env: { PI_ROBOT_SKIP_HERDR: '1' }, run: () => assert.fail('probe') })).status, 'skipped');
});

test('managed installation is detected even when PATH has not refreshed', async () => {
  const command = 'C:\\Users\\Test User\\.herdr\\packages\\standalone\\current\\herdr.exe';
  const result = await installHerdr({ ...base, platform: 'win32', home: 'C:\\Users\\Test User', run: c => c === command ? { status: 0, stdout: 'herdr 0.9.0' } : missing, request: () => assert.fail('download') });
  assert.equal(result.command, command);
});

for (const platform of ['win32', 'linux', 'darwin']) {
  test(`missing Herdr installs and verifies on ${platform} without shell interpolation`, async () => {
    let installed = false, script;
    const result = await installHerdr({ ...base, platform,
      request: async url => { assert.equal(url, `https://herdr.dev/install.${platform === 'win32' ? 'ps1' : 'sh'}`); return { ok: true, text: async () => '# official installer fixture' }; },
      run(command, args, options) {
        if (args[0] === '--version') return installed ? { status: 0, stdout: 'herdr 0.9.0' } : missing;
        assert.equal(command, platform === 'win32' ? 'powershell.exe' : 'sh');
        assert.equal(options.windowsHide, true);
        assert.equal(options.shell, undefined);
        script = args.at(-1);
        assert.equal(readFileSync(script, 'utf8'), '# official installer fixture');
        installed = true;
        return { status: 0 };
      },
    });
    assert.equal(result.status, 'installed');
    assert.equal(existsSync(script), false);
  });
}

test('download failure never runs installer', async () => {
  await assert.rejects(installHerdr({ ...base, run: (_c, args) => { assert.equal(args[0], '--version'); return missing; }, request: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
});

test('installer failure is reported and temporary script cleaned', async () => {
  let script;
  await assert.rejects(installHerdr({ ...base, request: async () => ({ ok: true, text: async () => '# fixture' }), run: (_c, args) => {
    if (args[0] === '--version') return missing;
    script = args.at(-1); return { status: 1 };
  } }), /code 1/);
  assert.equal(existsSync(script), false);
});

test('installer success without a usable executable is not reported as success', async () => {
  await assert.rejects(installHerdr({ ...base, request: async () => ({ ok: true, text: async () => '# fixture' }), run: (_c, args) => args[0] === '--version' ? missing : { status: 0 } }), /could not be verified/);
});

test('unsupported platforms fail before downloading; custom install path is checked', async () => {
  await assert.rejects(installHerdr({ ...base, platform: 'freebsd', run: () => missing, request: () => assert.fail('download') }), /does not support/);
  assert.ok(candidates('linux', '/home/test', { HERDR_INSTALL_DIR: '/opt/custom bin' }).includes('/opt/custom bin/herdr'));
});
