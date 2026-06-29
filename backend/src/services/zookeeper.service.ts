import crypto from 'crypto';
import { createClient, ACL, Id, Permission, Exception, type Client } from 'node-zookeeper-client';
import config from '../config/config';
import logger from '../utils/logger';
import { ExternalServiceError, ValidationError } from '../utils/errors';

/**
 * Low-level client for Apache ZooKeeper access control — the ZK analogue of
 * {@link ../services/aws-identity-center.service aws-identity-center.service} and
 * {@link ../services/redash.service redash.service}: it owns every ZooKeeper call
 * and the simulation branch, so the adapter ({@link ./zookeeper.provisioner})
 * stays a thin, platform-agnostic translation layer.
 *
 * ZooKeeper has no users or groups. Access is a per-znode **ACL** of entries
 * `scheme:id:permissions` (perms = c/d/r/w/a → CREATE/DELETE/READ/WRITE/ADMIN).
 * Hermes models access with the `digest` scheme:
 *  - A user's identity is a digest credential `user:password`. The znode ACL stores
 *    only the id `"<user>:<base64(sha1(user:password))>"` — the plaintext password is
 *    handed to the user once and never persisted (ZK keeps only the hash).
 *  - A Hermes group is a znode path; a level is `"<path>#<perms>"` (e.g.
 *    `/hermes/credit-card#r` read-only vs `/hermes/credit-card#cdrw` read-write) —
 *    same node, different permission bits, exactly how ZK models read vs write.
 *
 * `setACL` **replaces** a node's whole ACL (there is no "add one entry" primitive),
 * so every grant/revoke is a read-modify-write. {@link addAclEntry}/{@link removeAclEntry}
 * serialize per path via {@link withPathLock} so concurrent grants on one znode can't
 * clobber each other (the same hazard Redash's `withUserLock` guards).
 *
 * Simulation-first: with `ZOOKEEPER_SIMULATION=true` (also implied when no connect
 * string is set) all calls hit an in-process store so the full grant/revoke/expire
 * flow is exercised without a real ensemble. With a connect string and the flag off,
 * the same methods drive a real ZooKeeper through the live `node-zookeeper-client`
 * branches below: Hermes authenticates with the admin digest (`ZOOKEEPER_ADMIN_AUTH`)
 * and keeps an ADMIN-all entry for itself on every managed znode (injected in
 * {@link mutateAcl}) so a `setACL` can never strip Hermes' own access.
 */

/** Canonical permission letter order (matches `zkCli` ACL strings). */
export const PERM_ORDER = ['c', 'd', 'r', 'w', 'a'] as const;
const PERM_BITS: Record<string, number> = { r: 1, w: 2, c: 4, d: 8, a: 16 };

/** Max attempts for a version-guarded ACL read-modify-write before giving up (BAD_VERSION
 *  retries: another writer committed between our read and write — re-read and re-apply). */
const MAX_ACL_WRITE_ATTEMPTS = 5;

/** A single ACL entry on a znode. */
export interface ZkAclEntry {
  scheme: string; // 'digest' for Hermes-managed entries
  id: string; // digest id: "<user>:<base64hash>"
  perms: string; // canonical permission letters, e.g. "cdrw"
  /** Numeric ZK permission bitmask for the letters above (convenience for callers/tests). */
  mask: number;
}

/** A minted digest credential. The password is shown to the user once, never stored. */
export interface ZkCredential {
  username: string;
  password: string;
  /** The ACL id (`"<user>:<base64hash>"`) Hermes stores as the user's externalUserId. */
  aclId: string;
}

/** Normalize a permission string to canonical c/d/r/w/a order, dropping unknown chars. */
export function normalizePerms(perms: string): string {
  const set = new Set((perms || '').toLowerCase().split(''));
  const out = PERM_ORDER.filter((p) => set.has(p));
  return out.join('') || 'r'; // default to read if nothing valid was supplied
}

function permsToMask(perms: string): number {
  return perms.split('').reduce((acc, p) => acc | (PERM_BITS[p] ?? 0), 0);
}

/** Inverse of {@link permsToMask}: a ZK permission bitmask → canonical c/d/r/w/a letters. */
function maskToPerms(mask: number): string {
  return PERM_ORDER.filter((p) => (mask & PERM_BITS[p]) !== 0).join('');
}

