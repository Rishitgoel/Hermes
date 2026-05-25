import React from 'react';
import { Loader2 } from 'lucide-react';

export const LoadingSpinner: React.FC = () => {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '250px',
      height: '100%',
      width: '100%',
      gap: '16px'
    }}>
      <Loader2 
        size={44} 
        style={{
          color: 'var(--primary)',
          animation: 'spin 1s linear infinite'
        }}
      />
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
      <span style={{ 
        fontFamily: 'Outfit, sans-serif', 
        fontSize: '15px', 
        fontWeight: 600, 
        color: 'var(--text-muted)' 
      }}>
        Loading Atlas...
      </span>
    </div>
  );
};

export default LoadingSpinner;
