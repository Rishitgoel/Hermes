import { createClient, ACL, Id, Permission, Exception, type Client } from 'node-zookeeper-client';
import config from '../config/config';
import logger from '../utils/logger';
import { ExternalServiceError, ValidationError } from '../utils/errors';

/**
 * Low-level client for Apache ZooKeeper node and config management — the ZK analogue of
 * {@link ../services/aws-identity-center.service aws-identity-center.service} and
 * {@link ../services/redash.service redash.service}.
 *
 * Hermes config nodes are world-open (world:anyone:cdrwa). Access control is checked at the
 * Hermes application layer via Postgres tables, and ZooKeeper calls are made using Hermes's
 * admin connection.
 *
 * Simulation-first: with `ZOOKEEPER_SIMULATION=true` all calls hit an in-process store.
 * Otherwise, the live `node-zookeeper-client` is used.
 */

/** Canonical permission letter order (matches `zkCli` ACL strings). */
export const PERM_ORDER = ['c', 'd', 'r', 'w'] as const;

/** Normalize a permission string to canonical c/d/r/w order, dropping unknown chars. */
export function normalizePerms(perms: string): string {
  const set = new Set((perms || '').toLowerCase().split(''));
  const out = PERM_ORDER.filter((p) => set.has(p));
  return out.join('') || 'r'; // default to read if nothing valid was supplied
}

// ── Simulation store ──────────────────────────────────────────────────────────
// In-process, stateful mock of the znode tree (path → ACL). Coherent within a
// running backend (create node → add entry → read → remove all agree) and resets on
// restart, exactly like the Redash/AWS sims. No users are seeded — every ZK identity
// is minted by Hermes, so there are no pre-existing accounts to mock. It DOES seed a
// handful of demo config znodes (below) so a fresh demo deploy has something to browse
// and edit immediately, rather than an empty tree.

interface SimNode {
  /** The znode's data payload (config management). Absent ⇒ the node has no data. */
  data?: Buffer;
}

const sim = {
  seeded: false,
  nodes: new Map<string, SimNode>(), // path → node
};

/** A microtask yield so the sim's read-modify-write has a real async gap (makes the
 *  per-path lock meaningful: two unlocked concurrent RMWs would clobber here). */
function tick(): Promise<void> {
  return Promise.resolve();
}

/**
 * Seeds a small demo znode tree on first use each process lifetime (mirrors
 * `ensureSimSeeded` in aws-identity-center.service.ts / redash.service.ts).
 * Re-runs on every restart since the sim store is in-memory and resets then —
 * this keeps the "Config Management" / "Feature Flags" demo groups (seeded in
 * prisma/hermes/seed.ts, externalGroupId /hermes/config#cdrw and
 * /hermes/feature-flags#cdrw) non-empty across redeploys, not just once.
 * Values are deliberately consistent with the demo ZookeeperChangeRequest rows
 * the Prisma seed creates: max_retries/rate_limit_rps sit at their PRE-change
 * values (those requests are still PENDING/APPLYING), while
 * new_onboarding_flow already reflects its APPLIED outcome.
 */