// ── Simulation store ──────────────────────────────────────────────────────────
// In-process, stateful mock of the znode tree (path → ACL). Coherent within a
// running backend (create node → add entry → read → remove all agree) and resets on
// restart, exactly like the Redash/AWS sims. No users are seeded — every ZK identity
// is minted by Hermes, so there are no pre-existing accounts to mock.

interface SimNode {
  acl: ZkAclEntry[];
  /** The znode's data payload (config management). Absent ⇒ the node has no data. */
  data?: Buffer;
}

const sim = {
  nodes: new Map<string, SimNode>(), // path → node
};

/** A microtask yield so the sim's read-modify-write has a real async gap (makes the
 *  per-path lock meaningful: two unlocked concurrent RMWs would clobber here). */
function tick(): Promise<void> {
  return Promise.resolve();
}

export class ZookeeperService {
  /**
   * Per-path serialization for ACL mutations. `setACL` replaces the whole ACL, so two
   * concurrent grants on the same znode read the same base and the second write would
   * drop the first's entry (lost update). We chain same-path mutations so each observes
   * the previous one's committed ACL. In-process only (Hermes runs single-instance);
   * keyed by path so different znodes still mutate in parallel. Mirrors
   * {@link RedashService.withUserLock}.
   */
  private pathChains = new Map<string, Promise<unknown>>();

  /** Cached live client + in-flight connect (live mode only). Lazily established on
   *  first use and reused; dropped on session expiry so the next call reconnects. */
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;

  private get isSimulation(): boolean {
    return config.zookeeper.isSimulation;
  }

  /** Run `task` only after any in-flight mutation for the same path has settled. */
  private withPathLock<T>(path: string, task: () => Promise<T>): Promise<T> {
    const prev = this.pathChains.get(path) ?? Promise.resolve();
    const run = prev.then(task, task);
    const tail = run.catch(() => {});
    this.pathChains.set(path, tail);
    void tail.then(() => {
      if (this.pathChains.get(path) === tail) this.pathChains.delete(path);
    });
    return run;
  }

  // ── Live client (node-zookeeper-client) ─────────────────────────────────────────
  // Only exercised when !isSimulation. Hermes authenticates as the admin digest and
  // keeps an ADMIN-all ACL entry for that identity on every managed znode (injected in
  // mutateAcl) so a setACL can never strip Hermes' own access.

  /** Parse `ZOOKEEPER_ADMIN_AUTH` ("user:password") into its parts (throws if unset). */
  private adminParts(): { user: string; password: string } {
    const raw = config.zookeeper.adminAuth || '';
    const idx = raw.indexOf(':');
    const user = idx >= 0 ? raw.slice(0, idx) : '';
    const password = idx >= 0 ? raw.slice(idx + 1) : '';
    if (!user || !password) {
      throw new ExternalServiceError(
        'ZOOKEEPER_ADMIN_AUTH must be set as "user:password" to manage ZooKeeper ACLs in live mode.',
      );
    }
    return { user, password };
  }

  /** The digest ACL id Hermes authenticates as: "<user>:<base64(sha1(user:password))>". */
  private adminAclId(): string {
    const { user, password } = this.adminParts();
    const hash = crypto.createHash('sha1').update(`${user}:${password}`, 'utf8').digest('base64');
    return `${user}:${hash}`;
  }

  /** A ZK ACL granting the admin identity ALL permissions (prepended to every write). */
  private adminAcl(): ACL {
    return new ACL(Permission.ALL, new Id('digest', this.adminAclId()));
  }

  /** A ZK ACL granting world-open access (world:anyone:cdrwa). */
  private worldOpenAcl(): ACL {
    return new ACL(Permission.ALL, new Id('world', 'anyone'));
  }

