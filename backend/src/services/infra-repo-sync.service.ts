import { AxiosInstance } from 'axios';
import { createHttpClient } from '../utils/http-client';
import config from '../config/config';
import logger from '../utils/logger';
import { BaseError, ExternalServiceError } from '../utils/errors';

/**
 * infra-repo-sync.service — mirrors approved Secret Ingestion key ADDITIONS into the
 * bachatt-app/infra-deployment repo as a GitHub pull request.
 *
 * WHY: a new key written to an AWS Secrets Manager secret is invisible to the running
 * pods until its NAME is registered in that repo's manifests — the AWS Secrets CSI driver
 * only syncs keys that are explicitly enumerated. This service opens a PR that adds the
 * key name wherever the secret is consumed, so the key actually reaches the workloads.
 *
 * MAPPING: there is NO folder/name convention between an AWS secret and a manifest. The
 * only reliable join is the exact `awsSecretName` (values chart) / `objectName` (raw
 * SecretProviderClass) string written inside each file. We scan every candidate manifest,
 * build a reverse index secretName -> consuming files, and edit each consumer.
 *
 * SCOPE: AUTO-DISCOVERY only ever surfaces Helm values files (values-*.yaml) — a
 * SecretProviderClass file is never suggested by the scan (product decision). A requester
 * can still manually add an SPC path (the "add a file the scan missed" edge case, e.g. a
 * service with only an SPC manifest) and it WILL be edited — `editSpc` adds a `jmesPath`
 * path/objectAlias pair under `parameters.objects` AND an `objectName/key` pair under
 * `secretObjects[].data`. So: never auto-chosen, but editable when manually chosen.
 *
 * PR LIFECYCLE mirrors the Hermes request: opened (draft) on submit, merged on approve,
 * closed on reject, left open with a note on a retryable APPLY_FAILED.
 *
 * Edits are surgical LINE INSERTIONS (comments/formatting preserved) — never a YAML
 * parse-and-redump, which would reflow the whole file.
 */

export interface InfraSyncResult {
  state: 'OPEN' | 'MERGED' | 'CLOSED' | 'SKIPPED' | 'FAILED';
  prNumber?: number | null;
  prUrl?: string | null;
  prNodeId?: string | null;
  branch?: string | null;
  filesChanged?: string[];
  keysAdded?: string[];
  note?: string | null;
}

type Mechanism = 'helm-values' | 'spc';
interface Consumer {
  path: string;
  mech: Mechanism;
}

/**
 * A snapshot of the base branch's manifests: which secrets each file consumes, plus the file
 * bytes the scan already had to read to work that out. Keeping the content is the whole point —
 * building the index reads every values-*.yaml in the repo, and read-only consumers (drift) then
 * need exactly those same bytes. Discarding them meant re-fetching each file once per secret.
 *
 * `validatedAt` gates how often we spend 2 API calls asking "has base moved?" — see getIndex.
 */
interface InfraIndex {
  treeSha: string;
  index: Map<string, Consumer[]>;
  files: Map<string, { sha: string; content: string }>;
  validatedAt: number;
}

/**
 * How long an index may be trusted without re-checking base's tree SHA. A drift scan runs in
 * seconds, so one validation covers the whole scan instead of two calls per secret.
 *
 * Reporting/preview paths (resolveDrift, resolveTargetsLive) accept a snapshot this old. Paths
 * that BUILD a PR pass `{ fresh: true }` (see targetConsumers) so the file list they register
 * keys into is never stale. File CONTENT for a write is always read live regardless — a stale
 * blob SHA there is a 409, not a slightly-late report.
 */
const INDEX_TTL_MS = 30_000;

/**
 * Outcome of attempting to register keys in one manifest file. `up-to-date`/`not-referenced`
 * are genuine "nothing to do" cases; `unmatched` means the secret WAS referenced but its
 * expected key-list structure (items:/jmesPath:/secretObjects) could not be located — the
 * edit was skipped because the scan didn't understand the file's shape, NOT because the keys
 * are already there. Callers must not conflate `unmatched` with the other two: silently
 * treating it as "nothing to do" is exactly the bug this type exists to prevent (a key that
 * genuinely needs registering could otherwise disappear with no signal anywhere).
 */
export type ManifestEditResult =
  | { status: 'edited'; content: string; added: string[] }
  | { status: 'up-to-date' }
  | { status: 'not-referenced' }
  | { status: 'unmatched' };

// ---------------------------------------------------------------------------
// Pure YAML editors (exported for unit tests — no I/O, deterministic)
// ---------------------------------------------------------------------------

const stripQuotes = (s: string): string => s.trim().replace(/^["']|["']$/g, '');
const indentOf = (line: string): number => (line.match(/^(\s*)/) as RegExpMatchArray)[1].length;
const detectEol = (content: string): string => (content.includes('\r\n') ? '\r\n' : '\n');

/**
 * Runs `fn` over `items` with at most `limit` in flight at once — faster than a fully
 * sequential for-loop (each GitHub GET is independent) while staying well clear of GitHub's
 * secondary rate limits, which a blind unbounded Promise.all over a large candidate set could
 * trip. Order of the returned array matches `items`.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Best-effort environment label for a manifest path (for display + approver context). */
export function envOf(path: string): string {
  const m = path.match(/(^|\/)(prod|qa2|qa|uat|local|dev|staging)(\/|$)/i);
  if (m) {
    return m[2].toLowerCase();
  }
  const v = path.match(/values-(prod|qa2|qa|uat|local|dev|staging)/i);
  if (v) {
    return v[1].toLowerCase();
  }
  return 'root';
}

/** A manifest the auto-scan found for a secret, with the keys a request would add to it. */
export interface ResolvedTarget {
  path: string;
  env: string;
  format: Mechanism;
  manifestRef: string; // the name the secret is written under IN this file (== secret name unless remapped)
  keysToAdd: string[];
  /** True when this file references the secret but its expected key-list structure
   *  (items:/jmesPath:/secretObjects) could not be located — editing was skipped because the
   *  scan didn't recognize the file's shape, NOT because the keys are already present. The
   *  UI must show this distinctly from "up to date", since it means the key was NOT
   *  registered and needs manual attention. */
  unmatched?: boolean;
}

/**
 * One consuming manifest's drift for a secret: what it currently enumerates (`registeredKeys`)
 * vs what AWS actually holds. `missingKeys` are the AWS keys NOT registered here — the exact
 * keys a "solve drift" draft PR would add. `unmatched` mirrors the editors: the secret is
 * referenced but its key-list structure couldn't be located, so its registered set is unknown
 * (NOT empty) and it can't be auto-fixed.
 */
export interface DriftManifest {
  path: string;
  env: string;
  format: Mechanism;
  registeredKeys: string[];
  missingKeys: string[];
  unmatched: boolean;
}

/** The requester's final file selection, stored on the request and used to open the PR. */
export interface SelectedTarget {
  path: string;
  manifestRef?: string;
  format?: Mechanism;
  // Exact keys the requester wants applied to THIS file — a subset of the auto-detected
  // keysToAdd for that target, letting them keep a file in the PR while excluding one of
  // its keys. Omitted/empty = apply every proposed/approved key (today's default).
  keys?: string[];
  // The env this path resolved to at compose time (from ResolvedTarget.env, or the client's
  // own envOf() for a manually-added path) — carried through so the review queue can badge
  // the SAME env the requester saw, instead of re-deriving it from the path with a possibly
  // different/incomplete regex. Optional: rows persisted before this field existed have none,
  // and callers displaying it should fall back to computing envOf(path) themselves.
  env?: string;
}

/**
 * Append `keys` (that are missing) to the `items:` list of the `secretsStore.mappings[]`
 * entry whose `awsSecretName` matches `secretName`. Returns null when the secret isn't
 * referenced here, has no `items:` list, or every key is already present.
 */
export function editValuesItems(
  content: string,
  secretName: string,
  keys: string[],
): ManifestEditResult {
  const eol = detectEol(content);
  const lines = content.split(/\r?\n/);
  const target = secretName.trim();

  let mapIdx = -1;
  let mapIndent = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)-?\s*awsSecretName:\s*(.+?)\s*$/);
    if (m && stripQuotes(m[2]) === target) {
      mapIdx = i;
      mapIndent = m[1].length;
      break;
    }
  }
  if (mapIdx === -1) {
    return { status: 'not-referenced' };
  }

  let itemsIdx = -1;
  let itemsIndent = 0;
  for (let j = mapIdx + 1; j < lines.length; j++) {
    const ln = lines[j];
    if (/^\s*$/.test(ln) || /^\s*#/.test(ln)) {
      continue;
    }
    const ind = indentOf(ln);
    if (ind <= mapIndent) {
      break;
    }
    if (/^\s*items:\s*$/.test(ln)) {
      itemsIdx = j;
      itemsIndent = ind;
      break;
    }
  }
  // The mapping was found but has no `items:` list — a different/unrecognized shape
  // (e.g. flow-style `items: []`, or a wholesale mount) rather than "keys already there".
  if (itemsIdx === -1) {
    return { status: 'unmatched' };
  }

  const existing = new Set<string>();
  let lastItemIdx = itemsIdx;
  let itemIndent = itemsIndent + 2;
  for (let j = itemsIdx + 1; j < lines.length; j++) {
    const ln = lines[j];
    if (/^\s*$/.test(ln) || /^\s*#/.test(ln)) {
      continue;
    }
    if (indentOf(ln) <= itemsIndent) {
      break;
    }
    const im = ln.match(/^(\s*)-\s+(.+?)\s*$/);
    // A line still inside the list's indent that isn't a plain "- value" entry (e.g. a
    // mapping-style item split across lines) means this list's shape isn't the flat scalar
    // list this editor understands. Stopping the scan here without flagging it would leave
    // `existing` incomplete, so a key already present further down could be wrongly judged
    // "missing" and re-inserted as a duplicate. Report `unmatched` instead of guessing —
    // same principle as the `items:`-not-found case above.
    if (!im) {
      return { status: 'unmatched' };
    }
    existing.add(stripQuotes(im[2]));
    lastItemIdx = j;
    itemIndent = im[1].length;
  }

  const missing = keys.filter((k) => !existing.has(k));
  if (missing.length === 0) {
    return { status: 'up-to-date' };
  }

  const insert = missing.map((k) => ' '.repeat(itemIndent) + '- ' + k);
  const out = [...lines.slice(0, lastItemIdx + 1), ...insert, ...lines.slice(lastItemIdx + 1)];
  return { status: 'edited', content: out.join(eol), added: missing };
}

