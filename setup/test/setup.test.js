// Unit tests for the wizard's non-UI parts: node --test setup/test/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Point HOME at a temp dir before the modules work out their paths.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-setup-test-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
delete process.env.HERMES_HOME;
delete process.env.BOOKWYRM_HOME;
delete process.env.BOOKWYRM_MODELS_DIR;

const sys = await import('../src/sys.js');
const steps = await import('../src/steps.js');
const state = await import('../src/state.js');

// LF here whatever the checkout used (git on Windows may give CRLF); the CRLF test adds its own.
const registry = await import('../src/registry.js');

// A pretend GitHub: the registry on raw.githubusercontent.com and a few repos on the API.
const REGISTRY_YAML = `targets:
  - { slug: o-n, name: O N, description: Test repo, target_repo: https://github.com/o/n, type: docs, status: active }
  - { slug: kb-test, name: KB Test, description: A test target, target_repo: https://github.com/o/kb-test, type: test, status: active }
  - { slug: old-kb, name: Old KB, description: Retired, target_repo: https://github.com/o/old-kb, type: docs, status: inactive }
  - { slug: ro-kb, name: Read-only KB, description: x, target_repo: https://github.com/o/ro-kb, type: docs, status: active }
  - { slug: bare, name: Bare, description: Never scaffolded, target_repo: https://github.com/o/bare, type: docs, status: active }
  - { slug: wrong-slug, name: Wrong, description: Marker disagrees, target_repo: https://github.com/o/wrong, type: docs, status: active }
  - { slug: hidden, name: Hidden, description: Token can't see it, target_repo: https://github.com/o/hidden, type: docs, status: active }
  - { name: no slug }
`;
const REPOS = {
  'o/n': { push: true, marker: 'slug: o-n\nengine: 9166d2a3\n' },
  'o/kb-test': { push: true, marker: 'slug: kb-test\n' },
  'o/old-kb': { push: true, marker: 'slug: old-kb\n' },
  'o/ro-kb': { push: false, marker: 'slug: ro-kb\n' },
  'o/bare': { push: true, marker: null },
  'o/wrong': { push: true, marker: 'slug: something-else\n' },
};
async function withFakeGitHub(fn, { registryDown = false } = {}) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const reply = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    if (u.startsWith('https://raw.githubusercontent.com/')) {
      if (registryDown) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
      return u.endsWith('/dfirmin/archivist/main/targets.yaml') ? reply(200, REGISTRY_YAML) : reply(404, '404: Not Found');
    }
    const m = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)(\/contents\/contracts\/target\.yaml)?$/.exec(u);
    if (m) {
      const repo = REPOS[m[1]];
      if (!repo) return reply(404, { message: 'Not Found' });
      if (!m[2]) return reply(200, { full_name: m[1], permissions: { push: repo.push } });
      return repo.marker ? reply(200, repo.marker) : reply(404, { message: 'Not Found' });
    }
    return real(url);
  };
  try { return await fn(); } finally { globalThis.fetch = real; }
}

const config = fs.readFileSync(path.join(sys.paths.repo, 'profile', 'config.yaml'), 'utf8').replace(/\r\n/g, '\n');

test('paths live under the (temp) home', () => {
  assert.equal(sys.paths.bookwyrm, path.join(home, '.bookwyrm'));
  // Hermes' own default: %LOCALAPPDATA%\hermes on Windows, ~/.hermes elsewhere.
  assert.equal(sys.paths.hermesHome, process.platform === 'win32' ? path.join(home, 'AppData', 'Local', 'hermes') : path.join(home, '.hermes'));
  assert.equal(sys.paths.settings, path.join(home, '.bookwyrm', 'settings.json'));
});

test('profile config: placeholders filled and Docker swapped for the binary', () => {
  const out = steps.renderProfileFile(config, { skillsDir: '/r/skills', repo: 'o/n', mcpBin: '/h/.bookwyrm/bin/github-mcp-server', isConfig: true });
  assert.ok(out.includes('    - "/r/skills"'));
  assert.ok(out.includes('    command: "/h/.bookwyrm/bin/github-mcp-server"\n    args: ["stdio"]\n    env:'));
  assert.ok(!out.includes('docker'));
  assert.ok(!out.includes('__BOOKWYRM_SKILLS__'));
});