function ensureSimSeeded(): void {
  if (sim.seeded) {return;}
  sim.seeded = true;
  const seedNodes: Array<[string, string | undefined]> = [
    ['/hermes', undefined],
    ['/hermes/config', undefined],
    ['/hermes/config/max_retries', '3'],
    ['/hermes/config/rate_limit_rps', '50'],
    ['/hermes/config/timeout_ms', '30000'],
    ['/hermes/config/feature_toggle_ui', 'true'],
    ['/hermes/feature-flags', undefined],
    ['/hermes/feature-flags/new_onboarding_flow', 'true'],
    ['/hermes/feature-flags/dark_mode_default', 'false'],
    ['/hermes/feature-flags/checkout_v2', 'true'],
    ['/hermes/feature-flags/experiments', undefined],
    ['/hermes/feature-flags/experiments/pricing_test_a', 'control'],
    ['/hermes/feature-flags/experiments/pricing_test_b', 'variant'],
  ];
  for (const [path, data] of seedNodes) {
    sim.nodes.set(path, data !== undefined ? { data: Buffer.from(data, 'utf-8') } : {});
  }
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
    const tail = run.catch(() => { });
    this.pathChains.set(path, tail);
    void tail.then(() => {
      if (this.pathChains.get(path) === tail) {this.pathChains.delete(path);}
    });
    return run;
  }

  // ── Live client (node-zookeeper-client) ─────────────────────────────────────────
  // Only exercised when !isSimulation. Hermes authenticates as the admin digest and
  // drives every ZooKeeper call over this single connection. Managed znodes are created
  // world-open (world:anyone:cdrwa); access is enforced at the Hermes application layer
  // (Postgres), not via per-znode ACLs.

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
    if (this.connecting) {return this.connecting;}
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
        if (settled) {return;}
        settled = true;
        try {
          client.close();
        } catch {
          /* already closing */
        }
        reject(new ExternalServiceError(`Timed out connecting to ZooKeeper at ${connectString}.`));
      }, 15000);
      const finish = (fn: () => void): void => {
        if (settled) {return;}
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
        if (this.client === client) {this.client = null;}
      });

      // Authenticate as the admin digest so Hermes holds ADMIN on the znodes it manages.
      client.addAuthInfo('digest', Buffer.from(`${user}:${password}`));
      client.connect();
    });
  }

  /** Numeric ZK error code for a callback error, if any. */
  private errCode(err: unknown): number | undefined {
    const e = err as { getCode?: () => number; code?: number } | null;
    if (e && typeof e.getCode === 'function') {return e.getCode();}
    if (e && typeof e.code === 'number') {return e.code;}
    return undefined;
  }

  /** Wrap a ZK callback error as an ExternalServiceError with context. */
  private wrapErr(err: unknown, op: string, path: string): ExternalServiceError {
    const msg = (err as { message?: string })?.message || String(err);
    return new ExternalServiceError(`ZooKeeper ${op} failed for ${path}: ${msg}`);
  }

  // ── External-group id parsing ──────────────────────────────────────────────────

  /**
   * Split a backing id `"<path>"` or `"<path>#<perms>"` into `{ path, perms }`.
   *
   * ZooKeeper permits `#` inside a znode name, so we treat a trailing `#<suffix>` as the
   * perms delimiter ONLY when `<suffix>` is a non-empty run of ZK perm letters (c/d/r/w)
   * — split on the LAST `#`. Otherwise `#` is part of the path and the whole string is the
   * znode path (perms default to read). This avoids mis-splitting a node like
   * `/hermes/team#1` and prevents a name like `/hermes/config#name` from silently being
   * read as path `/hermes/config` with default perms.
   */
  parseExternalGroupId(externalGroupId: string): { path: string; perms: string } {
    const raw = (externalGroupId || '').trim();
    let path = raw;
    let rawPerms: string | undefined;
    const hashIdx = raw.lastIndexOf('#');
    if (hashIdx > 0) {
      const candidate = raw.slice(hashIdx + 1).trim();
      if (candidate.length > 0 && /^[cdrw]+$/i.test(candidate)) {
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
      if (!entry) {continue;}
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
    const n = node.replace(/\/+$/, '') || '/';
    const a = ancestor.replace(/\/+$/, '') || '/';
    return n === a || n.startsWith(a === '/' ? '/' : `${a}/`);
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
      ensureSimSeeded();
      await tick();
      return [...sim.nodes.keys()].filter((k) => k !== base && k.startsWith(prefix) && !this.isReservedPath(k));
    }
    const client = await this.getClient();
    const out: string[] = [];
    const walk = async (p: string): Promise<void> => {
      const children = await new Promise<string[]>((resolve, reject) => {
        client.getChildren(p, (err, ch) => {
          if (err) {
            const code = this.errCode(err);
            if (code === Exception.NO_NODE || code === Exception.NO_AUTH) {return resolve([]);}
            return reject(this.wrapErr(err, 'getChildren', p));
          }
          resolve(ch || []);
        });
      });
      for (const c of children) {
        const childPath = `${p === '/' ? '' : p}/${c}`;
        if (this.isReservedPath(childPath)) {continue;}
        out.push(childPath);
        await walk(childPath);
      }
    };
    await walk(base);
    return out;
  }

  // ── Znode lifecycle ─────────────────────────────────────────────────────────────

  async ensureNode(path: string): Promise<void> {
    if (this.isSimulation) {
      ensureSimSeeded();
      await tick();
      if (!sim.nodes.has(path)) {sim.nodes.set(path, {});}
      return;
    }
    const client = await this.getClient();
    // mkdirp creates the node and any missing parents; the world-open ACL on each
    // created node keeps the subtree open. No-op if it
    // already exists (mkdirp swallows NODE_EXISTS itself; we guard once more to be safe).
    await new Promise<void>((resolve, reject) => {
      client.mkdirp(path, [this.worldOpenAcl()], (err) => {
        if (err && this.errCode(err) !== Exception.NODE_EXISTS) {return reject(this.wrapErr(err, 'mkdirp', path));}
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
        if (err) {return reject(this.wrapErr(err, 'setACL', path));}
        resolve();
      });
    });
  }

  /** Create a backing znode for a group/level. Idempotent (no-op if it exists). */
  async createNode(path: string): Promise<{ path: string }> {
    await this.ensureNode(path);
    if (this.isSimulation) {logger.info({ path }, '🧪 ZooKeeper (sim): created znode');}
    return { path };
  }

  /** Check if a znode exists. */
  async exists(path: string): Promise<boolean> {
    if (this.isSimulation) {
      ensureSimSeeded();
      await tick();
      return sim.nodes.has(path);
    }
    const client = await this.getClient();
    return new Promise<boolean>((resolve, reject) => {
      client.exists(path, (err, stat) => {
        if (err) {return reject(this.wrapErr(err, 'exists', path));}
        resolve(!!stat);
      });
    });
  }

  /** Delete a backing znode (best-effort; idempotent — no-op if absent). */
  async deleteNode(path: string): Promise<void> {
    if (path === '/') {return;}
    if (this.isSimulation) {
      ensureSimSeeded();
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
        if (!err || code === Exception.NO_NODE) {return resolve();} // absent ⇒ idempotent no-op
        if (code === Exception.NOT_EMPTY) {
          logger.warn({ path }, 'ZooKeeper deleteNode: node has children — leaving it in place');
          return resolve(); // best-effort cleanup: never throw
        }
        reject(this.wrapErr(err, 'remove', path));
      });
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
      ensureSimSeeded();
      await tick();
      const node = sim.nodes.get(path);
      return node?.data !== null && node?.data !== undefined ? node.data.toString('utf-8') : null;
    }
    const client = await this.getClient();
    return new Promise<string | null>((resolve, reject) => {
      client.getData(path, (err, data) => {
        if (err) {
          const code = this.errCode(err);
          if (code === Exception.NO_NODE || code === Exception.NO_AUTH) {return resolve(null);}
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
        ensureSimSeeded();
        await tick();
        const node = sim.nodes.get(path);
        if (!node) {throw new ExternalServiceError(`ZooKeeper setData failed for ${path}: node does not exist`);}
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
   *  `/zookeeper` subtree. Returns [] if the node doesn't exist (NO_NODE ⇒ [], like getData). */
  async getChildren(path: string): Promise<string[]> {
    const base = path.replace(/\/+$/, '') || '/';
    if (this.isSimulation) {
      ensureSimSeeded();
      await tick();
      const prefix = base === '/' ? '/' : `${base}/`;
      const names = new Set<string>();
      for (const key of sim.nodes.keys()) {
        if (key === base || !key.startsWith(prefix) || this.isReservedPath(key)) {continue;}
        const name = key.slice(prefix.length).split('/')[0];
        if (name) {names.add(name);}
      }
      return [...names];
    }
    const client = await this.getClient();
    return new Promise<string[]>((resolve, reject) => {
      client.getChildren(base, (err, children) => {
        if (err) {
          const code = this.errCode(err);
          if (code === Exception.NO_NODE || code === Exception.NO_AUTH) {return resolve([]);}
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
      ensureSimSeeded();
      await tick();
      const norm = path.replace(/\/+$/, '') || '/';
      if (norm === '/') {return;}
      let cur = '';
      for (const part of norm.split('/').filter(Boolean)) {
        cur += `/${part}`;
        if (!sim.nodes.has(cur)) {sim.nodes.set(cur, {});}
      }
      logger.info({ path }, '🧪 ZooKeeper (sim): created znode (recursive)');
      return;
    }
    await this.ensureNode(path);
  }

  // ── Health ───────────────────────────────────────────────────────────────────────

  /** Liveness probe. Sim: always healthy. Live: not wired yet. */
  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    if (this.isSimulation) {return { healthy: true, message: 'simulation' };}
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

  /** Reset the in-process sim store. Test-only — never called in app code. Also
   *  clears the `seeded` flag so tests get a genuinely empty tree, not the demo
   *  znodes `ensureSimSeeded` plants for real deployments. */
  __resetSim(): void {
    sim.nodes.clear();
    sim.seeded = false;
  }
}

export const zookeeperService = new ZookeeperService();
export default zookeeperService;
