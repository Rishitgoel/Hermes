import apiClient from '../apiClient';
import { registerLivePlatforms } from '../../lib/platforms';

/**
 * A live provisioning platform as described by the backend registry.
 *  - `key`: the platform id (matches Group.platform), e.g. "redash" / "aws".
 *  - `displayName`: adapter-owned human name for labels/links.
 *  - `launchUrl`: where a user opens the platform (null when none is configured).
 *  - `family`: groups multiple instances of one platform (e.g. "redash" and
 *    "redash-qa" both have family "redash") so the UI can collapse them into
 *    one card with an instance chooser. Defaults to the platform's own key
 *    for a single-instance platform (i.e. it renders as its own ungrouped card).
 *  - `label`: distinguishes an instance within its family (e.g. "Prod"/"QA");
 *    null when the platform has no multiple instances.
 */
export interface LivePlatform {
  key: string;
  displayName: string;
  launchUrl: string | null;
  family: string;
  label: string | null;
}

/**
 * Live platforms that have a provisioning adapter registered on the backend. The UI
 * derives each platform card's ACTIVE vs COMING_SOON status from the keys here, and
 * the dashboard uses displayName/launchUrl to label & link a grant to its platform —
 * so registering an adapter on the backend updates the UI with no change here.
 */
export async function fetchPlatforms(): Promise<LivePlatform[]> {
  const res = await apiClient.get('/api/platforms');
  // apiClient unwraps the envelope's `data`; backend returns { live, platforms }.
  const data = res.data as { platforms?: LivePlatform[]; live?: string[] };
  if (data?.platforms) {
    registerLivePlatforms(data.platforms);
    return data.platforms;
  }
  // Back-compat: older backend only returned `live` (keys). Synthesize minimal rows.
  const synthesized = (data?.live ?? []).map((key) => ({ key, displayName: key, launchUrl: null, family: key, label: null }));
  registerLivePlatforms(synthesized);
  return synthesized;
}
