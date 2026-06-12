import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import apiClient from '../services/apiClient';
import LoadingSpinner from '../components/common/LoadingSpinner';
import { Scroll, Search, RefreshCw, ChevronLeft, ChevronRight } from 'lucide-react';
import { queryKeys } from '../lib/queryKeys';
import { fetchPlatforms } from '../services/api/platforms';
import { useToast } from '../contexts/ToastContext';

interface AuditLogEntry {
  id: string;
  action: string;
  performerId: string;
  performerName: string;
  targetUserId: string | null;
  targetUserName: string | null;
  groupId: string | null;
  accessRequestId: string | null;
  details: any;
  ipAddress: string | null;
  createdAt: string;
}

interface AuditResponse {
  items: AuditLogEntry[];
  total: number;
}

export const AuditLog: React.FC = () => {
  const queryClient = useQueryClient();
  const toast = useToast();

  const [page, setPage] = useState(1);
  const [pageSize] = useState(10);
  const [search, setSearch] = useState('');
  const [submittedSearch, setSubmittedSearch] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [platformFilter, setPlatformFilter] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  // Dropdown data for the platform / group filters.
  const { data: platforms = [] } = useQuery({
    queryKey: queryKeys.platforms(),
    queryFn: fetchPlatforms,
  });
  const { data: groupOptions = [] } = useQuery<{ id: string; name: string; platform: string }[]>({
    queryKey: queryKeys.groups(),
    queryFn: () => apiClient.get('/api/groups').then((r) => r.data),
  });

  const auditQuery = useQuery<AuditResponse>({
    // Only include set filters in the key so clearing a filter (e.g. platform '' )
    // reuses the same cached query the backend would return anyway (it treats empty
    // strings as unset), instead of churning a fresh cache entry.
    queryKey: queryKeys.audit({
      page,
      pageSize,
      action: actionFilter,
      search: submittedSearch,
      ...(groupFilter ? { groupId: groupFilter } : {}),
      ...(platformFilter ? { platform: platformFilter } : {}),
      ...(fromDate ? { fromDate } : {}),
      ...(toDate ? { toDate } : {}),
    }),
    queryFn: async () => {
      const headers = {
        pageno: page.toString(),
        pagesize: pageSize.toString(),
      };
      const params: Record<string, string> = {};
      if (submittedSearch) params.search = submittedSearch;
      if (actionFilter) params.action = actionFilter;
      if (groupFilter) params.groupId = groupFilter;
      if (platformFilter) params.platform = platformFilter;
      if (fromDate) params.fromDate = fromDate;
      if (toDate) params.toDate = toDate;

      const res = await apiClient.get('/api/audit', { headers, params });
      const items = (res.data ?? []) as AuditLogEntry[];
      // Standard envelope metadata is unwrapped by apiClient; fall back gracefully.
      const total =
        Number(res.headers['total']) ||
        Number((res as any).metadata?.total) ||
        items.length;
      return { items, total };
    },
    // Keep the previous page visible while a new one loads to avoid a flash.
    placeholderData: (prev) => prev,
  });

  const logs = auditQuery.data?.items ?? [];
  const totalLogs = auditQuery.data?.total ?? 0;
  const isLoading = auditQuery.isLoading;

  const syncMutation = useMutation({
    mutationFn: () => apiClient.post('/api/admin/sync').then((r) => r.data),
    onSuccess: (data: { usersSynced: number; groupsSynced: number }) => {
      toast.success(`Sync success! Imported ${data.usersSynced} users and ${data.groupsSynced} groups.`);
      queryClient.invalidateQueries({ queryKey: ['audit'] });
    },
    onError: (err: any) => {
      toast.error(`Sync failed: ${err.message}`);
    },
  });

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    setSubmittedSearch(search);
  };

  const totalPages = Math.ceil(totalLogs / pageSize) || 1;

  const formatDate = (isoString: string) => {
    return new Date(isoString).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const formatDetails = (entry: AuditLogEntry) => {
    const details = entry.details;
    if (!details) return '—';

    if (entry.action === 'REQUEST_CREATED') {
      return `Requested duration: ${details.duration?.replace('_', ' ').toLowerCase()}`;
    }
    if (entry.action === 'ACCESS_GRANTED') {
      // `externalUserId` is the platform-agnostic key; older rows still carry the
      // legacy `redashUserId`, so fall back to it for historic entries.
      return `Access granted by admin. Platform User ID: ${details.externalUserId ?? details.redashUserId ?? 'mock'}`;
    }
    if (entry.action === 'ACCESS_REVOKED') {
      return `Revoked. Reason: "${details.reason || 'manual'}"`;
    }
    if (entry.action === 'ACCESS_EXPIRED') {
      return `Expired (time-bound grant ended)`;
    }
    if (entry.action === 'MANUAL_SYNC_TRIGGERED') {
      return `${details.platform ?? 'Platform'} synced: ${details.usersSynced} users, ${details.groupsSynced} groups`;
    }
    return JSON.stringify(details);
  };

  const isSyncing = syncMutation.isPending;

  return (
    <div>
      {/* Page Header */}
      <div className="section-header">
        <h1 style={{ fontSize: '28px' }}>Platform Audit Log</h1>

        <button
          className="btn btn-primary"
          onClick={() => syncMutation.mutate()}
          disabled={isSyncing}
          style={{ gap: '8px' }}
        >
          <RefreshCw size={16} style={{ animation: isSyncing ? 'spin 1.5s linear infinite' : 'none' }} />
          {isSyncing ? 'Syncing...' : 'Sync Platform Cache'}
        </button>
      </div>

      {/* Filter and Search Bar */}
      <div style={{
        backgroundColor: 'var(--bg-card)',
        padding: '20px',
        borderRadius: 'var(--radius-lg)',
        border: '1px solid var(--border)',
        boxShadow: 'var(--shadow-sm)',
        marginBottom: '24px',
        display: 'flex',
        gap: '16px',
        alignItems: 'center',
        flexWrap: 'wrap'
      }}>
        <form onSubmit={handleSearchSubmit} style={{ display: 'flex', gap: '8px', flex: 1, minWidth: '280px' }}>
          <div className="form-input-with-icon" style={{ flex: 1 }}>
            <Search size={18} />
            <input
              type="text"
              className="form-input"
              placeholder="Search performer or target user..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <button type="submit" className="btn btn-secondary">Search</button>
        </form>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-muted)' }}>Action:</span>
          <select
            className="form-select"
            style={{ width: '220px' }}
            value={actionFilter}
            onChange={(e) => {
              setActionFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All Actions</option>
            <option value="REQUEST_CREATED">REQUEST_CREATED</option>
            <option value="REQUEST_REJECTED">REQUEST_REJECTED</option>
            <option value="ACCESS_GRANTED">ACCESS_GRANTED</option>
            <option value="ACCESS_REVOKED">ACCESS_REVOKED</option>
            <option value="ACCESS_EXPIRED">ACCESS_EXPIRED</option>
            <option value="MANUAL_SYNC_TRIGGERED">MANUAL_SYNC_TRIGGERED</option>
          </select>
        </div>

        {/* Platform filter — narrows to entries on one platform's groups. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-muted)' }}>Platform:</span>
          <select
            className="form-select"
            style={{ width: '150px' }}
            value={platformFilter}
            onChange={(e) => {
              setPlatformFilter(e.target.value);
              setGroupFilter(''); // reset group when platform changes
              setPage(1);
            }}
          >
            <option value="">All Platforms</option>
            {platforms.map((p) => (
              <option key={p.key} value={p.key}>
                {p.displayName}
              </option>
            ))}
          </select>
        </div>

        {/* Group filter — options scoped to the chosen platform (if any). */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-muted)' }}>Group:</span>
          <select
            className="form-select"
            style={{ width: '200px' }}
            value={groupFilter}
            onChange={(e) => {
              setGroupFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All Groups</option>
            {groupOptions
              .filter((g) => !platformFilter || g.platform === platformFilter)
              .map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
          </select>
        </div>

        {/* Date range (inclusive). Native pickers; bounds keep from ≤ to. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-muted)' }}>From:</span>
          <input
            type="date"
            className="form-input"
            style={{ width: '160px' }}
            value={fromDate}
            max={toDate || undefined}
            onChange={(e) => {
              setFromDate(e.target.value);
              setPage(1);
            }}
          />
          <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-muted)' }}>To:</span>
          <input
            type="date"
            className="form-input"
            style={{ width: '160px' }}
            value={toDate}
            min={fromDate || undefined}
            onChange={(e) => {
              setToDate(e.target.value);
              setPage(1);
            }}
          />
        </div>

        {(actionFilter || platformFilter || groupFilter || fromDate || toDate || submittedSearch) && (
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={() => {
              setActionFilter('');
              setPlatformFilter('');
              setGroupFilter('');
              setFromDate('');
              setToDate('');
              setSearch('');
              setSubmittedSearch('');
              setPage(1);
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Audit Log Table */}
      {isLoading ? (
        <LoadingSpinner />
      ) : logs.length === 0 ? (
        <div className="empty-state">
          <Scroll size={44} className="empty-state-icon" />
          <h3 className="empty-state-title">No Audit Logs</h3>
          <p className="empty-state-desc">No events were logged matching the filter criteria.</p>
        </div>
      ) : (
        <>
          <div className="table-container">
            <table className="hermes-table">
              <thead>
                <tr>
                  <th>Event Date</th>
                  <th>Performer</th>
                  <th>Action</th>
                  <th>Target User</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((entry) => (
                  <tr key={entry.id}>
                    <td style={{ fontSize: '13px', whiteSpace: 'nowrap' }}>
                      {formatDate(entry.createdAt)}
                    </td>
                    <td style={{ fontWeight: 700 }}>
                      {entry.performerName.replace('_', ' ')}
                    </td>
                    <td>
                      <span style={{
                        fontSize: '11px',
                        fontWeight: 800,
                        padding: '2px 8px',
                        borderRadius: 'var(--radius-sm)',
                        backgroundColor: entry.action.includes('GRANT') || entry.action.includes('SYNC') ? 'var(--status-approved-bg)' : entry.action.includes('REJECT') || entry.action.includes('REVOKE') ? 'var(--status-rejected-bg)' : 'var(--primary-light)',
                        color: entry.action.includes('GRANT') || entry.action.includes('SYNC') ? 'var(--status-approved-text)' : entry.action.includes('REJECT') || entry.action.includes('REVOKE') ? 'var(--status-rejected-text)' : 'var(--primary)',
                      }}>
                        {entry.action}
                      </span>
                    </td>
                    <td>
                      {entry.targetUserName ? entry.targetUserName.replace('_', ' ') : <span style={{ color: 'var(--text-light)' }}>System</span>}
                    </td>
                    <td style={{ fontSize: '13px' }}>
                      {formatDetails(entry)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination Controls */}
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: '24px'
          }}>
            <span style={{ fontSize: '13px', color: 'var(--text-muted)', fontWeight: 600 }}>
              Showing page {page} of {totalPages} ({totalLogs} items)
            </span>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                className="btn btn-outline"
                style={{ padding: '8px 16px' }}
                onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                disabled={page === 1}
              >
                <ChevronLeft size={16} /> Previous
              </button>
              <button
                className="btn btn-outline"
                style={{ padding: '8px 16px' }}
                onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
                disabled={page === totalPages}
              >
                Next <ChevronRight size={16} />
              </button>
            </div>
          </div>
        </>
      )}

    </div>
  );
};

export default AuditLog;