test('profile config: Windows paths stay valid YAML (JSON-escaped) and CRLF is normalised', () => {
  const out = steps.renderProfileFile(config.replace(/\n/g, '\r\n'), {
    skillsDir: 'C:\\Users\\Dee Firmin\\bookwyrm\\skills', repo: 'o/n', mcpBin: 'C:\\Users\\Dee Firmin\\.bookwyrm\\bin\\github-mcp-server.exe', isConfig: true,
  });
  assert.ok(out.includes('"C:\\\\Users\\\\Dee Firmin\\\\bookwyrm\\\\skills"'));
  assert.ok(out.includes('command: "C:\\\\Users\\\\Dee Firmin\\\\.bookwyrm\\\\bin\\\\github-mcp-server.exe"'));
  assert.ok(!out.includes('\r'));
});

test('profile config: without a binary the Docker launch stays', () => {
  const out = steps.renderProfileFile(config, { skillsDir: '/r/skills', repo: 'o/n', mcpBin: '', isConfig: true });
  assert.ok(out.includes('command: "docker"'));
});

test('SOUL.md gets the repo', () => {
  const soul = fs.readFileSync(path.join(sys.paths.repo, 'profile', 'SOUL.md'), 'utf8');
  const out = steps.renderProfileFile(soul, { skillsDir: '/r', repo: 'dfirmin/kb', mcpBin: '/x', isConfig: false });
  assert.ok(out.includes('**dfirmin/kb**'));
});

test('env files: values set in place, other lines and comments kept, 0600', () => {
  const file = path.join(home, 'e', '.env');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# comment\nOTHER=1\nGITHUB_PERSONAL_ACCESS_TOKEN=old\n\nLAST=x');
  assert.equal(sys.setEnvValues(file, { GITHUB_PERSONAL_ACCESS_TOKEN: 'new', ANTHROPIC_API_KEY: 'k' }), true);
  assert.equal(fs.readFileSync(file, 'utf8'), '# comment\nOTHER=1\nGITHUB_PERSONAL_ACCESS_TOKEN=new\n\nLAST=x\nANTHROPIC_API_KEY=k\n');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // onlyIfMissing never overwrites
  assert.equal(sys.setEnvValues(file, { OTHER: '2', NEW: '3' }, { onlyIfMissing: true }), true);
  assert.match(fs.readFileSync(file, 'utf8'), /^OTHER=1$/m);
  assert.match(fs.readFileSync(file, 'utf8'), /^NEW=3$/m);
  assert.equal(sys.setEnvValues(file, { NEW: '3' }), false);
  assert.deepEqual(sys.readEnvFile(file).GITHUB_PERSONAL_ACCESS_TOKEN, 'new');
});

test('secrets are masked and redacted', () => {
  assert.equal(sys.mask('sk-ant-api03-abcdefghijklmnop'), '••••mnop');
  assert.equal(sys.mask('short'), '••••');
  sys.addSecret('my-very-secret-value');
  assert.equal(sys.redact('token my-very-secret-value here'), 'token •••• here');
  assert.equal(sys.redact('Bearer github_pat_ABCDEFGHIJ123 and sk-ant-api03-zzzzzzzzzz'), 'Bearer •••• and ••••');
});

test('run() captures output, exit codes and timeouts', async () => {
  const ok = await sys.run(process.execPath, ['-e', 'console.log("a\\nb"); console.error("c")']);
  assert.equal(ok.code, 0);
  assert.deepEqual(ok.lines.sort(), ['a', 'b', 'c']);
  const bad = await sys.run(process.execPath, ['-e', 'process.exit(3)']);
  assert.equal(bad.code, 3);
  const missing = await sys.run('definitely-not-a-command-bw', []);
  assert.notEqual(missing.code, 0);
  const slow = await sys.run(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 300 });
  assert.equal(slow.code, 124);
});