/**
 * Add missing `keys` to a standalone SecretProviderClass in TWO places:
 *  - the matching object's `jmesPath:` list (a `- path:` + `objectAlias:` pair), and
 *  - the `secretObjects[].data:` list (a `- objectName:` + `key:` pair)
 * so the key is both pulled from AWS and written into the synced k8s Secret.
 * Returns null when the secret isn't referenced or nothing needs adding.
 */
export function editSpc(content: string, secretName: string, keys: string[]): ManifestEditResult {
  const eol = detectEol(content);
  let lines = content.split(/\r?\n/);
  const target = secretName.trim();
  const added = new Set<string>();
  // Tracks whether EITHER region's list structure was actually located, independent of
  // whether anything needed adding there — lets us tell "found the structure, keys already
  // present" (up-to-date) apart from "found the objectName but no known list shape at all"
  // (unmatched) once nothing ends up in `added`.
  let structureFound = false;

  // Region A — jmesPath under the matching objectName
  let objIdx = -1;
  let objIndent = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)-?\s*objectName:\s*(.+?)\s*$/);
    if (m && stripQuotes(m[2]) === target) {
      objIdx = i;
      objIndent = m[1].length;
      break;
    }
  }
  if (objIdx === -1) {
    return { status: 'not-referenced' };
  }

  let jpIdx = -1;
  let jpIndent = 0;
  const matchingAliases = new Set<string>();
  for (let j = objIdx + 1; j < lines.length; j++) {
    const ln = lines[j];
    if (/^\s*$/.test(ln) || /^\s*#/.test(ln)) {
      continue;
    }
    const ind = indentOf(ln);
    if (ind <= objIndent) {
      break;
    }
    if (/^\s*jmesPath:\s*$/.test(ln)) {
      jpIdx = j;
      jpIndent = ind;
      break;
    }
  }
  if (jpIdx !== -1) {
    structureFound = true;
    const existing = new Set<string>();
    let lastIdx = jpIdx;
    let pathIndent = jpIndent + 2;
    let aliasIndent = jpIndent + 4;
    let currentPath = '';
    for (let j = jpIdx + 1; j < lines.length; j++) {
      const ln = lines[j];
      if (/^\s*$/.test(ln) || /^\s*#/.test(ln)) {
        continue;
      }
      if (indentOf(ln) <= jpIndent) {
        break;
      }
      const pm = ln.match(/^(\s*)-\s*path:\s*(.+?)\s*$/);
      if (pm) {
        currentPath = stripQuotes(pm[2]);
        existing.add(currentPath);
        matchingAliases.add(currentPath);
        pathIndent = pm[1].length;
      }
      const am = ln.match(/^(\s*)objectAlias:\s*(.+?)\s*$/);
      if (am) {
        const aliasVal = stripQuotes(am[2]);
        matchingAliases.add(aliasVal);
        aliasIndent = am[1].length;
      } else {
        const amSimple = ln.match(/^(\s*)objectAlias:/);
        if (amSimple) {
          aliasIndent = amSimple[1].length;
        }
      }
      lastIdx = j;
    }
    const missing = keys.filter((k) => !existing.has(k));
    if (missing.length) {
      const insert: string[] = [];
      for (const k of missing) {
        insert.push(' '.repeat(pathIndent) + '- path: ' + k);
        insert.push(' '.repeat(aliasIndent) + 'objectAlias: ' + k);
        added.add(k);
      }
      lines = [...lines.slice(0, lastIdx + 1), ...insert, ...lines.slice(lastIdx + 1)];
    }
  }

  // Region B — secretObjects[].data. Only touch it when this file actually references the
  // target secret (its objectName matched in Region A); otherwise a file that merely has a
  // secretObjects block for some OTHER secret would wrongly gain the key.
  let soIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*secretObjects:\s*$/.test(lines[i])) {
      soIdx = i;
      break;
    }
  }
  if (soIdx !== -1) {
    const soIndent = indentOf(lines[soIdx]);
    interface SecretObjectBlock {
      secretNameLine?: string;
      dataIdx: number;
      dataIndent: number;
      existingObjectNames: string[];
      lastIdx: number;
      onIndent: number;
      keyIndent: number;
      dataFinished?: boolean;
    }
    const blocks: SecretObjectBlock[] = [];
    let currentBlock: Partial<SecretObjectBlock> | null = null;
    let itemIndent = -1;

    for (let j = soIdx + 1; j < lines.length; j++) {
      const ln = lines[j];
      if (/^\s*$/.test(ln) || /^\s*#/.test(ln)) {
        continue;
      }
      const ind = indentOf(ln);
      if (ind <= soIndent) {
        break;
      }

      const isArrayItem = /^\s*-\s+/.test(ln);
      if (isArrayItem) {
        if (itemIndent === -1) {
          itemIndent = ind;
        }
        if (ind === itemIndent) {
          if (currentBlock && currentBlock.dataIdx !== undefined) {
            blocks.push(currentBlock as SecretObjectBlock);
          }
          currentBlock = { existingObjectNames: [] };
        }
      }

      if (currentBlock) {
        const sn = ln.match(/^\s*-?\s*secretName:\s*(.+?)\s*$/);
        if (sn) {
          currentBlock.secretNameLine = stripQuotes(sn[1]);
        }

        if (/^\s*data:\s*$/.test(ln)) {
          currentBlock.dataIdx = j;
          currentBlock.dataIndent = ind;
          currentBlock.lastIdx = j;
          currentBlock.onIndent = ind + 2;
          currentBlock.keyIndent = ind + 4;
        } else if (currentBlock.dataIdx !== undefined && j > currentBlock.dataIdx) {
          if (currentBlock.dataIndent !== undefined && ind <= currentBlock.dataIndent) {
            currentBlock.dataFinished = true;
          } else if (!currentBlock.dataFinished) {
            const om = ln.match(/^(\s*)-\s*objectName:\s*(.+?)\s*$/);
            if (om) {
              currentBlock.existingObjectNames!.push(stripQuotes(om[2]));
              currentBlock.onIndent = om[1].length;
              currentBlock.lastIdx = j;
            }
            const km = ln.match(/^(\s*)key:/);
            if (km) {
              currentBlock.keyIndent = km[1].length;
              currentBlock.lastIdx = j;
            }
          }
        }
      }
    }
    if (currentBlock && currentBlock.dataIdx !== undefined) {
      blocks.push(currentBlock as SecretObjectBlock);
    }

    let selectedBlock: SecretObjectBlock | null = null;
    if (blocks.length > 0) {
      selectedBlock =
        blocks.find((b) => b.existingObjectNames.some((name) => matchingAliases.has(name))) || null;

      if (!selectedBlock && target) {
        selectedBlock =
          blocks.find(
            (b) =>
              b.secretNameLine &&
              (b.secretNameLine.toLowerCase() === target.toLowerCase() ||
                target.toLowerCase().includes(b.secretNameLine.toLowerCase()) ||
                b.secretNameLine.toLowerCase().includes(target.toLowerCase())),
          ) || null;
      }

      if (!selectedBlock) {
        selectedBlock = blocks[0];
      }
    }

    if (selectedBlock) {
      structureFound = true;
      const existing = new Set(selectedBlock.existingObjectNames);
      const missing = keys.filter((k) => !existing.has(k));
      if (missing.length) {
        const insert: string[] = [];
        for (const k of missing) {
          insert.push(' '.repeat(selectedBlock.onIndent) + '- objectName: ' + k);
          insert.push(' '.repeat(selectedBlock.keyIndent) + 'key: ' + k);
          added.add(k);
        }
        lines = [
          ...lines.slice(0, selectedBlock.lastIdx + 1),
          ...insert,
          ...lines.slice(selectedBlock.lastIdx + 1),
        ];
      }
    }
  }

  if (added.size > 0) {
    return { status: 'edited', content: lines.join(eol), added: [...added] };
  }
  // objectName was found but neither the jmesPath: nor the secretObjects[].data: list could
  // be located — an unrecognized shape, not "already present".
  if (!structureFound) {
    return { status: 'unmatched' };
  }
  return { status: 'up-to-date' };
}

/**
 * The keys currently REGISTERED for `secretName` in a manifest — the flip side of the editors
 * above (used by drift detection to diff the repo's enumerated keys against what AWS holds).
 * `referenced` is false when the secret isn't mentioned at all; `unmatched` is true when it IS
 * referenced but its key-list structure couldn't be located, so `keys` is unknown, not empty.
 */
export function registeredKeysInFile(
  path: string,
  content: string,
  secretName: string,
): { referenced: boolean; keys: string[]; unmatched: boolean } {
  return isSpcFile(path)
    ? registeredKeysSpc(content, secretName)
    : registeredKeysValues(content, secretName);
}

/** Registered keys under the `items:` list of the values mapping matching `secretName`. */
function registeredKeysValues(
  content: string,
  secretName: string,
): { referenced: boolean; keys: string[]; unmatched: boolean } {
  const lines = content.split(/\r?\n/);
  const target = secretName.trim();

  let mapIdx = -1;
  let mapIndent = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)-?\s*awsSecretName:\s*(.+?)\s*$/);
    if (m && stripQuotes(m[2]) === target) {
      mapIdx = i;
      mapIndent = m[1].length;
      break;
    }
  }
  if (mapIdx === -1) {
    return { referenced: false, keys: [], unmatched: false };
  }

  let itemsIdx = -1;
  let itemsIndent = 0;
  for (let j = mapIdx + 1; j < lines.length; j++) {
    const ln = lines[j];
    if (/^\s*$/.test(ln) || /^\s*#/.test(ln)) {
      continue;
    }
    if (indentOf(ln) <= mapIndent) {
      break;
    }
    if (/^\s*items:\s*$/.test(ln)) {
      itemsIdx = j;
      itemsIndent = indentOf(ln);
      break;
    }
  }
  if (itemsIdx === -1) {
    return { referenced: true, keys: [], unmatched: true };
  }

  const keys: string[] = [];
  for (let j = itemsIdx + 1; j < lines.length; j++) {
    const ln = lines[j];
    if (/^\s*$/.test(ln) || /^\s*#/.test(ln)) {
      continue;
    }
    if (indentOf(ln) <= itemsIndent) {
      break;
    }
    const im = ln.match(/^\s*-\s+(.+?)\s*$/);
    // A non-scalar item (mapping-style entry) means this list isn't the flat shape we read —
    // report unmatched rather than returning a partial registered set, same as the editor.
    if (!im) {
      return { referenced: true, keys: [], unmatched: true };
    }
    keys.push(stripQuotes(im[1]));
  }
  return { referenced: true, keys, unmatched: false };
}

