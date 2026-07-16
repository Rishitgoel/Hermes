import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import apiClient from '../services/apiClient';
import LoadingSpinner from '../components/common/LoadingSpinner';
import SectionHeader from '../components/common/SectionHeader';
import { Scroll, Search, RefreshCw, ChevronLeft, ChevronRight } from 'lucide-react';
import { queryKeys } from '../lib/queryKeys';
import { fetchPlatforms } from '../services/api/platforms';
import { useToast } from '../contexts/ToastContext';
import {
  type AuditLogEntry,
  actionBadgeStyle,
  auditLabel,
  auditActionGroups,
  describeAuditEntry,
  isSystemActor,
  requestParticipants,
} from '../lib/auditFormat';
import { AuditDetailModal } from '../components/audit/AuditDetailModal';

interface AuditResponse {
  items: AuditLogEntry[];
  total: number;
}

export const AuditLog: React.FC = () => {
  const queryClient = useQueryClient();
  const toast = useToast();

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [search, setSearch] = useState('');
  const [submittedSearch, setSubmittedSearch] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [platformFilter, setPlatformFilter] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [selectedEntry, setSelectedEntry] = useState<AuditLogEntry | null>(null);

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
  // Background refetch (filter/page change) while stale data is still shown via placeholderData.
  const isRefetching = auditQuery.isFetching && !isLoading;

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

  // Group names resolved once per render — the summary sentences reference groups by
  // name, and audit rows only carry the id.
  const groupNameById = new Map(groupOptions.map((g) => [g.id, g.name]));
  const summarize = (entry: AuditLogEntry) =>
    describeAuditEntry(entry, entry.groupId ? groupNameById.get(entry.groupId) : null);
  const formatParticipant = (name: string | null) =>
    name ? name.replace(/_/g, ' ') : 'Pending review';

  const isSyncing = syncMutation.isPending;

  return (
    <div>
      {/* Page Header */}
      <SectionHeader
        title="Platform Audit Log"
        actions={
          <button
            className="btn btn-primary btn-sm"
            onClick={() => syncMutation.mutate()}
            disabled={isSyncing}
            style={{ gap: '8px' }}
          >
            <RefreshCw size={16} style={{ animation: isSyncing ? 'spin 1.5s linear infinite' : 'none' }} />
            {isSyncing ? 'Syncing...' : 'Sync Platform Cache'}
          </button>
        }
      />

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
          <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-muted)' }}>Event:</span>
          <select
            className="form-select"
            style={{ width: '220px' }}
            value={actionFilter}
            onChange={(e) => {
              setActionFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All Events</option>
            {auditActionGroups().map((grp) => (
              <optgroup key={grp.category} label={grp.category}>
                {grp.actions.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </optgroup>
            ))}
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
          {isRefetching && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>
              <RefreshCw size={12} style={{ animation: 'spin 1.5s linear infinite' }} />
              Updating…
            </div>
          )}
          <div className="table-container" style={{ opacity: isRefetching ? 0.6 : 1, transition: 'opacity 0.15s' }}>
            <table className="hermes-table">
              <thead>
                <tr>
                  <th style={{ width: '140px' }}>When</th>
                  <th style={{ width: '190px' }}>Maker / checker</th>
                  <th style={{ width: '190px' }}>Event</th>
                  <th>What happened</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((entry) => {
                  const participants = requestParticipants(entry);
                  return (
                    <tr
                      key={entry.id}
                      className="audit-row"
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedEntry(entry)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelectedEntry(entry);
                        }
                      }}
                    >
                    <td style={{ fontSize: '13px', whiteSpace: 'nowrap' }}>
                      {formatDate(entry.createdAt)}
                    </td>
                    <td style={{ fontSize: '13px' }}>
                      {participants ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                          <span><strong>Maker:</strong> {formatParticipant(participants.maker)}</span>
                          <span><strong>Checker:</strong> {formatParticipant(participants.checker)}</span>
                        </div>
                      ) : isSystemActor(entry) ? (
                        <span
                          style={{
                            fontSize: '11px',
                            fontWeight: 800,
                            padding: '2px 8px',
                            borderRadius: 'var(--radius-sm)',
                            backgroundColor: 'var(--bg-app)',
                            border: '1px solid var(--border)',
                            color: 'var(--text-muted)',
                          }}
                        >
                          SYSTEM
                        </span>
                      ) : (
                        <strong>{entry.performerName.replace(/_/g, ' ')}</strong>
                      )}
                    </td>
                    <td>
                      <span
                        title={entry.action}
                        style={{
                          fontSize: '12px',
                          fontWeight: 800,
                          padding: '2px 8px',
                          borderRadius: 'var(--radius-sm)',
                          whiteSpace: 'nowrap',
                          ...actionBadgeStyle(entry.action),
                        }}
                      >
                        {auditLabel(entry.action)}
                      </span>
                    </td>
                    <td style={{ fontSize: '13px', maxWidth: '520px', whiteSpace: 'normal', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
                      {summarize(entry)}
                    </td>
                    </tr>
                  );
                })}
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
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span style={{ fontSize: '13px', color: 'var(--text-muted)', fontWeight: 600 }}>
                Showing page {page} of {totalPages} ({totalLogs} items)
              </span>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: 'var(--text-muted)', fontWeight: 600 }}>
                Per page
                <select
                  className="form-select"
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value));
                    setPage(1);
                  }}
                  style={{ width: 'auto', padding: '4px 8px' }}
                >
                  {[10, 25, 50, 100].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            </div>
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

      <AuditDetailModal
        entry={selectedEntry}
        groupName={selectedEntry ? groupOptions.find((g) => g.id === selectedEntry.groupId)?.name : null}
        onClose={() => setSelectedEntry(null)}
      />
    </div>
  );
};

export default AuditLog;