  /** Lazily connect (and authenticate) a live client, reusing a healthy one. */
  private getClient(): Promise<Client> {
    // Reuse the cached client whenever one exists. connect() assigns this.client only on
    // a successful 'connected' event, and the 'expired' handler nulls it on session death,
    // so a non-null client is one that connected and hasn't expired — including when it is
    // briefly DISCONNECTED/CONNECTING (node-zookeeper-client auto-reconnects and queues
    // operations meanwhile). Gating on SYNC_CONNECTED instead would spin up a SECOND client
    // on every transient blip and leak the first's session.
    if (this.client) {
      return Promise.resolve(this.client);
    }
    if (this.connecting) return this.connecting;
    this.connecting = this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private connect(): Promise<Client> {
    const connectString = config.zookeeper.connectString;
    if (!connectString) {
      throw new ExternalServiceError('ZOOKEEPER_CONNECT_STRING is not configured (cannot use live ZooKeeper).');
    }
    const { user, password } = this.adminParts();
    return new Promise<Client>((resolve, reject) => {
      const client = createClient(connectString, { sessionTimeout: 30000, spinDelay: 1000, retries: 2 });
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          client.close();
        } catch {
          /* already closing */
        }
        reject(new ExternalServiceError(`Timed out connecting to ZooKeeper at ${connectString}.`));
      }, 15000);
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      client.once('connected', () =>
        finish(() => {
          this.client = client;
          logger.info({ connectString }, 'ZooKeeper client connected');
          resolve(client);
        }),
      );
      client.once('authenticationFailed', () =>
        finish(() => {
          try {
            client.close();
          } catch {
            /* already closing */
          }
          reject(new ExternalServiceError('ZooKeeper authentication failed (check ZOOKEEPER_ADMIN_AUTH).'));
        }),
      );
      client.on('disconnected', () => logger.warn('ZooKeeper client disconnected'));
      client.on('expired', () => {
        logger.warn('ZooKeeper session expired — will reconnect on next use');
        if (this.client === client) this.client = null;
      });

      // Authenticate as the admin digest so Hermes holds ADMIN on the znodes it manages.
      client.addAuthInfo('digest', Buffer.from(`${user}:${password}`));
      client.connect();
    });
  }

  /** Numeric ZK error code for a callback error, if any. */
  private errCode(err: unknown): number | undefined {
    const e = err as { getCode?: () => number; code?: number } | null;
    if (e && typeof e.getCode === 'function') return e.getCode();
    if (e && typeof e.code === 'number') return e.code;
    return undefined;
  }

  /** Wrap a ZK callback error as an ExternalServiceError with context. */
  private wrapErr(err: unknown, op: string, path: string): ExternalServiceError {
    const msg = (err as { message?: string })?.message || String(err);
    return new ExternalServiceError(`ZooKeeper ${op} failed for ${path}: ${msg}`);
  }

  // ── Identity (digest credentials) ─────────────────────────────────────────────

  /**
   * Mint a digest credential for `username`. Returns the plaintext password (to hand
   * to the user once) and the ACL id Hermes stores. The password is NOT retained here.
   * Uses Node `crypto` — no external dependency.
   */
  mintCredential(username: string): ZkCredential {
    const password = crypto.randomBytes(12).toString('base64url');
    const hash = crypto.createHash('sha1').update(`${username}:${password}`, 'utf8').digest('base64');
    return { username, password, aclId: `${username}:${hash}` };
  }

  // ── External-group id parsing ──────────────────────────────────────────────────

  /**
   * Split a backing id `"<path>"` or `"<path>#<perms>"` into `{ path, perms }`.
   *
   * ZooKeeper permits `#` inside a znode name, so we treat a trailing `#<suffix>` as the
   * perms delimiter ONLY when `<suffix>` is a non-empty run of ZK perm letters (c/d/r/w/a)
   * — split on the LAST `#`. Otherwise `#` is part of the path and the whole string is the
   * znode path (perms default to read). This avoids mis-splitting a node like
   * `/hermes/team#1` and prevents a name like `/hermes/config#name` from silently being
   * read as path `/hermes/config` with perms `a` (ADMIN, since `name` contains `a`).
   */
  parseExternalGroupId(externalGroupId: string): { path: string; perms: string } {
    const raw = (externalGroupId || '').trim();
    let path = raw;
    let rawPerms: string | undefined;
    const hashIdx = raw.lastIndexOf('#');
    if (hashIdx > 0) {
      const candidate = raw.slice(hashIdx + 1).trim();
      if (candidate.length > 0 && /^[cdrwa]+$/i.test(candidate)) {
        path = raw.slice(0, hashIdx).trim();
        rawPerms = candidate;
      }
    }
    if (!path.startsWith('/')) {
      throw new ValidationError(
        `Invalid ZooKeeper path "${externalGroupId}" — a backing group id must be a znode path like /hermes/credit-card (optionally with #perms).`,
      );
    }
    return { path, perms: normalizePerms(rawPerms ?? 'r') };
  }

  /**
   * Parse a backing group id into its individual ACL targets. A ZooKeeper group id is
   * a newline-separated list of `"<path>"` / `"<path>#<perms>"` entries, so a group
   * can grant access to several znodes at once. A single-line id — the original format
   * — parses to a one-element list, so existing group/level ids keep working
   * unchanged. Blank lines are ignored and entries are de-duplicated by path (a later
   * line's perms win), so a grant fans out to exactly one ACL entry per distinct path.
   */
  parseExternalGroupIds(externalGroupId: string): { path: string; perms: string }[] {
    const byPath = new Map<string, { path: string; perms: string }>();
    for (const line of (externalGroupId || '').split(/\r?\n/)) {
      const entry = line.trim();
      if (!entry) continue;
      const target = this.parseExternalGroupId(entry);
      byPath.set(target.path, target);
    }
    if (byPath.size === 0) {
      throw new ValidationError(
        `Invalid ZooKeeper group id "${externalGroupId}" — expected at least one znode path like /hermes/credit-card (optionally with #perms), one per line.`,
      );
    }
    return [...byPath.values()];
  }

  // ── Path tree (for subtree-read expansion) ──────────────────────────────────────
  // ZooKeeper ACLs are per-node and NOT inherited: holding READ on /hermes/credit-card
  // does not let a client list /hermes (to navigate down to it) or read
  // /hermes/credit-card/transactions (a child). So to let a granted user actually browse
  // their path in a tree UI (ZooNavigator), Hermes lays an explicit READ entry on every
  // ANCESTOR (so the tree expands from /) and every existing DESCENDANT (so the subtree is
  // readable). These helpers enumerate those nodes; the adapter applies/removes the entries.

  /** Whether a path is inside ZooKeeper's own reserved system subtree (never managed). */
  isReservedPath(path: string): boolean {
    return path === '/zookeeper' || path.startsWith('/zookeeper/');
  }

  /** Whether a znode is at or under a given ancestor path. */
  isAtOrUnder(node: string, ancestor: string): boolean {
    return node === ancestor || node.startsWith(ancestor === '/' ? '/' : `${ancestor}/`);
  }

  /**
   * Proper ancestors of a path, root-first, INCLUDING the root `/`. The node itself is
   * excluded. `/hermes/credit-card` → `['/', '/hermes']`; `/hermes` → `['/']`; `/` → `[]`.
   * Pure string math — ancestors of a managed path always already exist (mkdirp created them).
   */
  ancestorPaths(path: string): string[] {
    const norm = path.replace(/\/+$/, '') || '/';
    if (norm === '/') return [];
    const parts = norm.split('/').filter(Boolean);
    const out = ['/'];
    let cur = '';
    for (let i = 0; i < parts.length - 1; i++) {
      cur += `/${parts[i]}`;
      out.push(cur);
    }
    return out;
  }

  /**
   * Every existing descendant znode under `path` (recursively), excluding the node itself
   * and the reserved `/zookeeper` subtree. Sim: a prefix scan of the in-process store.
   * Live: a recursive `getChildren` walk. NOTE: this only covers nodes that exist at call
   * time — a child created AFTER a grant is not retro-granted (ZK has no inherited ACL), so
   * such a node stays admin-only until the next reconcile/re-grant. Returns [] if absent.
   */
  async descendantPaths(path: string): Promise<string[]> {
    const base = path.replace(/\/+$/, '') || '/';
    const prefix = base === '/' ? '/' : `${base}/`;
    if (this.isSimulation) {
      await tick();
      return [...sim.nodes.keys()].filter((k) => k !== base && k.startsWith(prefix) && !this.isReservedPath(k));
    }
    const client = await this.getClient();
    const out: string[] = [];
    const walk = async (p: string): Promise<void> => {
      const children = await new Promise<string[]>((resolve, reject) => {
        client.getChildren(p, (err, ch) => {
          if (err) {
            if (this.errCode(err) === Exception.NO_NODE) return resolve([]);
            return reject(this.wrapErr(err, 'getChildren', p));
          }
          resolve(ch || []);
        });
      });
      for (const c of children) {
        const childPath = `${p === '/' ? '' : p}/${c}`;
        if (this.isReservedPath(childPath)) continue;
        out.push(childPath);
        await walk(childPath);
      }
    };
    await walk(base);
    return out;
  }

  // ── Znode lifecycle ─────────────────────────────────────────────────────────────

  /** Ensure a znode exists (created with an empty Hermes-managed ACL if absent). */
  async ensureNode(path: string): Promise<void> {
    if (this.isSimulation) {
      await tick();
      if (!sim.nodes.has(path)) sim.nodes.set(path, { acl: [] });
      return;
    }
    const client = await this.getClient();
    // mkdirp creates the node and any missing parents; the world-open ACL on each
    // created node keeps the subtree open. No-op if it
    // already exists (mkdirp swallows NODE_EXISTS itself; we guard once more to be safe).
    await new Promise<void>((resolve, reject) => {
      client.mkdirp(path, [this.worldOpenAcl()], (err) => {
        if (err && this.errCode(err) !== Exception.NODE_EXISTS) return reject(this.wrapErr(err, 'mkdirp', path));
        resolve();
      });
    });
  }

  /** Directly set a znode's ACL to world-open (world:anyone:cdrwa) without touching its data. */
  async setWorldOpenAcl(path: string): Promise<void> {
    if (this.isSimulation) {
      await tick();
      return;
    }
    const client = await this.getClient();
    const openAcl = this.worldOpenAcl();
    return new Promise<void>((resolve, reject) => {
      client.setACL(path, [openAcl], -1, (err) => {
        if (err) return reject(this.wrapErr(err, 'setACL', path));
        resolve();
      });
    });
  }

  /** Create a backing znode for a group/level. Idempotent (no-op if it exists). */
  async createNode(path: string): Promise<{ path: string }> {
    await this.ensureNode(path);
    if (this.isSimulation) logger.info({ path }, '🧪 ZooKeeper (sim): created znode');
    return { path };
  }

  /** Check if a znode exists. */
  async exists(path: string): Promise<boolean> {
    if (this.isSimulation) {
      await tick();
      return sim.nodes.has(path);
    }
    const client = await this.getClient();
    return new Promise<boolean>((resolve, reject) => {
      client.exists(path, (err, stat) => {
        if (err) return reject(this.wrapErr(err, 'exists', path));
        resolve(!!stat);
      });
    });
  }

  /** Delete a backing znode (best-effort; idempotent — no-op if absent). */
  async deleteNode(path: string): Promise<void> {
    if (this.isSimulation) {
      await tick();
      // Mirror live ZooKeeper: `remove` refuses a non-empty node (NOT_EMPTY). Deleting a
      // parent here would orphan its children — a state real ZK can never reach — so we
      // leave it in place, matching the live branch's best-effort behavior below.
      const hasChildren = [...sim.nodes.keys()].some((p) => p.startsWith(`${path}/`));
      if (hasChildren) {
        logger.warn({ path }, '🧪 ZooKeeper (sim): node has children — leaving it in place');
        return;
      }
      sim.nodes.delete(path);
      logger.info({ path }, '🧪 ZooKeeper (sim): deleted znode');
      return;
    }
    const client = await this.getClient();
    await new Promise<void>((resolve, reject) => {
      client.remove(path, -1, (err) => {
        const code = this.errCode(err);
        if (!err || code === Exception.NO_NODE) return resolve(); // absent ⇒ idempotent no-op
        if (code === Exception.NOT_EMPTY) {
          logger.warn({ path }, 'ZooKeeper deleteNode: node has children — leaving it in place');
          return resolve(); // best-effort cleanup: never throw
        }
        reject(this.wrapErr(err, 'remove', path));
      });
    });
  }

  /** Read a znode's current ACL (empty list if the node doesn't exist). */
  async getAcl(path: string): Promise<ZkAclEntry[]> {
    if (this.isSimulation) {
      await tick();
      return (sim.nodes.get(path)?.acl ?? []).map((e) => ({ ...e }));
    }
    const client = await this.getClient();
    const adminId = this.adminAclId();
    return new Promise<ZkAclEntry[]>((resolve, reject) => {
      client.getACL(path, (err, acls) => {
        if (err) {
          if (this.errCode(err) === Exception.NO_NODE) return resolve([]); // absent ⇒ empty, like sim
          return reject(this.wrapErr(err, 'getACL', path));
        }
        // Surface only the Hermes-managed digest user entries (hide the admin entry and
        // any non-digest/world acls), mirroring the sim store's semantics.
        const entries = (acls || [])
          .filter((a) => a.id?.scheme === 'digest' && a.id.id !== adminId)
          .map((a) => {
            // The runtime ACL object stores the bitmask on `.permission`; the bundled
            // @types mislabels it `.perms`, so read `.permission` (falling back to `.perms`).
            const mask = (a as unknown as { permission?: number }).permission ?? a.perms ?? 0;
            return { scheme: 'digest', id: a.id.id, perms: maskToPerms(mask), mask };
          });
        resolve(entries);
      });
    });
  }

  /**
   * Read a node's full ACL state for a version-guarded read-modify-write: the ZooKeeper
   * ACL version (`aversion`, for optimistic concurrency), the Hermes-managed `digest`
   * entries (our own admin entry excluded — it's re-added on write), and the FOREIGN
   * (non-digest) entries to carry through untouched. A SINGLE getACL so the version
   * matches exactly the entries we're about to modify. NO_NODE ⇒ empty state, version 0.
   */
  private async readAclState(path: string): Promise<{ version: number; hermes: ZkAclEntry[]; foreign: ACL[] }> {
    const client = await this.getClient();
    const adminId = this.adminAclId();
    return new Promise((resolve, reject) => {
      client.getACL(path, (err, acls, stat) => {
        if (err) {
          if (this.errCode(err) === Exception.NO_NODE) return resolve({ version: 0, hermes: [], foreign: [] });
          return reject(this.wrapErr(err, 'getACL', path));
        }
        const hermes: ZkAclEntry[] = [];
        const foreign: ACL[] = [];
        for (const a of acls || []) {
          const mask = (a as unknown as { permission?: number }).permission ?? a.perms ?? 0;
          if (a.id?.scheme === 'digest') {
            // Hermes manages only digest entries; skip our own admin entry (re-added on write).
            if (a.id.id !== adminId) hermes.push({ scheme: 'digest', id: a.id.id, perms: maskToPerms(mask), mask });
          } else {
            // FOREIGN (world / ip / sasl / x509 / auth) — another system owns it; never strip.
            foreign.push(new ACL(mask, new Id(a.id.scheme, a.id.id)));
          }
        }
        const version = (stat as unknown as { aversion?: number })?.aversion ?? -1;
        resolve({ version, hermes, foreign });
      });
    });
  }

  /**
   * Version-guarded read-modify-write of a znode's Hermes-managed (`digest`) ACL entries.
   * `mutate` receives the current Hermes entries and returns the desired set — or `null`
   * to skip the write entirely (idempotent no-op, e.g. removing an absent entry). The
   * admin ALL entry and every FOREIGN (non-digest) ACL are always preserved.
   *
   * Why versioned: `setACL` replaces the WHOLE ACL, so a plain read-modify-write loses a
   * concurrent writer's entry (lost update). The in-process {@link withPathLock} only
   * serializes writers WITHIN one process — but Hermes' production target runs MULTIPLE
   * replicas, where two replicas can grant on a shared znode (path-sharing levels, the
   * subtree-READ ancestors/descendants) at the same time. So we pass ZooKeeper's ACL
   * `version` to setACL and re-read + re-apply on BAD_VERSION — correct across replicas.
   * Simulation has no version (single in-process store) and writes directly.
   */
  private async mutateAcl(path: string, mutate: (hermes: ZkAclEntry[]) => ZkAclEntry[] | null): Promise<void> {
    if (this.isSimulation) {
      // getAcl returns the stored Hermes digest entries; sim has no admin/foreign entries.
      const next = mutate(await this.getAcl(path));
      if (next === null) return;
      await tick();
      // setACL must NOT touch the node's data — preserve any existing value.
      const existing = sim.nodes.get(path);
      sim.nodes.set(path, { acl: next.map((e) => ({ ...e })), data: existing?.data });
      return;
    }
    const client = await this.getClient();
    const adminId = this.adminAclId();
    for (let attempt = 1; ; attempt++) {
      const { version, hermes, foreign } = await this.readAclState(path);
      const mutated = mutate(hermes);
      if (mutated === null) return; // no-op
      // Always keep exactly one admin ALL entry (drop any incoming admin-id to avoid a dup)
      // + the foreign entries, then the mutated Hermes set.
      const zkAcls: ACL[] = [
        this.adminAcl(),
        ...foreign,
        ...mutated.filter((e) => e.id !== adminId).map((e) => new ACL(e.mask, new Id(e.scheme, e.id))),
      ];
      const lostRace = await new Promise<boolean>((resolve, reject) => {
        client.setACL(path, zkAcls, version, (err) => {
          if (!err) return resolve(false);
          if (this.errCode(err) === Exception.BAD_VERSION) return resolve(true); // concurrent writer won
          return reject(this.wrapErr(err, 'setACL', path));
        });
      });
      if (!lostRace) return;
      if (attempt >= MAX_ACL_WRITE_ATTEMPTS) {
        throw new ExternalServiceError(
          `ZooKeeper setACL for ${path} kept losing to concurrent writers after ${MAX_ACL_WRITE_ATTEMPTS} attempts.`,
        );
      }
      logger.warn({ path, attempt }, 'ZooKeeper setACL hit BAD_VERSION — re-reading and retrying');
    }
  }

  // ── ACL entry add/remove (locked read-modify-write) ─────────────────────────────

  /**
   * Grant: add (or update) the user's `digest` ACL entry on the znode with `perms`.
   * Idempotent — re-running with different perms updates the existing entry (so a
   * level change just rewrites the perms on the same id). Serialized per path.
   *
   * `opts.merge` UNIONs the new perms into any existing entry instead of replacing it
   * (it never lowers a perm already present). The subtree-read expansion uses this when
   * laying a navigational READ on a path's ancestors/descendants, so it can't downgrade
   * a stronger grant the user already holds on that same node via another group/level.
   * The default (replace) is what an explicit level change needs — e.g. a demote cdrw→r.
   */
  async addAclEntry(path: string, aclId: string, perms: string, opts: { merge?: boolean } = {}): Promise<void> {
    const canonical = normalizePerms(perms);
    return this.withPathLock(path, async () => {
      await this.ensureNode(path);
      // mutate may re-run on a BAD_VERSION retry — keep it pure (no side effects).
      await this.mutateAcl(path, (hermes) => {
        const existing = hermes.find((e) => e.scheme === 'digest' && e.id === aclId);
        const finalPerms = opts.merge && existing ? normalizePerms(existing.perms + canonical) : canonical;
        const next = hermes.filter((e) => !(e.scheme === 'digest' && e.id === aclId));
        next.push({ scheme: 'digest', id: aclId, perms: finalPerms, mask: permsToMask(finalPerms) });
        return next;
      });
      if (this.isSimulation) logger.info({ path, aclId, perms: canonical }, '🧪 ZooKeeper (sim): added ACL entry');
    });
  }

  /** Revoke: remove the user's `digest` ACL entry from the znode. Idempotent. */
  async removeAclEntry(path: string, aclId: string): Promise<void> {
    return this.withPathLock(path, async () => {
      await this.mutateAcl(path, (hermes) => {
        const next = hermes.filter((e) => !(e.scheme === 'digest' && e.id === aclId));
        return next.length === hermes.length ? null : next; // entry (or node) absent ⇒ no-op
      });
      if (this.isSimulation) logger.info({ path, aclId }, '🧪 ZooKeeper (sim): removed ACL entry');
    });
  }

  // ── Config data & navigation (znode payload) ────────────────────────────────────
  // Read/write a znode's DATA (its config value) and list immediate children — the
  // primitives the approval-based config UI is built on. Reads go through Hermes' admin
  // connection (which holds ADMIN on every managed node), so per-node ACLs do NOT scope
  // them — the config service is the enforcement point (it only ever asks for paths the
  // caller's grant covers).

  /** Read a znode's data as a UTF-8 string. Returns null if the node is absent or has no
   *  data. Read-only ⇒ no path lock. */
  async getData(path: string): Promise<string | null> {
    if (this.isSimulation) {
      await tick();
      const node = sim.nodes.get(path);
      return node?.data !== null && node?.data !== undefined ? node.data.toString('utf-8') : null;
    }
    const client = await this.getClient();
    return new Promise<string | null>((resolve, reject) => {
      client.getData(path, (err, data) => {
        if (err) {
          if (this.errCode(err) === Exception.NO_NODE) return resolve(null);
          return reject(this.wrapErr(err, 'getData', path));
        }
        resolve(data !== null && data !== undefined ? data.toString('utf-8') : null);
      });
    });
  }

  /** Write a znode's data (blind write, version -1). The node MUST already exist
   *  (use {@link createNodeRecursive} first for a new node) — setData never creates.
   *  Serialized via {@link withPathLock}: a data write can race an ACL write on the
   *  same node, and both replace state. */
  async setData(path: string, data: string): Promise<void> {
    return this.withPathLock(path, async () => {
      if (this.isSimulation) {
        await tick();
        const node = sim.nodes.get(path);
        if (!node) throw new ExternalServiceError(`ZooKeeper setData failed for ${path}: node does not exist`);
        node.data = Buffer.from(data, 'utf-8');
        logger.info({ path }, '🧪 ZooKeeper (sim): set znode data');
        return;
      }
      const client = await this.getClient();
      await new Promise<void>((resolve, reject) => {
        client.setData(path, Buffer.from(data, 'utf-8'), -1, (err) =>
          err ? reject(this.wrapErr(err, 'setData', path)) : resolve(),
        );
      });
    });
  }

  /** Immediate child znode NAMES of a path (not full paths), excluding the reserved
   *  `/zookeeper` subtree. Returns [] if the node doesn't exist (NO_NODE ⇒ [], like getAcl). */
  async getChildren(path: string): Promise<string[]> {
    const base = path.replace(/\/+$/, '') || '/';
    if (this.isSimulation) {
      await tick();
      const prefix = base === '/' ? '/' : `${base}/`;
      const names = new Set<string>();
      for (const key of sim.nodes.keys()) {
        if (key === base || !key.startsWith(prefix) || this.isReservedPath(key)) continue;
        const name = key.slice(prefix.length).split('/')[0];
        if (name) names.add(name);
      }
      return [...names];
    }
    const client = await this.getClient();
    return new Promise<string[]>((resolve, reject) => {
      client.getChildren(base, (err, children) => {
        if (err) {
          if (this.errCode(err) === Exception.NO_NODE) return resolve([]);
          return reject(this.wrapErr(err, 'getChildren', base));
        }
        const childPath = (name: string): string => `${base === '/' ? '' : base}/${name}`;
        resolve((children || []).filter((c) => !this.isReservedPath(childPath(c))));
      });
    });
  }

  /** Ensure a path and EVERY missing ancestor exist (mkdirp). Sim: plain `ensureNode`
   *  only creates the leaf, so a deep create like /a/b/c would leave /a/b absent and
   *  unbrowsable — create each ancestor here. Live: delegate to `ensureNode` (mkdirp
   *  already creates parents). New nodes get an empty Hermes-managed ACL. */
  async createNodeRecursive(path: string): Promise<void> {
    if (this.isSimulation) {
      await tick();
      const norm = path.replace(/\/+$/, '') || '/';
      if (norm === '/') return;
      let cur = '';
      for (const part of norm.split('/').filter(Boolean)) {
        cur += `/${part}`;
        if (!sim.nodes.has(cur)) sim.nodes.set(cur, { acl: [] });
      }
      logger.info({ path }, '🧪 ZooKeeper (sim): created znode (recursive)');
      return;
    }
    await this.ensureNode(path);
  }

  // ── Health ───────────────────────────────────────────────────────────────────────

  /** Liveness probe. Sim: always healthy. Live: not wired yet. */
  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    if (this.isSimulation) return { healthy: true, message: 'simulation' };
    try {
      const client = await this.getClient();
      await new Promise<void>((resolve, reject) => {
        // `exists` returns without error even when the node is absent — a cheap liveness ping.
        client.exists('/', (err) => (err ? reject(this.wrapErr(err, 'exists', '/')) : resolve()));
      });
      return { healthy: true };
    } catch (err) {
      return { healthy: false, message: (err as Error)?.message || 'ZooKeeper unreachable' };
    }
  }

  /** Close the live client if one is connected (graceful shutdown / one-shot scripts). No-op in sim. */
  close(): void {
    const client = this.client;
    this.client = null;
    if (client) {
      try {
        client.close();
      } catch {
        /* already closing */
      }
    }
  }

  // ── Test-only ──────────────────────────────────────────────────────────────────────

  /** Reset the in-process sim store. Test-only — never called in app code. */
  __resetSim(): void {
    sim.nodes.clear();
  }
}

export const zookeeperService = new ZookeeperService();
export default zookeeperService;