/** Registered keys under the `jmesPath:` list of the SPC object matching `secretName`. */
function registeredKeysSpc(
  content: string,
  secretName: string,
): { referenced: boolean; keys: string[]; unmatched: boolean } {
  const lines = content.split(/\r?\n/);
  const target = secretName.trim();

  let objIdx = -1;
  let objIndent = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)-?\s*objectName:\s*(.+?)\s*$/);
    if (m && stripQuotes(m[2]) === target) {
      objIdx = i;
      objIndent = m[1].length;
      break;
    }
  }
  if (objIdx === -1) {
    return { referenced: false, keys: [], unmatched: false };
  }

  let jpIdx = -1;
  let jpIndent = 0;
  for (let j = objIdx + 1; j < lines.length; j++) {
    const ln = lines[j];
    if (/^\s*$/.test(ln) || /^\s*#/.test(ln)) {
      continue;
    }
    if (indentOf(ln) <= objIndent) {
      break;
    }
    if (/^\s*jmesPath:\s*$/.test(ln)) {
      jpIdx = j;
      jpIndent = indentOf(ln);
      break;
    }
  }
  if (jpIdx === -1) {
    return { referenced: true, keys: [], unmatched: true };
  }

  const keys: string[] = [];
  for (let j = jpIdx + 1; j < lines.length; j++) {
    const ln = lines[j];
    if (/^\s*$/.test(ln) || /^\s*#/.test(ln)) {
      continue;
    }
    if (indentOf(ln) <= jpIndent) {
      break;
    }
    const pm = ln.match(/^\s*-\s*path:\s*(.+?)\s*$/);
    if (pm) {
      keys.push(stripQuotes(pm[1]));
    }
  }
  return { referenced: true, keys, unmatched: false };
}

const isValuesFile = (p: string): boolean => /(^|\/)values-[^/]*\.ya?ml$/i.test(p);
const isSpcFile = (p: string): boolean => /(^|\/)secretproviderclass[^/]*\.ya?ml$/i.test(p);
// Only values-*.yaml is ever auto-discovered as a consumer — SecretProviderClass files are
// deliberately excluded (product decision — Hermes must never edit that file).
const isCandidate = (p: string): boolean => isValuesFile(p);

/**
 * The enumerated (key-listing) secrets a manifest references. Wholesale mounts (a
 * SecretProviderClass object with no `jmesPath`) are intentionally excluded — adding a
 * key there needs no edit, so they must not appear as consumers.
 */
export function referencedEnumeratedSecrets(path: string, content: string): Consumer[] {
  // Thin wrapper over namedSecretsInFile — the actual scan production's refreshIndex() runs.
  // Kept as a SINGLE implementation (rather than two independently-maintained copies of the
  // same regex-based scan) so a fix to the scanning heuristic can't silently apply to only
  // one of the two call shapes; this function just re-projects onto {path, mech}.
  return namedSecretsInFile(path, content).map(({ mech }) => ({ path, mech }));
}

