import apiClient from '../apiClient';

/**
 * Platform keys that have a live provisioning adapter on the backend
 * (e.g. ["redash", "aws"]). The UI derives each platform card's ACTIVE vs
 * COMING_SOON status from this instead of hardcoding it.
 */
export async function fetchLivePlatforms(): Promise<string[]> {
  const res = await apiClient.get('/api/platforms');
  // apiClient unwraps the response envelope's `data`; backend returns { live: [...] }.
  return ((res.data as { live?: string[] })?.live) ?? [];
}