test('settings.json: merged, unknown keys kept, defaults fill gaps', () => {
  fs.mkdirSync(path.dirname(sys.paths.settings), { recursive: true });
  fs.writeFileSync(sys.paths.settings, JSON.stringify({ voice: 'bf_emma', calls_you: true, future_thing: [1, 2], name: 'Old' }));
  steps.writeSettings({ profile: 'bookwyrm', answers: { name: 'Dee Firmin', team: 'Data Engineering', repo: 'o/n' } });
  const s = JSON.parse(fs.readFileSync(sys.paths.settings, 'utf8'));
  assert.deepEqual(s, {
    name: 'Dee Firmin', team: 'Data Engineering', repo: 'o/n', voice: 'bf_emma', voice_speed: 1, calls_you: true,
    watch_minutes: 5, profile: 'bookwyrm', future_thing: [1, 2],
  });
  assert.deepEqual(Object.keys(s).slice(0, 8), ['name', 'team', 'repo', 'voice', 'voice_speed', 'calls_you', 'watch_minutes', 'profile']);
});

test('prefill: flags, then settings.json, then the old voice/.env', () => {
  fs.writeFileSync(sys.paths.settings, JSON.stringify({ name: 'From Settings', repo: 'a/b' }));
  assert.deepEqual(state.prefill({ team: 'Flag Team' }), {
    registry: 'dfirmin/archivist', savedRepo: 'a/b',
    name: 'From Settings', team: 'Flag Team', repo: 'a/b', provider: 'anthropic', gatewayUrl: '', gatewayModel: '',
  });
  // The gateway choice is remembered in settings.json and comes back next time.
  fs.writeFileSync(sys.paths.settings, JSON.stringify({ name: 'D', model: { provider: 'gateway', base_url: 'https://gw/v1', name: 'claude-sonnet' } }));
  const p = state.prefill({});
  assert.deepEqual([p.provider, p.gatewayUrl, p.gatewayModel], ['gateway', 'https://gw/v1', 'claude-sonnet']);
  assert.equal(state.prefill({ provider: 'anthropic' }).provider, 'anthropic');   // a flag wins
  fs.rmSync(sys.paths.settings);
  // The legacy file lives in the repo's voice/.env; only read it when present.
  const legacy = path.join(sys.paths.voice, '.env');
  if (!fs.existsSync(legacy)) {
    fs.writeFileSync(legacy, 'BOOKWYRM_CALLER=Dee Firmin, Data Engineering\nBOOKWYRM_REPO=dfirmin/kb\n');
    try {
      const p2 = state.prefill({});
      assert.deepEqual([p2.name, p2.team, p2.repo], ['Dee Firmin', 'Data Engineering', 'dfirmin/kb']);
    } finally {
      fs.rmSync(legacy);
    }
  }
});

test('arguments', () => {
  const o = state.parseArgs(['--yes', '--only', 'voice,models', '--skip=app', '--caller', 'Dee Firmin, Data Engineering', '--repo', 'o/n', '--dry-run']);
  assert.equal(o.yes, true);
  assert.deepEqual(o.only, ['voice', 'models']);
  assert.deepEqual(o.skip, ['app']);
  assert.equal(o.name, 'Dee Firmin');
  assert.equal(o.team, 'Data Engineering');
  assert.equal(o.dryRun, true);
  assert.deepEqual(state.selectedSteps(o), ['voice', 'models']);
  assert.throws(() => state.parseArgs(['--only', 'voice,nope']), /unknown step nope/);
  // PowerShell hands over an unquoted voice,models,app as three arguments.
  assert.deepEqual(state.parseArgs(['--only', 'voice', 'models', 'app', '--yes']).only, ['voice', 'models', 'app']);
  assert.throws(() => state.parseArgs(['--repo', 'not a repo']), /owner\/name/);
  assert.throws(() => state.parseArgs(['--name']), /needs a value/);
  assert.throws(() => state.parseArgs(['--frobnicate']), /unknown option/);
});

