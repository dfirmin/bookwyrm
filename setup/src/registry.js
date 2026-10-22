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

// What a registry file may be called, in the order they're tried. Archivist names it targets.yaml;
// company forks often use .yml.
export const REGISTRY_FILES = ['targets.yaml', 'targets.yml'];

/**
 * Where to read the registry, from:
 *   "owner/repo"                  targets.yaml or targets.yml at the root of main
 *   "owner/repo@ref"              …of that branch or tag
 *   "owner/repo:path/targets.yml" a file elsewhere in the repo (with or without @ref)
 *   "https://…"                   any URL that serves the file
 * → { label, repo?, ref?, paths?, url? }.
 */
export function registrySource(spec) {
  const s = String(spec || DEFAULT_REGISTRY).trim();
  const link = githubLink(s);
  if (link) return registrySource(link);
  if (/^https?:\/\//.test(s)) return { label: s, url: s };
  const m = /^([\w.-]+\/[\w.-]+)(?:@([\w./-]+?))?(?::([\w./-]+\.ya?ml))?$/.exec(s);
  if (!m) {
    throw new RegistryError(`The registry should be owner/repo (optionally @branch, and :path/to/targets.yml for a file outside the root) or a URL, got "${s}".`);
  }
  const [, repo, ref = 'main', path] = m;
  const paths = path ? [path.replace(/^\/+/, '')] : REGISTRY_FILES;
  const label = `${repo}${ref === 'main' ? '' : `@${ref}`}${path ? `:${paths[0]}` : ''}`;
  return { label, repo, ref, paths, url: `https://raw.githubusercontent.com/${repo}/${ref}/${paths[0]}` };
}

/**
 * A github.com link someone copied from the browser → the owner/repo[@ref][:path] form, or null.
 *   https://github.com/acme/archivist(.git)                       → acme/archivist
 *   https://github.com/acme/archivist/tree/dev                    → acme/archivist@dev
 *   https://github.com/acme/archivist/blob/main/targets.yml       → acme/archivist:targets.yml
 *   https://github.com/acme/archivist/blob/dev/config/targets.yml → acme/archivist@dev:config/targets.yml
 *   https://raw.githubusercontent.com/acme/archivist/main/targets.yml → acme/archivist:targets.yml
 * (A branch with "/" in its name can't be told apart from the path in a link; use the
 * owner/repo@branch:path form for those.)
 */
export function githubLink(spec) {
  let u;
  try { u = new URL(spec); } catch { return null; }
  const parts = decodeURIComponent(u.pathname).replace(/\.git$/, '').split('/').filter(Boolean);
  let repo;
  let ref;
  let file;
  if (u.hostname === 'github.com' || u.hostname === 'www.github.com') {
    if (parts.length < 2) return null;
    repo = `${parts[0]}/${parts[1]}`;
    if (parts.length === 2) return repo;
    if (!['blob', 'tree', 'raw'].includes(parts[2]) || parts.length < 4) return null;
    ref = parts[3];
    file = parts.slice(4).join('/');
  } else if (u.hostname === 'raw.githubusercontent.com') {
    if (parts.length < 4) return null;
    repo = `${parts[0]}/${parts[1]}`;
    ref = parts[2];
    file = parts.slice(3).join('/');
  } else {
    return null;
  }
  if (file && !/\.ya?ml$/.test(file)) file = '';        // a folder: look for the usual names in it?
  const at = ref && ref !== 'main' ? `@${ref}` : '';
  return `${repo}${at}${file ? `:${file}` : ''}`;
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
 * Read the registry. A public one comes straight from raw.githubusercontent.com; a private one (a
 * company's own Archivist, say) through the GitHub API with the token, which then needs read access
 * to that repo too. Each candidate file name is tried in turn (targets.yaml, then targets.yml).
 */
export async function loadRegistry(spec, token) {
  const src = registrySource(spec);
  const api = (path) => fetchText(`https://api.github.com/repos/${src.repo}/contents/${path}?ref=${encodeURIComponent(src.ref)}`, {
    Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': '2022-11-28',
  });
  let r;
  let found = null;
  try {
    if (src.paths) {
      for (const path of src.paths) {
        r = await fetchText(`https://raw.githubusercontent.com/${src.repo}/${src.ref}/${path}`);
        if (r.status === 404 && token) r = await api(path);
        if (r.status !== 404) { found = path; break; }
      }
    } else {
      r = await fetchText(src.url);
    }
  } catch (err) {
    throw new RegistryError(`Couldn't reach the Archivist registry (${src.label}): ${err.cause?.code || err.message}.`);
  }
  if (r.status === 404) {
    const names = (src.paths || ['the file']).join(' or ');
    throw new RegistryError(src.repo
      ? `Couldn't find ${names} in ${src.repo}${src.ref === 'main' ? '' : ` (${src.ref})`}. If that repo is private, your GitHub token needs read access to it as well as to the knowledge repo (Contents: read).`
      : `There's no registry at ${src.label}.`);
  }
  if (r.status === 401 || r.status === 403) {
    throw new RegistryError(`GitHub wouldn't let your token read the registry in ${src.repo || src.label} (status ${r.status}). Give the token Contents: read on that repo.`);
  }
  if (r.status !== 200) throw new RegistryError(`The Archivist registry (${src.label}) answered with status ${r.status}.`);
  if (/^\s*<(!doctype|html)/i.test(r.text)) {
    throw new RegistryError(`${src.label} is a web page, not the registry file. Give the registry as owner/repo (for example your-org/archivist), with @branch or :path/to/targets.yml if needed.`);
  }
  const label = src.paths && !src.label.includes(':') && found !== REGISTRY_FILES[0] ? `${src.label}:${found}` : src.label;
  return { source: label, ...parseRegistry(r.text) };
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
      message: `${repo} isn't in the Archivist registry (${reg.source}). Bookwyrm only looks after repos Archivist runs on; to add one, open a pull request adding it to the registry's targets file.`,
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