function editForFile(
  path: string,
  content: string,
  secretName: string,
  keys: string[],
): ManifestEditResult {
  // SecretProviderClass is excluded from AUTO-discovery (isCandidate) so it's never
  // suggested — but a requester who manually adds one (a real edge case, e.g. a service
  // that only has an SPC manifest) can still have it edited.
  return isSpcFile(path)
    ? editSpc(content, secretName, keys)
    : editValuesItems(content, secretName, keys);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

interface TreeEntry {
  path: string;
  type: string;
}

/** Connection details for one infra-deployment GitHub repo (prod, sandbox, ...). */
export interface InfraRepoConfig {
  readonly token: string | undefined;
  readonly owner: string;
  readonly repo: string;
  readonly baseBranch: string;
  readonly apiBaseUrl: string;
  readonly isSimulation: boolean;
}

export class InfraRepoSyncService {
  private client: AxiosInstance | null = null;
  private indexCache: InfraIndex | null = null;
  /**
   * The in-progress refresh, shared by every concurrent caller. Without this, a drift scan's N
   * workers each call consumersOf before any of them has populated the cache, so each one scans
   * the WHOLE repo — an N-fold amplification of the single most expensive operation here.
   */
  private indexInFlight: Promise<InfraIndex> | null = null;

  /**
   * `instanceCfg` points this service at one instance's repo. Omitted ⇒ the prod repo
   * (config.infraRepo) — preserving the back-compat singleton export below.
   */
  constructor(private readonly instanceCfg?: InfraRepoConfig) {}

  private get cfg(): InfraRepoConfig {
    return this.instanceCfg ?? config.infraRepo;
  }
  private get isSimulation(): boolean {
    return this.cfg.isSimulation;
  }
  private get slug(): string {
    return `${this.cfg.owner}/${this.cfg.repo}`;
  }

  private gh(): AxiosInstance {
    if (this.client) {
      return this.client;
    }
    this.client = createHttpClient({
      baseURL: this.cfg.apiBaseUrl,
      timeout: 20000,
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'hermes-secret-ingestion',
      },
    });
    // An AxiosError stringifies to "Request failed with status code 409" and nothing else — no
    // URL, no GitHub message. A 409 from a contents PUT (stale blob SHA) and one from a merge
    // (branch was modified) are different bugs that look identical in the log, so diagnosing one
    // means inferring from code rather than reading what happened. Log the failing method/URL
    // and GitHub's own message once, here, so every call in this service is diagnosable.
    // Never swallows: the error is always re-thrown for the existing handlers to act on.
    this.client.interceptors.response.use(
      (r) => r,
      (err: any) => {
        // 404 is normal control flow here, not a failure: getContent treats it as "file absent"
        // and returns null. Logging it at error level would fire on every manifest path that
        // simply isn't there, and train everyone to ignore this line.
        if (err.response?.status !== 404) {
          logger.error(
            {
              method: err.config?.method?.toUpperCase(),
              url: err.config?.url,
              status: err.response?.status,
              // GitHub's body carries the real reason, e.g. "is at <sha> but expected <sha>".
              githubMessage: err.response?.data?.message,
              githubErrors: err.response?.data?.errors,
            },
            'infra-repo-sync: GitHub API call failed',
          );
        }
        return Promise.reject(err);
      },
    );
    return this.client;
  }

  private repoPath(suffix: string): string {
    return `/repos/${this.cfg.owner}/${this.cfg.repo}${suffix}`;
  }

  // --- low-level GitHub calls ---

  private async getBaseCommitSha(): Promise<string> {
    const res = await this.gh().get(this.repoPath(`/git/ref/heads/${this.cfg.baseBranch}`));
    return res.data.object.sha;
  }

  private async getTreeSha(commitSha: string): Promise<string> {
    const res = await this.gh().get(this.repoPath(`/git/commits/${commitSha}`));
    return res.data.tree.sha;
  }

  private async getTreeEntries(treeSha: string): Promise<TreeEntry[]> {
    const res = await this.gh().get(this.repoPath(`/git/trees/${treeSha}`), {
      params: { recursive: 1 },
    });
    return (res.data.tree || []) as TreeEntry[];
  }

  /** Returns { sha, content } for a path at a ref, or null if the file is absent. */
  private async getContent(
    path: string,
    ref: string,
  ): Promise<{ sha: string; content: string } | null> {
    try {
      const res = await this.gh().get(
        this.repoPath(`/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`),
        {
          params: { ref },
        },
      );
      const content = Buffer.from(res.data.content || '', 'base64').toString('utf8');
      return { sha: res.data.sha, content };
    } catch (err: any) {
      if (err.response?.status === 404) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Points `branch` at `fromSha`, creating it or force-resetting it if it already exists.
   *
   * Reusing an existing branch AS-IS is not safe here: branch names are deterministic
   * (`branchName`), and the drift branch is deterministic per SECRET (`requestId: 'drift'`), so
   * a branch left behind by an already-merged/closed PR is routinely still present when we open
   * the next one. Such a branch sits on a stale base commit, which breaks the caller two ways:
   * its `putContent` SHAs come from a fresh read of the BASE branch, so any path whose blob
   * differs between stale-branch and base 409s; and even when the writes land, the PR carries
   * the previous round's commits and a stale merge-base. Resetting to base first makes the new
   * PR's only diff the keys we are about to add — same invariant `prepareApprovedBranch` relies
   * on at merge time.
   *
   * Callers must only reach this once no OPEN PR exists for the branch (see
   * `findOpenPullByBranch`), otherwise this would rewrite a PR someone is reviewing.
   */
  private async createOrResetBranch(branch: string, fromSha: string): Promise<void> {
    try {
      await this.gh().post(this.repoPath('/git/refs'), {
        ref: `refs/heads/${branch}`,
        sha: fromSha,
      });
    } catch (err: any) {
      // 422 = ref already exists — left over from a previous PR on this deterministic branch
      // name. Force it back to base rather than building on its stale history.
      if (err.response?.status !== 422) {
        throw err;
      }
      await this.resetBranchToSha(branch, fromSha);
    }
  }

  /**
   * Force-moves an existing branch ref to `sha` (a rebase-by-reset). Used at review time to
   * re-parent a PR branch onto the CURRENT base: without this, the branch keeps its original
   * (stale) merge-base, so an earlier PR that already landed keys in the same `items:` region
   * makes git's three-way merge see two overlapping insertions → a conflict GitHub never
   * auto-resolves — even though the recomputed file bytes are logically correct. Re-parenting
   * onto current base leaves the branch's only diff as the new key(s), so the PR merges cleanly.
   *
   * ⚠ `sha` must be a commit that is AHEAD of base (i.e. one built by commitFilesOnBase), never
   * the base commit itself. Pointing a PR's head AT base leaves it with zero commits, and GitHub
   * closes a PR the instant that is true — irreversibly, as far as the later writes are
   * concerned. That is exactly how the recompute-on-approval flow used to bin its own PRs.
   */
  private async resetBranchToSha(branch: string, sha: string): Promise<void> {
    await this.gh().patch(this.repoPath(`/git/refs/heads/${branch}`), {
      sha,
      force: true,
    });
  }

  /**
   * Builds ONE commit containing `files`, parented on `parentSha`, and returns its SHA without
   * touching any branch. Together with a single `resetBranchToSha` this replaces a
   * reset-then-PUT-each-file sequence, and exists because that sequence cannot be made safe:
   *
   *  - it force-moves the branch to base first, which leaves the PR with zero commits ahead of
   *    base for as long as the writes take. GitHub closes a PR the moment that is true, and
   *    committing the branch back afterwards does not reopen it — so any failure mid-write
   *    (or a crash) strands the PR closed. That is the "PRs close themselves on approval" bug.
   *  - each PUT commits to the same branch, so they must run one at a time or they 409 on the
   *    moved ref, making the window longer still.
   *
   * Blobs and trees belong to no branch, so building the commit is invisible to the PR and the
   * blob uploads can run concurrently. The branch then moves old-head → new-commit in a single
   * atomic ref update, and is ahead of base at every observable instant.
   */
  private async commitFilesOnBase(
    parentSha: string,
    message: string,
    files: { path: string; content: string }[],
  ): Promise<string> {
    const baseTreeSha = await this.getTreeSha(parentSha);
    const blobs = await mapWithConcurrency(files, 6, async (f) => {
      const res = await this.gh().post(this.repoPath('/git/blobs'), {
        content: Buffer.from(f.content, 'utf8').toString('base64'),
        encoding: 'base64',
      });
      return { path: f.path, sha: res.data.sha as string };
    });
    const tree = await this.gh().post(this.repoPath('/git/trees'), {
      base_tree: baseTreeSha,
      tree: blobs.map((b) => ({
        path: b.path,
        mode: '100644',
        type: 'blob',
        sha: b.sha,
      })),
    });
    const commit = await this.gh().post(this.repoPath('/git/commits'), {
      message,
      tree: tree.data.sha,
      parents: [parentSha],
    });
    return commit.data.sha as string;
  }

  private async putContent(
    path: string,
    branch: string,
    message: string,
    newContent: string,
    sha: string,
  ): Promise<void> {
    await this.gh().put(
      this.repoPath(`/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`),
      {
        message,
        content: Buffer.from(newContent, 'utf8').toString('base64'),
        branch,
        sha,
      },
    );
  }

  private async createDraftPull(
    branch: string,
    title: string,
    body: string,
  ): Promise<{ number: number; url: string; nodeId: string }> {
    const res = await this.gh().post(this.repoPath('/pulls'), {
      title,
      body,
      head: branch,
      base: this.cfg.baseBranch,
      draft: true,
    });
    return {
      number: res.data.number,
      url: res.data.html_url,
      nodeId: res.data.node_id,
    };
  }

  /**
   * Finds the currently-OPEN PR for a branch, or null. Used to make `openPrForRequest`
   * idempotent: the submit-time and review-time listeners can both race to open a PR for the
   * same deterministic branch name, and this lets the loser discover the winner's PR instead
   * of erroring.
   *
   * `state` MUST stay 'open'. Branch names are deterministic, and the drift branch is
   * deterministic per secret (`requestId: 'drift'`), so the same branch is reused every time
   * drift is solved for that secret. Querying 'all' means the second Solve — after the first
   * PR merged — matches that merged PR, and the caller "adopts" it: reporting state OPEN with
   * its number while creating no branch, editing no file, and registering none of the new keys.
   * A merged or closed PR is finished work, never something to adopt.
   */
  private async findOpenPullByBranch(
    branch: string,
  ): Promise<{ number: number; url: string; nodeId: string } | null> {
    const res = await this.gh().get(this.repoPath('/pulls'), {
      params: {
        head: `${this.cfg.owner}:${branch}`,
        state: 'open',
        per_page: 1,
      },
    });
    const pr = (res.data || [])[0];
    if (!pr) {
      return null;
    }
    return { number: pr.number, url: pr.html_url, nodeId: pr.node_id };
  }

  /**
   * Flips a draft PR to ready-for-review. Load-bearing for auto-merge: every Hermes PR is
   * created as a draft (createDraftPull), and GitHub refuses to merge a draft with a 405 —
   * the same status it returns for a branch-protection block.
   *
   * GraphQL reports a failed mutation as an `errors` array in a 200 body, so axios resolves
   * and the response interceptor (which only sees non-2xx) never logs it. Without the check
   * below a failed flip looks exactly like a successful one, and the PR stays a draft until
   * mergePull reports it as an unexplained 405 several seconds later — the cause long gone
   * from the call stack. Raise it here, where we still know what actually failed.
   */
  private async markReady(nodeId: string): Promise<void> {
    const res = await this.gh().post('/graphql', {
      query:
        'mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id}}}',
      variables: { id: nodeId },
    });
    const errors: { message?: string }[] = res.data?.errors ?? [];
    if (errors.length === 0) {
      return;
    }
    const messages = errors.map((e) => e?.message || '').filter(Boolean);
    // "Not a draft" is the goal state, not a failure: both the manual retry path and the
    // submit/review race can re-run this against a PR an earlier pass already flipped.
    // Treating it as an error would break flows that work today.
    if (messages.length > 0 && messages.every((m) => /not a draft/i.test(m))) {
      logger.info({ nodeId }, 'infra-repo-sync: PR was already ready for review — nothing to flip');
      return;
    }
    throw new Error(
      `could not mark PR ready for review: ${messages.join('; ') || 'unknown GraphQL error'}`,
    );
  }

  private async mergePull(number: number, title: string): Promise<void> {
    const maxAttempts = 4;
    let lastError: any;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.gh().put(this.repoPath(`/pulls/${number}/merge`), {
          merge_method: 'squash',
          commit_title: title,
        });
        return;
      } catch (err: any) {
        lastError = err;
        const status = err.response?.status;
        if (status === 405 && attempt < maxAttempts) {
          logger.info(
            { pr: number, attempt },
            'PR merge returned 405 (calculating mergeability?), retrying in 1.5s...',
          );
          await new Promise((resolve) => setTimeout(resolve, 1500));
          continue;
        }
        break;
      }
    }

    const status = lastError.response?.status;
    if (status === 405) {
      // 405 is GitHub's answer to every "not mergeable right now": still a draft, a required
      // review/check outstanding, branch protection blocking a bot merge, or a conflict. Only
      // GitHub's own body distinguishes them, so quote it rather than asserting one cause —
      // this message is persisted to infraSyncNote and is the whole diagnostic an admin gets
      // in the review queue. Naming a single cause here sent people auditing branch protection
      // for what was really an un-flipped draft.
      const ghMessage = lastError.response?.data?.message;
      const msg =
        `PR #${number} could not be merged (405)` +
        (ghMessage ? ` — GitHub said: "${ghMessage}"` : '') +
        '. Common causes: the PR is still a draft, a required check or review is outstanding, branch protection blocks bot merges, or the branch has a conflict.';
      logger.error({ pr: number, status, githubMessage: ghMessage }, msg);
      throw new Error(msg);
    }
    throw lastError;
  }

  private async closePull(number: number): Promise<void> {
    await this.gh().patch(this.repoPath(`/pulls/${number}`), {
      state: 'closed',
    });
  }

  private async reopenPull(number: number): Promise<void> {
    await this.gh().patch(this.repoPath(`/pulls/${number}`), { state: 'open' });
  }

  private async updatePull(
    number: number,
    fields: { title?: string; body?: string },
  ): Promise<void> {
    await this.gh().patch(this.repoPath(`/pulls/${number}`), fields);
  }

  private async comment(number: number, body: string): Promise<void> {
    await this.gh().post(this.repoPath(`/issues/${number}/comments`), { body });
  }

  // --- consumer index ---

  /**
   * The consumer index, refreshing it only when needed. Three things make this cheap, and all
   * three matter at drift-scan scale (one call per in-scope secret):
   *  - inside the TTL, returns the cache with NO API call at all. The old code spent 2 calls
   *    (base sha + tree sha) *before* looking at the cache, i.e. on every single lookup.
   *  - concurrent callers share one refresh, instead of each scanning the whole repo.
   *  - the refresh keeps file content, so read-only callers never re-fetch.
   */
  private async getIndex(opts?: { fresh?: boolean }): Promise<InfraIndex> {
    const cached = this.indexCache;
    if (!opts?.fresh && cached && Date.now() - cached.validatedAt < INDEX_TTL_MS) {
      return cached;
    }
    if (this.indexInFlight) {
      return this.indexInFlight;
    }
    this.indexInFlight = this.refreshIndex().finally(() => {
      this.indexInFlight = null;
    });
    return this.indexInFlight;
  }

  private async refreshIndex(): Promise<InfraIndex> {
    const commitSha = await this.getBaseCommitSha();
    const treeSha = await this.getTreeSha(commitSha);
    if (this.indexCache && this.indexCache.treeSha === treeSha) {
      // Base hasn't moved — the cached scan is still accurate, just re-stamp its TTL.
      this.indexCache.validatedAt = Date.now();
      return this.indexCache;
    }
    const entries = await this.getTreeEntries(treeSha);
    const candidates = entries.filter((e) => e.type === 'blob' && isCandidate(e.path));
    // Independent reads — bounded concurrency instead of one-at-a-time (this can scan every
    // values-*.yaml in the whole repo), but capped well under GitHub's secondary rate limit
    // rather than firing all of them at once.
    // Read at the pinned tree's commit, not the moving branch ref, so every file in one index
    // comes from the same snapshot — and so the content cached below matches `treeSha` exactly.
    const scanned = await mapWithConcurrency(candidates, 6, async (e) => {
      const file = await this.getContent(e.path, commitSha);
      return file ? { path: e.path, file, refs: namedSecretsInFile(e.path, file.content) } : null;
    });
    const index = new Map<string, Consumer[]>();
    const files = new Map<string, { sha: string; content: string }>();
    for (const result of scanned) {
      if (!result) {
        continue;
      }
      files.set(result.path, result.file);
      for (const { name, mech } of result.refs) {
        const list = index.get(name) || [];
        if (!list.some((c) => c.path === result.path)) {
          list.push({ path: result.path, mech });
        }
        index.set(name, list);
      }
    }
    this.indexCache = { treeSha, index, files, validatedAt: Date.now() };
    logger.info(
      { repo: this.slug, secrets: index.size, files: candidates.length },
      'Built infra-deployment consumer index',
    );
    return this.indexCache;
  }

  private async consumersOf(secretName: string, opts?: { fresh?: boolean }): Promise<Consumer[]> {
    const { index } = await this.getIndex(opts);
    return index.get(secretName.trim()) || [];
  }

  /**
   * Resolves the consumer list to edit — the requester's explicit selection when present
   * (each carries the name it's written under, defaulting to the secret name), otherwise
   * the live auto-scanned set. This is the single place open + merge agree on files.
   */
  private async targetConsumers(
    secretName: string,
    targets?: SelectedTarget[],
  ): Promise<{ path: string; mech: Mechanism; manifestRef: string; keys?: string[] }[]> {
    // An explicitly-provided selection is honored verbatim — even an empty array, which
    // means "the requester chose no files" (e.g. an update-only request, or they unticked
    // everything) → no PR. Only `undefined` (the caller never specified) falls back to the
    // live auto-resolved set.
    let result: {
      path: string;
      mech: Mechanism;
      manifestRef: string;
      keys?: string[];
    }[];
    if (targets !== undefined) {
      result = targets.map((t) => ({
        path: t.path,
        mech: t.format || (isSpcFile(t.path) ? 'spc' : 'helm-values'),
        manifestRef: (t.manifestRef || secretName).trim(),
        // A requester-narrowed key subset for this specific file — undefined means "apply
        // every proposed/approved key", the historical default.
        keys:
          t.keys && t.keys.length > 0
            ? [...new Set(t.keys.map((k) => k.trim()).filter(Boolean))]
            : undefined,
      }));
    } else {
      // `fresh`: this is the auto-discovered file list a PR is about to be BUILT from, so it
      // must not come from a TTL-cached snapshot — a manifest added to base in the last few
      // seconds would silently not get the key, and nothing downstream would notice. The two
      // calls this costs are irrelevant on a write path (one per PR, vs one per secret on a
      // 129-secret drift scan, which is what the cache exists for).
      result = (await this.consumersOf(secretName, { fresh: true })).map((c) => ({
        ...c,
        manifestRef: secretName,
      }));
    }
    // Deduplicate by path — if the same file appears twice (e.g. user-provided targets with
    // duplicates) the second putContent would 409/422 because the SHA changed after the first.
    const seen = new Set<string>();
    return result.filter((c) => {
      if (seen.has(c.path)) {
        return false;
      }
      seen.add(c.path);
      return true;
    });
  }

  /**
   * Dry-run: for the compose screen. Returns every manifest that consumes the secret with
   * the exact keys a request would add to it — nothing is committed. In simulation it
   * returns one representative target so the flow is demoable offline.
   */
  async resolveTargets(
    secretName: string,
    keys: string[],
    existingKeys: string[] = [],
  ): Promise<ResolvedTarget[]> {
    const wanted = [...new Set(keys.map((k) => k.trim()).filter(Boolean))];
    if (this.isSimulation) {
      // No real repo to diff against — approximate reality so the demo teaches the right
      // model: only keys NOT already in the secret count as "to add" (a live yaml diff does
      // exactly this against the file). An update-only request → keysToAdd empty → no PR.
      const existing = new Set(existingKeys);
      const safe = secretName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
      return [
        {
          path: `(simulated) ${safe}/prod/values-prod.yaml`,
          env: 'prod',
          format: 'helm-values',
          manifestRef: secretName,
          keysToAdd: wanted.filter((k) => !existing.has(k)),
        },
      ];
    }
    // resolveTargets is reached synchronously from the HTTP request path (previewInfra
    // controller → previewInfraTargets), unlike the event-listener-driven PR lifecycle
    // methods below (which are best-effort and already fully try/caught by their callers).
    // Wrap this GitHub round-trip so a raw axios failure surfaces as the project's standard
    // BaseError shape instead of a generic 500.
    try {
      return await this.resolveTargetsLive(secretName, wanted);
    } catch (err: any) {
      if (err instanceof BaseError) {
        throw err;
      }
      throw new ExternalServiceError(
        `Failed to resolve infra-deployment targets for "${secretName}": ${err.message || err}`,
        { secretName, repo: this.slug },
      );
    }
  }

  private async resolveTargetsLive(
    secretName: string,
    wanted: string[],
  ): Promise<ResolvedTarget[]> {
    const consumers = await this.consumersOf(secretName);
    // Independent reads — this sits on the interactive compose-screen preview path, so
    // parallelize across consumers (typically a small, secret-scoped set) instead of one
    // sequential round-trip per file.
    const resolved = await mapWithConcurrency(consumers, 6, async (c) => {
      const file = await this.getContent(c.path, this.cfg.baseBranch);
      if (!file) {
        return null;
      }
      const res = editForFile(c.path, file.content, secretName, wanted);
      if (res.status === 'unmatched') {
        logger.warn(
          { secretName, path: c.path },
          'infra-repo-sync: manifest references the secret but its expected key-list structure was not found — cannot auto-register keys here',
        );
      }
      const target: ResolvedTarget = {
        path: c.path,
        env: envOf(c.path),
        format: c.mech,
        manifestRef: secretName,
        keysToAdd: res.status === 'edited' ? res.added : [],
        unmatched: res.status === 'unmatched',
      };
      return target;
    });
    return resolved.filter((t): t is ResolvedTarget => t !== null);
  }

  /**
   * Drift view for the admin report: for every manifest that consumes `secretName`, what it
   * currently enumerates vs the live AWS key set. Read-only (no commit). In simulation there's
   * no real repo, so it returns one representative manifest that registers all-but-one AWS key,
   * making the "keys missing from the manifest" drift (and its Solve button) demoable offline.
   */
  async resolveDrift(secretName: string, awsKeys: string[]): Promise<DriftManifest[]> {
    const keys = [...new Set(awsKeys.map((k) => k.trim()).filter(Boolean))];
    if (this.isSimulation) {
      const safe = secretName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
      const registeredKeys = keys.length > 1 ? keys.slice(0, -1) : [];
      const missingKeys = keys.filter((k) => !registeredKeys.includes(k));
      return [
        {
          path: `(simulated) ${safe}/prod/values-prod.yaml`,
          env: 'prod',
          format: 'helm-values',
          registeredKeys,
          missingKeys,
          unmatched: false,
        },
      ];
    }
    try {
      // Both the consumer list and the file bytes come from one cached snapshot: building the
      // index already read every one of these files, so re-reading them here cost a GitHub call
      // per (secret x manifest) — the bulk of a 129-secret scan, and enough to trip GitHub's
      // secondary rate limit, at which point every secret's check failed and the report said
      // "no drift". Drift only reports, never writes, so a snapshot up to INDEX_TTL_MS old is
      // fine; it also makes the report internally consistent (every secret compared against the
      // same commit) rather than smeared across the scan's duration.
      const { index, files } = await this.getIndex();
      const consumers = index.get(secretName.trim()) || [];
      const resolved = consumers.map((c) => {
        const file = files.get(c.path);
        if (!file) {
          return null;
        }
        const reg = registeredKeysInFile(c.path, file.content, secretName);
        const m: DriftManifest = {
          path: c.path,
          env: envOf(c.path),
          format: c.mech,
          registeredKeys: reg.keys,
          // A file whose structure we couldn't parse (`unmatched`) can't be auto-fixed, so it
          // proposes no missing keys — the drift report surfaces the unmatched flag separately.
          missingKeys: reg.unmatched ? [] : keys.filter((k) => !reg.keys.includes(k)),
          unmatched: reg.unmatched,
        };
        return m;
      });
      return resolved.filter((m): m is DriftManifest => m !== null);
    } catch (err: any) {
      if (err instanceof BaseError) {
        throw err;
      }
      throw new ExternalServiceError(
        `Failed to resolve infra-deployment drift for "${secretName}": ${err.message || err}`,
        { secretName, repo: this.slug },
      );
    }
  }

  private branchName(secretName: string, requestId: string): string {
    const safe = secretName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    return `hermes/secret-keys/${safe}-${requestId}`;
  }

  // --- public lifecycle ---

  /**
   * Opens a DRAFT PR adding the proposed keys to every manifest that consumes the secret.
   * Returns SKIPPED (no PR) when the secret has no key-enumerated consumer, or when every
   * proposed key is already present. Never throws for a "nothing to do" case — only real
   * GitHub failures reject.
   */
  async openPrForRequest(opts: {
    requestId: string;
    secretName: string;
    proposedKeys: string[];
    targets?: SelectedTarget[];
    requesterName?: string;
    requesterEmail?: string;
  }): Promise<InfraSyncResult> {
    const { requestId, secretName } = opts;
    const proposedKeys = [...new Set(opts.proposedKeys.map((k) => k.trim()).filter(Boolean))];
    const branch = this.branchName(secretName, requestId);

    if (this.isSimulation) {
      // An explicit empty selection (update-only request, or everything unticked), or no
      // proposed keys at all (every key was already present), → no PR — mirroring the live
      // "nothing to add" path.
      if ((opts.targets && opts.targets.length === 0) || proposedKeys.length === 0) {
        return {
          state: 'SKIPPED',
          branch: null,
          note: 'no manifest changes needed — written to AWS only (simulation)',
        };
      }
      // Simulation only ever previews one representative target — honor its key subset if
      // the requester narrowed it, same as the live per-file path would.
      const simKeys = opts.targets?.[0]?.keys;
      const keysAdded = simKeys && simKeys.length > 0 ? simKeys : proposedKeys;
      return {
        state: 'OPEN',
        prNumber: simPrNumber(requestId),
        prUrl: `https://github.com/${this.slug}/pull/${simPrNumber(requestId)}`,
        prNodeId: `SIM_${requestId.slice(0, 8)}`,
        branch,
        filesChanged: ['(simulated)'],
        keysAdded,
        note: 'simulation (no GitHub calls)',
      };
    }

    // Idempotency guard: the submit-time and review-time listeners can both call this for the
    // same request (review-time retries when it still sees no infraPrNumber persisted, e.g.
    // because the submit-time call is still mid-flight). Both target the SAME deterministic
    // branch name, so if an OPEN PR for it already exists, adopt it instead of racing to
    // recreate it. Only an open PR counts — a merged/closed one on this branch is a previous
    // round's finished work (the drift branch is reused across solves), so we fall through and
    // open a fresh PR for the keys that are missing now.
    const existingPr = await this.findOpenPullByBranch(branch);
    if (existingPr) {
      logger.info(
        { requestId, secretName, pr: existingPr.number },
        'infra-repo-sync: PR already open for this branch — adopting it',
      );
      return {
        state: 'OPEN',
        prNumber: existingPr.number,
        prUrl: existingPr.url,
        prNodeId: existingPr.nodeId,
        branch,
        filesChanged: [],
        keysAdded: proposedKeys,
        note: 'PR already open for this request (concurrent open detected)',
      };
    }

    const consumers = await this.targetConsumers(secretName, opts.targets);
    if (consumers.length === 0) {
      // Either no manifest consumes the secret, or the requester selected no files — both
      // mean "written to AWS only, no PR".
      return {
        state: 'SKIPPED',
        branch: null,
        note: `no manifest changes for "${secretName}" — written to AWS only`,
      };
    }

    const baseSha = await this.getBaseCommitSha();
    // Reads are independent — parallelize across consumers (writes below stay sequential,
    // since each PUT mutates the same branch and must happen one at a time).
    const editResults = await mapWithConcurrency(consumers, 6, async (c) => {
      const file = await this.getContent(c.path, this.cfg.baseBranch);
      if (!file) {
        return null;
      }
      // A per-file key subset (requester narrowed which keys this specific file gets) wins
      // over the full proposed set.
      const res = editForFile(c.path, file.content, c.manifestRef, c.keys ?? proposedKeys);
      return { path: c.path, file, res };
    });
    const edits: {
      path: string;
      content: string;
      sha: string;
      added: string[];
    }[] = [];
    const unmatchedPaths: string[] = [];
    for (const r of editResults) {
      if (!r) {
        continue;
      }
      if (r.res.status === 'edited') {
        edits.push({
          path: r.path,
          content: r.res.content,
          sha: r.file.sha,
          added: r.res.added,
        });
      } else if (r.res.status === 'unmatched') {
        unmatchedPaths.push(r.path);
        logger.warn(
          { requestId, secretName, path: r.path },
          'infra-repo-sync: manifest referenced the secret but its expected key-list structure was not found — key NOT registered in this file',
        );
      }
    }
    if (edits.length === 0) {
      // Distinguish "genuinely nothing to do" from "the scan couldn't understand one or more
      // manifests" — conflating the two (as a single generic note) hides a key that actually
      // never got registered anywhere, discoverable only later when the pod doesn't see it.
      if (unmatchedPaths.length > 0) {
        return {
          state: 'SKIPPED',
          branch: null,
          note: `could not automatically register keys — ${unmatchedPaths.length} manifest(s) had an unrecognized structure and were left unchanged: ${unmatchedPaths.join(', ')}. Register the key there manually.`,
        };
      }
      return {
        state: 'SKIPPED',
        branch: null,
        note: 'all proposed keys already present in every consumer',
      };
    }

    const allAdded = [...new Set(edits.flatMap((e) => e.added))];
    let pr: { number: number; url: string; nodeId: string };
    try {
      await this.createOrResetBranch(branch, baseSha);
      for (const e of edits) {
        await this.putContent(
          e.path,
          branch,
          `chore(secrets): register ${e.added.join(', ')} in ${secretName}`,
          e.content,
          e.sha,
        );
      }
      const body = prBody({
        secretName,
        requestId,
        keys: allAdded,
        files: edits.map((e) => e.path),
        slug: this.slug,
        requesterName: opts.requesterName,
        requesterEmail: opts.requesterEmail,
      });
      pr = await this.createDraftPull(
        branch,
        `[Hermes] chore(secrets): register ${allAdded.length} key(s) in ${secretName}`,
        body,
      );
    } catch (err: any) {
      // A concurrent caller (the submit/review race, above) may have won between our
      // findOpenPullByBranch check and this write — a 409 (stale content SHA) or 422 (PR already
      // exists for this head) both mean "someone else already did this". Adopt their PR
      // instead of failing the whole listener. GitHub only rejects a create-PR with 422 when an
      // OPEN PR already holds the head, so the open-only lookup is the right one here too.
      const status = err.response?.status;
      if (status === 409 || status === 422) {
        const racedPr = await this.findOpenPullByBranch(branch);
        if (racedPr) {
          logger.warn(
            { requestId, secretName, pr: racedPr.number, status },
            "infra-repo-sync: lost a concurrent open race — adopting the winner's PR",
          );
          return {
            state: 'OPEN',
            prNumber: racedPr.number,
            prUrl: racedPr.url,
            prNodeId: racedPr.nodeId,
            branch,
            filesChanged: [],
            keysAdded: allAdded,
            note: 'PR already open for this request (concurrent open detected)',
          };
        }
      }
      throw err;
    }

    logger.info(
      { requestId, secretName, pr: pr.number, files: edits.length },
      'Opened infra-deployment draft PR',
    );
    return {
      state: 'OPEN',
      prNumber: pr.number,
      prUrl: pr.url,
      prNodeId: pr.nodeId,
      branch,
      filesChanged: edits.map((e) => e.path),
      keysAdded: allAdded,
      note:
        unmatchedPaths.length > 0
          ? `${unmatchedPaths.length} manifest(s) could not be auto-edited (unrecognized structure): ${unmatchedPaths.join(', ')}`
          : undefined,
    };
  }

  /**
   * Shared pre-finalize phase of mergePrForRequest / readyPrForRequest: rewrites `infraBranch`
   * so its ONLY diff from the live base is the approved keys. Returns `{ done: <result> }` when
   * the caller should stop and persist that result (no PR, nothing approved, nothing left to
   * land); otherwise the branch is correct and committed and the caller finalizes it.
   *
   * Resetting to base rather than surgically un-editing rejected keys also fixes a second
   * problem: the branch was cut from base at open time, so if another request's PR landed keys
   * in the same manifest region since, the stale merge-base makes GitHub flag this PR as
   * conflicting and refuse to auto-merge — recomputing the file bytes alone does NOT clear that
   * (git conflicts on the overlapping insertion, not on the final content). Force-resetting the
   * head to the live base commit makes the approved keys its only diff. The per-consumer reads
   * below then see branch == base, and re-apply the keys on top.
   */
  private async prepareApprovedBranch(opts: {
    request: {
      id: string;
      secretName: string;
      infraPrNumber: number | null;
      infraBranch: string | null;
    };
    approvedKeys: string[];
    targets?: SelectedTarget[];
    // Supplied by the ingestion review paths, which know what the reviewer decided: rewrites the
    // PR title/body to describe what the branch now actually registers (see reviewedPrBody).
    // Omitted by the drift path — a drift PR was never reviewed, so its body is already accurate
    // and must be left alone.
    review?: {
      rejectedKeys: string[];
      requesterName?: string;
      requesterEmail?: string;
      reviewerName?: string;
    };
  }): Promise<
    { done: InfraSyncResult } | { done: null; prNumber: number; unmatchedPaths: string[] }
  > {
    const { request, approvedKeys } = opts;
    if (!request.infraPrNumber || !request.infraBranch) {
      return {
        done: { state: 'SKIPPED', note: 'no open infra PR for this request' },
      };
    }
    const prNumber = request.infraPrNumber;
    if (approvedKeys.length === 0) {
      // Nothing approved — treat as a close (caller normally routes REJECTED to closePr).
      await this.closePull(prNumber);
      return {
        done: { state: 'CLOSED', prNumber, note: 'no approved keys' },
      };
    }

    const branch = request.infraBranch;
    // NOTE: the branch is deliberately NOT reset to base here. Re-parenting it onto current base
    // is still the goal (see resetBranchToSha's docstring — it keeps the merge-base fresh so an
    // earlier PR that landed keys in the same region can't conflict), but doing it as a separate
    // step leaves the PR at zero commits until the writes land, and GitHub closes it in that gap.
    // The branch is moved exactly once, below, straight onto a commit that already contains the
    // approved keys — same merge-base, no window.
    const currentBaseSha = await this.getBaseCommitSha();
    const consumers = await this.targetConsumers(request.secretName, opts.targets);
    // Reads and edits are independent per file — parallelize across consumers. They only
    // compute the desired bytes; the single commit that applies them is built below.
    const perConsumer = await mapWithConcurrency(consumers, 6, async (c) => {
      // Read at the PINNED base commit, not the moving `baseBranch` ref: this is the exact
      // commit the new commit will be parented on, so it is the content the recompute must be
      // based on. A commit SHA is immutable, so unlike a ref it cannot drift mid-flight if base
      // advances while this runs.
      const base = await this.getContent(c.path, currentBaseSha);
      if (!base) {
        return {
          changed: false,
          unmatched: false,
          path: c.path,
          content: null,
        };
      }
      // A per-file key subset further narrows the (already-approved) keys applied here —
      // e.g. the requester chose this file for key A only, even though B was also approved.
      const keysForFile = c.keys ? c.keys.filter((k) => approvedKeys.includes(k)) : approvedKeys;
      const res = editForFile(c.path, base.content, c.manifestRef, keysForFile);
      const desired = res.status === 'edited' ? res.content : base.content;
      if (res.status === 'unmatched') {
        logger.warn(
          {
            requestId: request.id,
            secretName: request.secretName,
            path: c.path,
          },
          'infra-repo-sync: manifest structure not found during recompute — key not registered in this file',
        );
      }
      return {
        changed: res.status === 'edited',
        unmatched: res.status === 'unmatched',
        path: c.path,
        content: base.content !== desired ? desired : null,
      };
    });

    // One commit, one ref move. Nothing above this line has touched the branch, so if any read
    // or edit threw, the PR still holds its previous commits and stays open — the recompute is
    // simply retryable. See commitFilesOnBase.
    const pending = perConsumer
      .filter((r): r is typeof r & { content: string } => r.content !== null)
      .map((r) => ({ path: r.path, content: r.content }));
    if (pending.length > 0) {
      const commitSha = await this.commitFilesOnBase(
        currentBaseSha,
        `chore(secrets): sync approved keys for ${request.secretName}`,
        pending,
      );
      await this.resetBranchToSha(branch, commitSha);
    }

    const changedAny = perConsumer.some((r) => r.changed);
    const unmatchedPaths = perConsumer.filter((r) => r.unmatched).map((r) => r.path);

    if (!changedAny) {
      // Same distinction as openPrForRequest: don't tell the reviewer/PR "already present"
      // when the real reason is an unrecognized manifest shape that was never actually edited.
      const closeNote =
        unmatchedPaths.length > 0
          ? `Hermes: could not automatically register the approved key(s) — ${unmatchedPaths.length} manifest(s) had an unrecognized structure: ${unmatchedPaths.join(', ')}. Register them manually; closing this PR.`
          : 'Hermes: approved keys are already present on the base branch — closing as obsolete.';
      await this.comment(prNumber, closeNote);
      await this.closePull(prNumber);
      return {
        done: {
          state: 'CLOSED',
          prNumber,
          note:
            unmatchedPaths.length > 0
              ? `approved keys could not be auto-registered (unrecognized structure): ${unmatchedPaths.join(', ')}`
              : 'approved keys already on base',
        },
      };
    }
    // The branch now holds exactly the approved keys — so this is the moment the submit-time
    // title/body ("register 4 key(s)", "Keys: A, B, C, D") becomes a lie. Correct it here, the
    // one place both the merge and manual paths pass through. Best-effort: the diff is already
    // right without it, so a GitHub hiccup here must not fail the review.
    if (opts.review) {
      const changedPaths = perConsumer.filter((r) => r.changed).map((r) => r.path);
      await this.updatePull(prNumber, {
        title: `[Hermes] chore(secrets): register ${approvedKeys.length} key(s) in ${request.secretName}`,
        body: reviewedPrBody({
          secretName: request.secretName,
          requestId: request.id,
          approvedKeys,
          rejectedKeys: opts.review.rejectedKeys,
          files: changedPaths,
          requesterName: opts.review.requesterName,
          requesterEmail: opts.review.requesterEmail,
          reviewerName: opts.review.reviewerName,
        }),
      }).catch((err: any) => {
        logger.warn(
          { requestId: request.id, pr: prNumber, err: err.message },
          'infra-repo-sync: could not rewrite reviewed PR title/body — the diff is still correct, but the description may still list rejected keys',
        );
      });
    }

    return { done: null, prNumber, unmatchedPaths };
  }

  /**
   * Recomputes the branch to hold ONLY the approved keys (from the latest base — so
   * rejected keys are dropped and concurrent merges can't conflict), marks the draft
   * ready, and squash-merges. If, after recompute, nothing differs from base (the keys
   * already landed some other way), the PR is closed as obsolete instead.
   */
  async mergePrForRequest(opts: {
    request: {
      id: string;
      secretName: string;
      infraPrNumber: number | null;
      infraPrNodeId: string | null;
      infraBranch: string | null;
    };
    approvedKeys: string[];
    targets?: SelectedTarget[];
    // The subset of approvedKeys that are genuinely NEW (the ones the PR exists for) —
    // an UPDATE key's value changes in AWS but needs no manifest edit. Live mode ignores
    // this and recomputes from the real file instead (more reliable); simulation has no
    // file to diff against, so it relies on this to decide merge vs. close.
    newApprovedKeys?: string[];
    // See prepareApprovedBranch: rewrites the stale submit-time title/body. Matters here too —
    // when a protected branch blocks the auto-merge, this PR is handed to a human exactly like
    // the manual path, stale description and all.
    review?: {
      rejectedKeys: string[];
      requesterName?: string;
      requesterEmail?: string;
      reviewerName?: string;
    };
  }): Promise<InfraSyncResult> {
    const { request } = opts;
    const approvedKeys = [...new Set(opts.approvedKeys.map((k) => k.trim()).filter(Boolean))];

    if (this.isSimulation) {
      const newKeys = [
        ...new Set((opts.newApprovedKeys ?? approvedKeys).map((k) => k.trim()).filter(Boolean)),
      ];
      if (newKeys.length === 0) {
        // Every genuinely-new key was rejected (or there were none) — nothing for this PR
        // to merge, so it must close instead of merging an update-only change.
        return {
          state: 'CLOSED',
          prNumber: request.infraPrNumber,
          note: 'no new keys were approved — closing (simulation)',
        };
      }
      return {
        state: 'MERGED',
        prNumber: request.infraPrNumber,
        keysAdded: newKeys,
        note: 'simulation (no GitHub calls)',
      };
    }
    const prep = await this.prepareApprovedBranch({
      request,
      approvedKeys,
      targets: opts.targets,
      review: opts.review,
    });
    if (prep.done) {
      return prep.done;
    }
    const { prNumber, unmatchedPaths } = prep;

    // The content is now correct and committed on the branch — everything past this point
    // is "finalize" (ready-for-review + merge). A failure here (e.g. branch protection
    // blocking the merge with a 405) must NOT throw: the caller awaits this method and
    // passes its return value straight to persistInfraResult, so an uncaught throw here
    // means the DB row silently keeps its stale (pre-merge-attempt) state forever — the
    // exact bug this FAILED branch exists to close. Report FAILED instead so the caller
    // always has something to persist, and leave a breadcrumb on the PR for a human.
    try {
      try {
        await this.reopenPull(prNumber);
      } catch (reopenErr: any) {
        logger.info(
          { pr: prNumber, err: reopenErr.message },
          'Failed to reopen PR (already open, merged, or permission issue) — proceeding to merge anyway',
        );
      }
      if (request.infraPrNodeId) {
        await this.markReady(request.infraPrNodeId);
      }
      await this.mergePull(
        prNumber,
        `[Hermes] chore(secrets): register keys in ${request.secretName}`,
      );
    } catch (err: any) {
      const note = err.message || 'merge failed';
      logger.error(
        { requestId: request.id, pr: prNumber, err: note },
        'Failed to finalize infra-deployment PR',
      );
      await this.comment(
        prNumber,
        `Hermes: automatic merge failed — \`${note}\`. The branch is up to date with the approved keys; merge manually or re-run review once the blocker is resolved.`,
      ).catch(() => {});
      return { state: 'FAILED', prNumber, note };
    }
    logger.info({ requestId: request.id, pr: prNumber }, 'Merged infra-deployment PR');
    return {
      state: 'MERGED',
      prNumber,
      keysAdded: approvedKeys,
      note:
        unmatchedPaths.length > 0
          ? `${unmatchedPaths.length} manifest(s) could not be auto-edited (unrecognized structure): ${unmatchedPaths.join(', ')}`
          : undefined,
    };
  }

  /**
   * Manual-review counterpart to mergePrForRequest, used when auto-merge is OFF (the default):
   * recomputes the branch to hold ONLY the approved keys, marks the draft ready for review, and
   * leaves the merge to a human on GitHub.
   *
   * The recompute is the whole point. The branch was opened at SUBMIT time and holds every key
   * the requester proposed; by review time some of those may have been rejected. Only the
   * approved ones are written to AWS, so without this pass the PR a reviewer sees (and merges)
   * would still register the rejected keys in the manifests — keys that exist in no secret
   * store. Marking the PR ready without recomputing is exactly that bug.
   */
  async readyPrForRequest(opts: {
    request: {
      id: string;
      secretName: string;
      infraPrNumber: number | null;
      infraPrNodeId: string | null;
      infraBranch: string | null;
    };
    approvedKeys: string[];
    targets?: SelectedTarget[];
    // See prepareApprovedBranch. Most load-bearing on this path: the human who merges this PR
    // reads its description, and if they hit a conflict they hand-type keys out of it.
    review?: {
      rejectedKeys: string[];
      requesterName?: string;
      requesterEmail?: string;
      reviewerName?: string;
    };
  }): Promise<InfraSyncResult> {
    const { request } = opts;
    const approvedKeys = [...new Set(opts.approvedKeys.map((k) => k.trim()).filter(Boolean))];

    if (this.isSimulation) {
      // Mirrors prepareApprovedBranch's live guard: nothing approved ⇒ nothing for this PR to
      // register. Defensive — an all-rejected request is routed to closePrForRequest instead.
      if (approvedKeys.length === 0) {
        return {
          state: 'CLOSED',
          prNumber: request.infraPrNumber,
          note: 'no approved keys',
        };
      }
      // Deliberately does NOT copy mergePrForRequest's "close when no approved key is new to
      // AWS" rule. That rule conflates "AWS already holds this key" with "a manifest already
      // registers it" — different things, which is the whole reason drift detection reports
      // keys that exist in AWS but no manifest lists. Live mode decides from the real file, so
      // an approved key AWS already holds still keeps this PR open while the manifest lacks it;
      // simulation has no file to check. A human reviews this PR either way, so when we can't
      // tell, hand it to them (OPEN) rather than destroy it (CLOSED) — closing on that proxy
      // silently binned PRs that had a genuinely approved key to register.
      return {
        state: 'OPEN',
        prNumber: request.infraPrNumber,
        keysAdded: approvedKeys,
        note: 'ready for review — merge manually (simulation)',
      };
    }

    const prep = await this.prepareApprovedBranch({
      request,
      approvedKeys,
      targets: opts.targets,
      review: opts.review,
    });
    if (prep.done) {
      return prep.done;
    }
    const { prNumber, unmatchedPaths } = prep;

    // prepareApprovedBranch force-resets the branch to base before rewriting it, which leaves the
    // PR holding zero commits for a moment — GitHub closes a PR the instant its head stops being
    // ahead of base, and committing the branch back afterwards does NOT reopen it. So the PR ends
    // up closed with no Hermes comment on it, since nothing in this code closed it. mergePrForRequest
    // has always reopened here for exactly this reason; this path never did, which is why the
    // manual (default) flow silently binned its own PR. Must precede markReady — a closed PR
    // cannot be flipped out of draft. Best-effort, matching mergePrForRequest: an already-open
    // PR makes this a no-op error, and the branch content is correct either way.
    try {
      await this.reopenPull(prNumber);
    } catch (reopenErr: any) {
      logger.info(
        { pr: prNumber, err: reopenErr.message },
        'Failed to reopen PR (already open, merged, or permission issue) — proceeding anyway',
      );
    }

    // prepareApprovedBranch has rewritten the title/body to match the approved keys; this marks
    // the review in the PR's timeline (and notifies watchers), which a body edit does not.
    // Deliberately does not claim the description was updated — that rewrite is best-effort, so
    // this line has to stay true even if it failed. Best-effort itself: the diff is correct
    // regardless, so a failed comment must not block the ready flip.
    const approvedList = approvedKeys.map((k) => `\`${k}\``).join(', ');
    await this.comment(
      prNumber,
      `Hermes: request reviewed — this PR now registers **only the approved key(s)**: ${approvedList}. Any rejected key has been dropped from the branch. Ready for review.`,
    ).catch(() => {});

    // Content is correct on the branch; only the draft → ready flip is left. Same rule as
    // mergePrForRequest's finalize: never throw, because the caller persists whatever we
    // return — a throw would strand the row on its stale pre-review state. FAILED surfaces
    // it in the review queue with a Retry action instead.
    try {
      if (request.infraPrNodeId) {
        await this.markReady(request.infraPrNodeId);
      }
    } catch (err: any) {
      const note = err.message || 'failed to mark PR ready for review';
      logger.error(
        { requestId: request.id, pr: prNumber, err: note },
        'Failed to mark infra-deployment PR ready for review',
      );
      return { state: 'FAILED', prNumber, note };
    }

    logger.info(
      { requestId: request.id, pr: prNumber, keys: approvedKeys.length },
      'infra-deployment PR recomputed to approved keys and marked ready for review',
    );
    return {
      state: 'OPEN',
      prNumber,
      keysAdded: approvedKeys,
      note:
        unmatchedPaths.length > 0
          ? `ready for review — merge manually. ${unmatchedPaths.length} manifest(s) could not be auto-edited (unrecognized structure): ${unmatchedPaths.join(', ')}`
          : 'ready for review — merge the PR to register the approved key(s)',
    };
  }

  /**
   * Merges the drift-reconciliation PR for a secret (the deterministic `requestId: 'drift'`
   * branch opened by resolveDrift/openPrForRequest). Unlike the ingestion-request merge path,
   * there's no DB row carrying the PR number/branch for a drift PR, so this looks it up live by
   * branch name first. `missingKeys` should be freshly recomputed (not cached from the original
   * scan) so a merge some time after "Solve drift" still applies whatever is *currently* missing.
   */
  async mergeDriftPr(secretName: string, missingKeys: string[]): Promise<InfraSyncResult> {
    const branch = this.branchName(secretName, 'drift');
    if (this.isSimulation) {
      if (missingKeys.length === 0) {
        return {
          state: 'SKIPPED',
          branch,
          note: 'no missing keys to merge (simulation)',
        };
      }
      return {
        state: 'MERGED',
        prNumber: simPrNumber('drift'),
        prUrl: `https://github.com/${this.slug}/pull/${simPrNumber('drift')}`,
        branch,
        keysAdded: missingKeys,
        note: 'simulation (no GitHub calls)',
      };
    }
    const pr = await this.findOpenPullByBranch(branch);
    if (!pr) {
      return {
        state: 'SKIPPED',
        branch,
        note: 'No open drift PR found for this secret — click "Solve drift" first.',
      };
    }
    const result = await this.mergePrForRequest({
      request: {
        id: 'drift',
        secretName,
        infraPrNumber: pr.number,
        infraPrNodeId: pr.nodeId,
        infraBranch: branch,
      },
      approvedKeys: missingKeys,
      newApprovedKeys: missingKeys,
    });
    return { ...result, prUrl: result.prUrl ?? pr.url };
  }

  async closePrForRequest(opts: {
    request: { infraPrNumber: number | null };
    reason: string;
  }): Promise<InfraSyncResult> {
    const { request, reason } = opts;
    if (this.isSimulation) {
      return {
        state: 'CLOSED',
        prNumber: request.infraPrNumber,
        note: 'simulation (no GitHub calls)',
      };
    }
    if (!request.infraPrNumber) {
      return { state: 'SKIPPED', note: 'no infra PR to close' };
    }
    await this.comment(
      request.infraPrNumber,
      `Hermes: request rejected — ${reason}. Closing this PR.`,
    );
    await this.closePull(request.infraPrNumber);
    return { state: 'CLOSED', prNumber: request.infraPrNumber };
  }

  /** Retryable apply failure — keep the draft PR open, leave a breadcrumb. */
  async notePrFailure(opts: {
    request: { infraPrNumber: number | null };
    error: string;
  }): Promise<InfraSyncResult> {
    const { request, error } = opts;
    if (this.isSimulation) {
      return {
        state: 'OPEN',
        prNumber: request.infraPrNumber,
        note: 'simulation (no GitHub calls)',
      };
    }
    if (!request.infraPrNumber) {
      return { state: 'SKIPPED', note: 'no infra PR' };
    }
    await this.comment(
      request.infraPrNumber,
      `Hermes: applying to AWS failed (\`${error}\`). This PR stays open for retry — it will merge once a re-review succeeds.`,
    );
    return {
      state: 'OPEN',
      prNumber: request.infraPrNumber,
      note: 'apply failed; PR kept open for retry',
    };
  }

  /**
   * Fetches the state of a PR from GitHub live.
   * Returns 'MERGED', 'CLOSED' (closed but not merged), or 'OPEN'.
   */
  async getPrState(prNumber: number): Promise<'OPEN' | 'MERGED' | 'CLOSED' | null> {
    if (this.isSimulation) {
      // In simulation, we fake the PR being merged.
      return 'MERGED';
    }
    try {
      const res = await this.gh().get(this.repoPath(`/pulls/${prNumber}`));
      const pr = res.data;
      if (!pr) {
        return null;
      }
      if (pr.merged) {
        return 'MERGED';
      }
      if (pr.state === 'closed') {
        return 'CLOSED';
      }
      return 'OPEN';
    } catch (err: any) {
      logger.warn({ prNumber, err: err.message }, 'infra-repo-sync: failed to fetch PR status');
      return null;
    }
  }
}