test('profile step on an existing profile: renders files, adds the template once, keeps other lines', async () => {
  const dir = sys.profileDir('bookwyrm');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.env'), '# Hermes seeded this\nANTHROPIC_API_KEY=existing-key-value\nOTHER=1\n');
  const profile = steps.STEPS.find((s) => s.id === 'profile');
  const ctx = { opts: {}, profile: 'bookwyrm', answers: { repo: 'o/n', githubToken: 'github_pat_testtesttest' } };
  const io = { log: () => {}, progress: () => {} };
  const res = await withFakeGitHub(() => profile.run(ctx, io));
  assert.equal(res.warn, undefined);
  const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  assert.equal(env.match(/^ANTHROPIC_API_KEY=/gm).length, 1);
  assert.match(env, /^ANTHROPIC_API_KEY=existing-key-value$/m);
  assert.match(env, /^GITHUB_PERSONAL_ACCESS_TOKEN=github_pat_testtesttest$/m);
  assert.match(env, /^OTHER=1$/m);
  assert.match(env, /^# Fine-grained GitHub token/m);
  assert.equal(ctx.gatewayRestart, true);
  const cfg = fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8');
  assert.ok(cfg.includes(JSON.stringify(path.join(sys.paths.repo, 'skills'))));
  assert.ok(cfg.includes('command: "docker"')); // no connector binary in this temp home
  assert.match(fs.readFileSync(path.join(dir, 'SOUL.md'), 'utf8'), /\*\*o\/n\*\*/);

  // Second run with nothing new: nothing changes.
  const ctx2 = { opts: {}, profile: 'bookwyrm', answers: { repo: 'o/n' } };
  assert.equal((await withFakeGitHub(() => profile.run(ctx2, io))).note, 'up to date');
  assert.equal(ctx2.gatewayRestart, undefined);
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), env);
});

