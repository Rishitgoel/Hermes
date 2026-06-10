import apiClient from '../apiClient';

/**
 * A live provisioning platform as described by the backend registry.
 *  - `key`: the platform id (matches Group.platform), e.g. "redash" / "aws".
 *  - `displayName`: adapter-owned human name for labels/links.
 *  - `launchUrl`: where a user opens the platform (null when none is configured).
 */
export interface LivePlatform {
  key: string;
  displayName: string;
  launchUrl: string | null;
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
  if (data?.platforms) return data.platforms;
  // Back-compat: older backend only returned `live` (keys). Synthesize minimal rows.
  return (data?.live ?? []).map((key) => ({ key, displayName: key, launchUrl: null }));
}