// Canonical manifest scan: every enumerated secret name a file references, name-carrying
// (unlike referencedEnumeratedSecrets, which projects this onto {path, mech} for the
// Consumer[] shape the consumer index uses). Used by refreshIndex() and, via the wrapper
// above, by referencedEnumeratedSecrets — kept as the single implementation.
function namedSecretsInFile(path: string, content: string): { name: string; mech: Mechanism }[] {
  const lines = content.split(/\r?\n/);
  const out: { name: string; mech: Mechanism }[] = [];
  const seen = new Set<string>();

  if (isValuesFile(path)) {
    for (const ln of lines) {
      const m = ln.match(/^\s*-?\s*awsSecretName:\s*(.+?)\s*$/);
      if (m) {
        const name = stripQuotes(m[1]);
        if (name && !seen.has(name)) {
          seen.add(name);
          out.push({ name, mech: 'helm-values' });
        }
      }
    }
    return out;
  }

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)-?\s*objectName:\s*(.+?)\s*$/);
    if (!m) {
      continue;
    }
    const base = indentOf(lines[i]);
    let hasJmes = false;
    for (let j = i + 1; j < lines.length; j++) {
      const ln = lines[j];
      if (/^\s*$/.test(ln) || /^\s*#/.test(ln)) {
        continue;
      }
      if (indentOf(ln) <= base) {
        break;
      }
      if (/^\s*jmesPath:/.test(ln)) {
        hasJmes = true;
        break;
      }
    }
    const name = stripQuotes(m[2]);
    if (hasJmes && name && !seen.has(name)) {
      seen.add(name);
      out.push({ name, mech: 'spc' });
    }
  }
  return out;
}