test('gateway: profile model block replaced, everything else kept', () => {
  const model = { provider: 'gateway', gatewayUrl: 'https://litellm.corp.example/v1', gatewayModel: 'claude-sonnet' };
  const out = steps.renderProfileFile(config, { skillsDir: '/r/skills', repo: 'o/n', mcpBin: '', isConfig: true, model });
  assert.match(out, /^model:\n {2}# Your company's gateway[\s\S]*?provider: "custom"\n {2}default: "claude-sonnet"\n {2}base_url: "https:\/\/litellm\.corp\.example\/v1"\n {2}api_key_env: "LITELLM_API_KEY"\n\n# Only what/m);
  assert.ok(!out.includes('provider: "anthropic"'));
  assert.equal(out.split('\nmodel:').length, 2, 'exactly one model block');
  // Only the model block changed.
  const strip = (t) => t.replace(/^model:\n(?:(?:[ \t]+.*)?\n)*?(?=^\S)/m, '');
  assert.equal(strip(out), strip(steps.renderProfileFile(config, { skillsDir: '/r/skills', repo: 'o/n', mcpBin: '', isConfig: true })));
  // Anthropic (or nothing chosen): the template's own block stays.
  const direct = steps.renderProfileFile(config, { skillsDir: '/r', repo: 'o/n', mcpBin: '', isConfig: true, model: { provider: 'anthropic' } });
  assert.ok(direct.includes('provider: "anthropic"'));
  // YAML stays loadable by a strict reader: no tabs, and the URL is quoted.
  assert.ok(!/\t/.test(out));
});

test('gateway: flags', () => {
  const o = state.parseArgs(['--provider', 'litellm', '--gateway-url', 'https://gw.example/v1/', '--gateway-model', 'claude-sonnet']);
  assert.deepEqual([o.provider, o.gatewayUrl, o.gatewayModel], ['gateway', 'https://gw.example/v1', 'claude-sonnet']);
  assert.equal(state.parseArgs(['--gateway-url', 'https://gw.example/v1']).provider, 'gateway');   // implied
  assert.throws(() => state.parseArgs(['--provider', 'openai']), /anthropic or gateway/);
  assert.throws(() => state.parseArgs(['--gateway-url', 'gw.example']), /https:/);
  assert.equal(state.normalizeGatewayUrl('https://gw/v1/chat/completions'), 'https://gw/v1');
});

test('gateway check: key, model name, streaming and tool calls, with clear messages', async () => {
  const http = await import('node:http');
  // A pretend LiteLLM: models at /v1 only; model behaviour chosen by name.
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.headers.authorization !== 'Bearer good') { res.writeHead(401); res.end('{"error":{"message":"bad key"}}'); return; }
      if (req.url === '/v1/models') { res.writeHead(200); res.end(JSON.stringify({ data: [{ id: 'claude-sonnet' }, { id: 'no-tools' }, { id: 'no-stream' }] })); return; }
      if (req.url === '/v1/chat/completions') {
        const { model, stream, tools } = JSON.parse(body);
        assert.equal(stream, true);
        assert.equal(tools[0].function.name, 'ping');
        if (model === 'no-stream') { res.writeHead(200); res.end('{"choices":[]}'); return; }
        const delta = model === 'no-tools'
          ? { content: 'pong' }
          : { tool_calls: [{ index: 0, id: 't1', type: 'function', function: { name: 'ping', arguments: '' } }] };
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      res.writeHead(404); res.end('{"error":"not found"}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const root = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await state.checkGateway(root, 'good', 'claude-sonnet');            // no /v1 given: found anyway
    assert.equal(ok.ok, true, ok.message);
    assert.equal(ok.baseUrl, `${root}/v1`);
    assert.match((await state.checkGateway(`${root}/v1`, 'bad', 'claude-sonnet')).message, /didn't accept this key/);
    const wrong = await state.checkGateway(`${root}/v1`, 'good', 'claude-opus');
    assert.match(wrong.message, /no model called "claude-opus".*claude-sonnet/);
    assert.match((await state.checkGateway(`${root}/v1`, 'good', 'no-tools')).message, /didn't call a tool/);
    assert.match((await state.checkGateway(`${root}/v1`, 'good', 'no-stream')).message, /not as a stream/);
    assert.match((await state.checkGateway('http://127.0.0.1:9', 'good', 'x')).message, /Couldn't reach the gateway/);
  } finally {
    server.close();
  }
});

test('gateway: settings remember the choice; switching back to Anthropic is remembered too', () => {
  fs.writeFileSync(sys.paths.settings, JSON.stringify({ voice: 'bf_emma' }));
  steps.writeSettings({ profile: 'bookwyrm', answers: { name: 'D', provider: 'gateway', gatewayUrl: 'https://gw/v1', gatewayModel: 'claude-sonnet' } });
  let s = JSON.parse(fs.readFileSync(sys.paths.settings, 'utf8'));
  assert.deepEqual(s.model, { provider: 'gateway', base_url: 'https://gw/v1', name: 'claude-sonnet' });
  assert.equal(s.voice, 'bf_emma');
  steps.writeSettings({ profile: 'bookwyrm', answers: { provider: 'anthropic' } });
  s = JSON.parse(fs.readFileSync(sys.paths.settings, 'utf8'));
  assert.deepEqual(s.model, { provider: 'anthropic' });
});

test('registry: parsing follows Archivist\'s rules; bad entries are reported, not fatal', () => {
  const { targets, problems } = registry.parseRegistry(REGISTRY_YAML);
  assert.equal(targets.length, 7);
  assert.deepEqual(problems, ['targets[7]: missing or invalid slug']);
  assert.equal(targets.find((t) => t.slug === 'old-kb').active, false);
  assert.equal(registry.githubSlug('https://github.com/o/n.git'), 'o/n');
  assert.equal(registry.githubSlug('http://github.com/o/n'), null);
  assert.equal(registry.githubSlug('https://gitlab.com/o/n'), null);
  assert.deepEqual(registry.registrySource('acme/archivist@release').url, 'https://raw.githubusercontent.com/acme/archivist/release/targets.yaml');
  assert.throws(() => registry.registrySource('not a repo'), /owner\/repo/);
  assert.throws(() => registry.parseRegistry('targets: []'), /no targets/);
});

test('registry: only active, scaffolded targets the token can write to', () => withFakeGitHub(async () => {
  const token = 'github_pat_x';
  const v = (repo, o = {}) => registry.validateTarget(repo, { token, ...o });
  const ok = await v('o/n');
  assert.equal(ok.ok, true);
  assert.match(ok.message, /O N: o\/n is the Archivist target "o-n", on engine 9166d2a/);
  assert.equal((await v('O/N')).ok, true);                                  // GitHub names aren't case-sensitive
  assert.match((await v('someone/random')).message, /isn't in the Archivist registry \(dfirmin\/archivist\).*pull request/);
  assert.match((await v('o/old-kb')).message, /status is "inactive"/);
  assert.match((await v('o/hidden')).message, /token can't reach o\/hidden/);
  assert.match((await v('o/ro-kb')).message, /can read o\/ro-kb but not write/);
  assert.match((await v('o/bare')).message, /no contracts\/target\.yaml/);
  assert.match((await v('o/wrong')).message, /names the target "something-else", but the registry lists it as "wrong-slug"/);
}));

test('registry: unreachable registry blocks a new repo but keeps the saved one', async () => {
  await withFakeGitHub(async () => {
    const fresh = await registry.validateTarget('o/n', { token: 't' });
    assert.equal(fresh.ok, false);
    assert.match(fresh.message, /Couldn't reach the Archivist registry/);
    const kept = await registry.validateTarget('o/n', { token: 't', keepIfUnreachable: true });
    assert.equal(kept.ok, true);
    assert.match(kept.warn, /Keeping o\/n/);
  }, { registryDown: true });
});

test('registry: the picker lists active targets; test targets only on request or when already chosen', () => withFakeGitHub(async () => {
  const slugs = (l) => l.targets.map((t) => t.slug);
  const plain = await registry.listTargets({ token: 't' });
  assert.deepEqual(slugs(plain), ['o-n', 'ro-kb', 'bare', 'wrong-slug', 'hidden']);
  assert.equal(plain.hiddenTest, 1);
  assert.deepEqual(plain.targets.map((t) => t.access), ['write', 'read', 'write', 'write', 'none']);
  assert.ok(slugs(await registry.listTargets({ token: 't', showTest: true })).includes('kb-test'));
  assert.ok(slugs(await registry.listTargets({ token: 't', current: 'o/kb-test' })).includes('kb-test'));
  assert.ok(!slugs(await registry.listTargets({ token: 't', current: 'o/old-kb' })).includes('nope'));
}));

test('profile step refuses a repo Archivist doesn\'t run on, and writes nothing', () => withFakeGitHub(async () => {
  const dir = sys.profileDir('bookwyrm');
  const before = fs.readFileSync(path.join(dir, 'SOUL.md'), 'utf8');
  const profile = steps.STEPS.find((s) => s.id === 'profile');
  const ctx = { opts: {}, profile: 'bookwyrm', answers: { repo: 'someone/random', githubToken: 'github_pat_x' } };
  await assert.rejects(profile.run(ctx, { log: () => {}, progress: () => {} }), (err) => {
    assert.match(err.message, /isn't in the Archivist registry/);
    assert.match(err.hint, /Settings → Knowledge repo/);
    return true;
  });
  assert.equal(fs.readFileSync(path.join(dir, 'SOUL.md'), 'utf8'), before);
}));

test('natural voice: --voice-engine, and the step only reinstalls when something changed', () => {
  assert.equal(state.parseArgs(['--voice-engine', 'chatterbox-nano']).voiceEngine, 'chatterbox-nano');
  assert.equal(state.parseArgs(['--voice-engine=Kokoro']).voiceEngine, 'kokoro');
  assert.throws(() => state.parseArgs(['--voice-engine', 'elevenlabs']), /--voice-engine is one of auto, kokoro/);
  assert.ok(steps.STEP_IDS.indexOf('natural-voice') > steps.STEP_IDS.indexOf('models'));
  assert.ok(steps.STEP_IDS.indexOf('natural-voice') < steps.STEP_IDS.indexOf('settings'));

  const step = steps.STEPS.find((s) => s.id === 'natural-voice');
  const ctx = (voiceEngine) => ({ opts: { voiceEngine } });
  assert.equal(step.detect(ctx('kokoro')).done, true);         // asked for Standard: nothing to do
  assert.equal(step.detect(ctx()).done, false);                // never run
  const stamp = path.join(sys.paths.voice, '.venv', '.bookwyrm-natural-voice');
  const hadVenv = fs.existsSync(path.dirname(stamp));
  fs.mkdirSync(path.dirname(stamp), { recursive: true });
  const hash = sys.sha256(sys.readText(path.join(sys.paths.voice, 'pyproject.toml')));
  const model = path.join(sys.paths.models, 'chatterbox-nano', '.bookwyrm-complete');
  try {
    fs.writeFileSync(stamp, `${hash} chatterbox-nano\n`);
    assert.equal(step.detect(ctx()).done, false);              // stamped, but the model isn't there
    fs.mkdirSync(path.dirname(model), { recursive: true });
    fs.writeFileSync(model, 'x');
    assert.equal(step.detect(ctx()).done, true);
    assert.equal(step.detect(ctx('auto')).done, true);
    assert.equal(step.detect(ctx('chatterbox-turbo')).done, false);  // asked for a different one
    fs.writeFileSync(stamp, `old-hash chatterbox-nano\n`);
    assert.equal(step.detect(ctx()).done, false);              // pyproject changed: reinstall
  } finally {
    fs.rmSync(stamp, { force: true });
    if (!hadVenv) fs.rmSync(path.dirname(stamp), { recursive: true, force: true });
  }
});
