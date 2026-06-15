import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Unhandled render error:', error, info.componentStack);
  }

  handleReload = () => {
    // Hard reload bypasses the in-memory React tree and any cached HTML/JS,
    // which is what we actually want here — most blank-tab incidents are
    // either a corrupted runtime state or a stale asset bundle.
    window.location.reload();
  };

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        padding: '40px',
        background: 'var(--bg-app)',
        fontFamily: 'Outfit, sans-serif',
        textAlign: 'center',
      }}>
        <div style={{
          width: '72px',
          height: '72px',
          borderRadius: '20px',
          backgroundColor: 'var(--bg-card)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: 'var(--shadow-md)',
          border: '1px solid var(--border)',
          marginBottom: '24px',
          color: '#c53030',
        }}>
          <AlertTriangle size={36} />
        </div>
        <h1 style={{
          fontSize: '28px',
          fontWeight: 800,
          color: 'var(--text-main)',
          marginBottom: '12px',
        }}>
          Something went wrong
        </h1>
        <p style={{
          fontSize: '15px',
          color: 'var(--text-muted)',
          maxWidth: '480px',
          marginBottom: '24px',
          lineHeight: 1.5,
        }}>
          The page crashed unexpectedly. This is usually fixed by reloading. If it keeps happening, try opening the app in a new tab.
        </p>
        {import.meta.env.DEV && (
          <pre style={{
            background: '#1a1a1a',
            color: '#f87171',
            padding: '16px',
            borderRadius: 'var(--radius-md)',
            fontSize: '12px',
            maxWidth: '720px',
            overflow: 'auto',
            marginBottom: '24px',
            textAlign: 'left',
          }}>
            {this.state.error.message}
            {'\n\n'}
            {this.state.error.stack}
          </pre>
        )}
        <button
          onClick={this.handleReload}
          className="btn btn-primary"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}
        >
          <RefreshCw size={16} /> Reload page
        </button>
      </div>
    );
  }
}

export default ErrorBoundary;