function simPrNumber(requestId: string): number {
  let h = 0;
  for (let i = 0; i < requestId.length; i++) {
    h = (h * 31 + requestId.charCodeAt(i)) & 0x7fffffff;
  }
  return (h % 9000) + 1000;
}

function prBody(o: {
  secretName: string;
  requestId: string;
  keys: string[];
  files: string[];
  slug: string;
  requesterName?: string;
  requesterEmail?: string;
}): string {
  const lines = [
    `Registers new key name(s) for the AWS secret \`${o.secretName}\` so the Secrets CSI driver syncs them into the workloads.`,
    '',
    `**Keys:** ${o.keys.map((k) => `\`${k}\``).join(', ')}`,
  ];
  if (o.requesterName) {
    const emailStr = o.requesterEmail ? ` (${o.requesterEmail})` : '';
    lines.push('', `**Requested by:** ${o.requesterName}${emailStr}`);
  }
  lines.push(
    '',
    '**Files updated:**',
    ...o.files.map((f) => `- \`${f}\``),
    '',
    '---',
    `Opened by Hermes Secret Ingestion (request \`${o.requestId}\`). Managed automatically — this draft is marked ready when the request is approved, and closed if it is rejected. It can be merged manually.`,
  );
  return lines.join('\n');
}

/**
 * Body for a PR whose request has been REVIEWED, replacing the submit-time body built by
 * prBody(). That original body lists every key the requester PROPOSED, because it is written
 * before anyone reviews anything — but by now the branch has been recomputed down to the
 * approved subset, so the two disagree.
 *
 * Normally harmless (merging takes the diff, not the description), but it turns dangerous in
 * the one case where a human types keys out by hand: resolving a merge conflict. Their source
 * of truth for "what belongs in this file" is this body, so a stale list is exactly how a
 * rejected key gets manually re-added — the bug the approved-key recompute exists to prevent.
 * Naming the rejected keys explicitly turns that trap into a guard rail.
 */
