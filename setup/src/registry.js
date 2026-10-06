// Which knowledge repos Bookwyrm may look after: the ones Archivist runs on.
//
// Archivist's target registry (targets.yaml in the Archivist repo) lists every onboarded knowledge
// repo. Bookwyrm only accepts an *active* target from it, and double-checks the repo itself:
// its contracts/target.yaml must carry the same slug (that file is what Archivist scaffolds into
// every target). This is a guardrail against mistakes, not a security boundary: the GitHub token's
// scope is what actually limits what Bookwyrm can touch.
//
// The rules mirror archivist/src/archivist/targets.py so the two never disagree about what a
// valid target is.
import YAML from 'yaml';

export const DEFAULT_REGISTRY = 'dfirmin/archivist';
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GITHUB_HOSTS = new Set(['github.com', 'github.example.com']);

export class RegistryError extends Error {}

/** "owner/repo", "owner/repo@ref" or a full https URL to a targets.yaml → where to read it. */
export function registrySource(spec) {
  const s = String(spec || DEFAULT_REGISTRY).trim();
  if (/^https?:\/\//.test(s)) return { label: s, url: s };
  const m = /^([\w.-]+\/[\w.-]+)(?:@([\w./-]+))?$/.exec(s);
  if (!m) throw new RegistryError(`The registry should be owner/repo (optionally @branch) or a URL, got "${s}".`);
  const [, repo, ref = 'main'] = m;
  return { label: ref === 'main' ? repo : `${repo}@${ref}`, repo, ref, url: `https://raw.githubusercontent.com/${repo}/${ref}/targets.yaml` };
}

/** "https://github.com/o/r(.git)" → "o/r", or null if it isn't an https GitHub repo URL. */
export function githubSlug(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.replace(/\.git$/, '').replace(/^\/+|\/+$/g, '').split('/');
    if (u.protocol !== 'https:' || !GITHUB_HOSTS.has(u.hostname) || parts.length !== 2) return null;
    return parts.join('/');
  } catch {
    return null;
  }
}

/** Parse targets.yaml text the way Archivist does; bad entries are reported, not fatal. */
export function parseRegistry(text) {
  let data;
  try {
    data = YAML.parse(text);
  } catch (err) {
    throw new RegistryError(`The registry isn't valid YAML (${err.message.split('\n')[0]}).`);
  }
  if (!data || !Array.isArray(data.targets) || !data.targets.length) {
    throw new RegistryError('The registry has no targets list.');
  }
  const targets = [];
  const problems = [];
  const seen = new Set();
  data.targets.forEach((raw, i) => {
    const where = `targets[${i}]`;
    if (!raw || typeof raw !== 'object') { problems.push(`${where} isn't a mapping`); return; }
    const text = (k) => (typeof raw[k] === 'string' && raw[k].trim() ? raw[k].trim() : null);
    const slug = text('slug');
    if (!slug || !SLUG.test(slug)) { problems.push(`${where}: missing or invalid slug`); return; }
    if (seen.has(slug)) { problems.push(`duplicate slug ${slug}`); return; }
    seen.add(slug);
    const repo = githubSlug(text('target_repo') || '');
    const status = text('status');
    if (!repo || !text('name') || !['active', 'inactive'].includes(status)) {
      problems.push(`${slug}: needs name, an https GitHub target_repo and status active or inactive`);
      return;
    }
    targets.push({
      slug, repo, name: text('name'), description: text('description') || '',
      type: text('type') || '', status, active: status === 'active',
    });
  });
  return { targets, problems };
}

