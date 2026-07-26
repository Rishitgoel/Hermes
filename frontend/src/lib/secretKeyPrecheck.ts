/**
 * Client-side precheck for the Secret Ingestion "Add Key-Value Entry" form.
 *
 * Some key names mark a value as *configuration*, not a secret — endpoint URLs,
 * connection URIs, Kafka `autoStartup` boolean flags and the like. Those belong in
 * plain config (Properties Config / a ConfigMap / application.yml), never in AWS
 * Secrets Manager or Azure Key Vault, so we block them at ingestion time.
 *
 * This is a naming heuristic — extend `NON_SECRET_TOKENS` as ops finds more
 * config-shaped keys. Matching is case-insensitive substring (so it catches
 * `jdbcUrl`, `service_base_url`, `kafka_topic_x_autoStartup`, …).
 *
 * The rule applies to *new* keys only. A key that already lives in the target secret
 * predates this check (or was added deliberately), and rotating its value must never be
 * blocked — pass the secret's current key list as `existingKeys` to exempt those.
 *
 * ⚠ Caveat worth knowing: a connection *URI* such as `spring_data_mongodb_uri`
 * usually embeds `user:pass@host` and IS a real secret. If you ever need to ingest
 * one of those, drop `'uri'` from the list below rather than special-casing here.
 */
export const NON_SECRET_TOKENS = ['url', 'uri', 'autostartup', 'auto_startup', 'test'] as const;

export interface KeyPrecheckResult {
  /** true ⇒ the key looks like config and must be blocked. */
  blocked: boolean;
  /** the token that matched (lowercased), or null when the key is clean. */
  matched: string | null;
}

/**
 * Classify a candidate secret key name. Empty/whitespace keys are treated as clean
 * (the form's own "key cannot be empty" guard handles those).
 *
 * @param existingKeys keys already present in the target secret. Anything in this list is
 *   an *update*, not an add, and is always clean — matched exactly (secret payloads are
 *   JSON objects, so key names are case-sensitive), the same way the ADD/UPDATE badge
 *   decides which one a draft entry is.
 */
export function precheckSecretKey(
  rawKey: string,
  existingKeys?: readonly string[] | null,
): KeyPrecheckResult {
  const key = rawKey.trim();
  if (!key) return { blocked: false, matched: null };
  if (existingKeys?.includes(key)) return { blocked: false, matched: null };
  const lowered = key.toLowerCase();
  for (const token of NON_SECRET_TOKENS) {
    if (lowered.includes(token)) return { blocked: true, matched: token };
  }
  return { blocked: false, matched: null };
}