function reviewedPrBody(o: {
  secretName: string;
  requestId: string;
  approvedKeys: string[];
  rejectedKeys: string[];
  files: string[];
  requesterName?: string;
  requesterEmail?: string;
  reviewerName?: string;
}): string {
  const fmt = (keys: string[]) => keys.map((k) => `\`${k}\``).join(', ');
  const lines = [
    `Registers the **approved** key name(s) for the AWS secret \`${o.secretName}\` so the Secrets CSI driver syncs them into the workloads.`,
    '',
    `**Approved — registered by this PR:** ${fmt(o.approvedKeys)}`,
  ];
  if (o.rejectedKeys.length > 0) {
    lines.push(
      '',
      `**Rejected at review — deliberately NOT registered:** ${fmt(o.rejectedKeys)}`,
      '',
      '⚠ The rejected keys above were never written to AWS. Do not add them back while resolving a merge conflict — registering a key that has no value in AWS breaks the secret sync for this workload.',
    );
  }
  if (o.requesterName) {
    const emailStr = o.requesterEmail ? ` (${o.requesterEmail})` : '';
    lines.push('', `**Requested by:** ${o.requesterName}${emailStr}`);
  }
  if (o.reviewerName) {
    lines.push('', `**Approved by:** ${o.reviewerName}`);
  }
  lines.push(
    '',
    '**Files updated:**',
    ...o.files.map((f) => `- \`${f}\``),
    '',
    '---',
    `Opened by Hermes Secret Ingestion (request \`${o.requestId}\`) and rewritten after review to match what this branch actually registers.`,
  );
  return lines.join('\n');
}