async function fetchText(url, headers = {}, timeoutMs = 15000) {
  const res = await fetch(url, { headers: { 'User-Agent': 'bookwyrm-setup', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, text: await res.text() };
}

/**
 * Read the registry. Public registries come straight from raw.githubusercontent.com; a private one
 * is read through the GitHub API with the token (which then needs read access to it).
 */
export async function loadRegistry(spec, token) {
  const src = registrySource(spec);
  let r;
  try {
    r = await fetchText(src.url);
    if (r.status === 404 && src.repo && token) {
      r = await fetchText(`https://api.github.com/repos/${src.repo}/contents/targets.yaml?ref=${encodeURIComponent(src.ref)}`, {
        Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': '2022-11-28',
      });
    }
  } catch (err) {
    throw new RegistryError(`Couldn't reach the Archivist registry (${src.label}): ${err.cause?.code || err.message}.`);
  }
  if (r.status === 404) throw new RegistryError(`There's no targets.yaml in ${src.label}, or it's private and your token can't read it.`);
  if (r.status !== 200) throw new RegistryError(`The Archivist registry (${src.label}) answered with status ${r.status}.`);
  return { source: src.label, ...parseRegistry(r.text) };
}

const gh = (token) => ({
  Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'bookwyrm-setup',
});

/** What the token can do in a repo: write, read or none (unknown when GitHub can't be asked). */
export async function repoAccess(repo, token) {
  if (!token) return 'unknown';
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}`, { headers: gh(token), signal: AbortSignal.timeout(15000) });
    if (res.status === 404 || res.status === 403 || res.status === 401) return 'none';
    if (res.status !== 200) return 'unknown';
    const body = await res.json();
    return body.permissions && body.permissions.push === false ? 'read' : 'write';
  } catch {
    return 'unknown';
  }
}

/** Does the repo carry Archivist's marker, contracts/target.yaml, with this slug? */
export async function checkMarker(repo, slug, token) {
  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${repo}/contents/contracts/target.yaml`, {
      headers: { ...gh(token), Accept: 'application/vnd.github.raw+json' }, signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    return { ok: null, message: `Couldn't read ${repo} to check it (${err.cause?.code || err.message}).` };
  }
  if (res.status === 404) return { ok: false, message: `${repo} has no contracts/target.yaml, so Archivist hasn't set it up as a knowledge repo.` };
  if (res.status !== 200) return { ok: null, message: `GitHub answered ${res.status} when I checked ${repo}.` };
  let doc;
  try {
    doc = YAML.parse(await res.text());
  } catch {
    return { ok: false, message: `${repo}'s contracts/target.yaml isn't valid YAML.` };
  }
  if (!doc || doc.slug !== slug) {
    return { ok: false, message: `${repo}'s contracts/target.yaml names the target "${doc?.slug ?? '(none)'}", but the registry lists it as "${slug}".` };
  }
  return { ok: true, message: `${repo} is the Archivist target "${slug}"${doc.engine ? `, on engine ${String(doc.engine).slice(0, 7)}` : ''}.` };
}

/**
 * The picker's list: active targets (test targets only when asked, or when one is already chosen),
 * each with what the token can do there.
 */
export async function listTargets({ registry, token, current = '', showTest = false }) {
  const reg = await loadRegistry(registry, token);
  const shown = reg.targets.filter((t) => (t.active && (showTest || t.type !== 'test')) || t.repo === current);
  const access = await Promise.all(shown.map((t) => repoAccess(t.repo, token)));
  return {
    source: reg.source,
    problems: reg.problems,
    hiddenTest: reg.targets.filter((t) => t.active && t.type === 'test' && !shown.includes(t)).length,
    targets: shown.map((t, i) => ({ ...t, access: access[i] })),
  };
}

/**
 * May Bookwyrm look after `repo`? → { ok, message, target?, warn? }.
 * `keepIfUnreachable`: the repo is already the saved one, so a registry we can't reach right now
 * (offline, say) shouldn't stop setup; it's re-checked next time.
 */
export async function validateTarget(repo, { registry, token, keepIfUnreachable = false } = {}) {
  let reg;
  try {
    reg = await loadRegistry(registry, token);
  } catch (err) {
    if (keepIfUnreachable) return { ok: true, warn: `${err.message} Keeping ${repo}; it's checked again next time.` };
    return { ok: false, message: `${err.message} Bookwyrm only looks after repos in the registry, so it can't check ${repo} right now.` };
  }
  const target = reg.targets.find((t) => t.repo.toLowerCase() === String(repo).toLowerCase());
  if (!target) {
    return {
      ok: false,
      message: `${repo} isn't in the Archivist registry (${reg.source}). Bookwyrm only looks after repos Archivist runs on; to add one, open a pull request adding it to targets.yaml.`,
    };
  }
  if (!target.active) {
    return { ok: false, target, message: `${repo} is in the Archivist registry, but its status is "${target.status}". Ask the Archivist owners whether it's been retired.` };
  }
  if (!token) return { ok: true, target, warn: 'No GitHub token yet, so I couldn\'t check the repo itself.' };
  const access = await repoAccess(target.repo, token);
  if (access === 'none') {
    return { ok: false, target, message: `Your GitHub token can't reach ${target.repo}. Make a fine-grained token that includes it (Contents, Issues and Pull requests: read and write).` };
  }
  if (access === 'read') {
    return { ok: false, target, message: `Your GitHub token can read ${target.repo} but not write to it. Give it Contents, Issues and Pull requests: read and write.` };
  }
  const marker = await checkMarker(target.repo, target.slug, token);
  if (marker.ok === false) return { ok: false, target, message: marker.message };
  if (marker.ok === null) return { ok: true, target, warn: marker.message };
  return { ok: true, target, message: `${target.name}: ${marker.message}` };
}
