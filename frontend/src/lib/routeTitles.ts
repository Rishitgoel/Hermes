/** Resolve the human page title for a route path — used by the TopBar heading
 *  and the browser tab title (document.title). */
export function getPageTitle(pathname: string): string {
  const p = pathname.replace(/^\/hermes/, '') || '/';
  if (p === '/') return 'Dashboard';
  if (p === '/groups') return 'Groups';
  if (p.startsWith('/groups/')) return 'Group Details';
  if (p === '/my-requests') return 'My Requests';
  if (p === '/pending-approvals') return 'Pending Approvals';
  if (p === '/admin') return 'Admin Management';
  if (p === '/audit-log') return 'Audit Log';
  return 'Hermes';
}