// Back-compat singleton: the prod ("secrets") infra-deployment repo (config.infraRepo).
export const infraRepoSyncService = new InfraRepoSyncService();
export default infraRepoSyncService;

/**
 * Memoized per-instance registry. Each Secret Ingestion instance (prod "secrets", sandbox
 * "secrets-sandbox") mirrors approved keys into its OWN infra-deployment repo, so each gets its
 * own {@link InfraRepoSyncService} (own GitHub client / consumer index). The prod instance is the
 * singleton above, so callers resolve to the same object.
 */
const infraServices = new Map<string, InfraRepoSyncService>([['secrets', infraRepoSyncService]]);

export function getInfraRepoSyncService(platform: string): InfraRepoSyncService {
  const key = (platform || 'secrets').toLowerCase();
  const cached = infraServices.get(key);
  if (cached) {
    return cached;
  }
  const instance = config.secretsInstances.find((i) => i.key === key);
  // Mirrors getSecretsManagerService's guard: an unrecognized platform must fail loudly, not
  // silently build a service pointed at PROD's own infra-deployment repo/credentials. Current
  // callers already gate on isInfraRepoEnabled(key) first, but this function must not rely on
  // that discipline alone — a future/typo'd caller must not risk mirroring a sandbox secret's
  // key registration into the prod repo.
  if (!instance) {
    throw new ExternalServiceError(
      `No Secret Ingestion instance is configured for platform "${platform}".`,
    );
  }
  const svc = new InfraRepoSyncService(instance.infraRepo);
  infraServices.set(key, svc);
  return svc;
}

/**
 * Whether the infra-deployment PR flow runs for a given Secret Ingestion instance. Prod is always
 * on (simulated in dev, live in prod); the sandbox is off until its repo is configured — see
 * config.secretsInstances[*].infraEnabled. A disabled instance writes to AWS only, opening no PR.
 */
export function isInfraRepoEnabled(platform: string): boolean {
  const instance = config.secretsInstances.find((i) => i.key === (platform || '').toLowerCase());
  return !!instance?.infraEnabled;
}

/**
 * Whether auto-merge is enabled for a given Secret Ingestion instance's infra-deployment PRs.
 * When true, both the ingestion-approval and drift-resolve flows merge the PR automatically the
 * moment it's ready. When false (default), the PR is opened and left for a human to review and
 * merge manually on GitHub. Controlled by INFRA_REPO_AUTO_MERGE / SECRETS_SANDBOX_INFRA_REPO_AUTO_MERGE.
 */
export function isInfraAutoMergeEnabled(platform: string): boolean {
  const instance = config.secretsInstances.find((i) => i.key === (platform || '').toLowerCase());
  return !!instance?.infraRepo?.autoMergeEnabled;
}
