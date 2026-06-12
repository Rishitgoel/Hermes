/** Resolve the human page title for a route path — used by the TopBar heading
 *  and the browser tab title (document.title). */
export function getPageTitle(pathname: string): string {
  if (pathname === '/') return 'Dashboard';
  if (pathname === '/groups') return 'Groups';
  if (pathname.startsWith('/groups/')) return 'Group Details';
  if (pathname === '/my-requests') return 'My Requests';
  if (pathname === '/pending-approvals') return 'Pending Approvals';
  if (pathname === '/admin') return 'Admin Management';
  if (pathname === '/audit-log') return 'Audit Log';
  return 'Hermes';
}
