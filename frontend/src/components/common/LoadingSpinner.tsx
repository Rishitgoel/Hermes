import React from 'react';
import { Loader2 } from 'lucide-react';

interface LoadingSpinnerProps {
  fullPage?: boolean;
  message?: string;
}

export const LoadingSpinner: React.FC<LoadingSpinnerProps> = ({ 
  fullPage = false, 
  message = 'Securing Access...' 
}) => {
  if (fullPage) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        width: '100vw',
        background: 'radial-gradient(circle at 50% 50%, hsl(260, 20%, 97%) 0%, var(--bg-app) 100%)',
        position: 'fixed',
        top: 0,
        left: 0,
        zIndex: 9999,
        fontFamily: 'Outfit, sans-serif'
      }}>
        {/* Style definitions */}
        <style>{`
          @keyframes float {
            0% { transform: translateY(0px); }
            50% { transform: translateY(-10px); }
            100% { transform: translateY(0px); }
          }
          @keyframes pulse-glow {
            0% { box-shadow: 0 0 0 0 hsla(262, 60%, 48%, 0.15); }
            70% { box-shadow: 0 0 0 15px hsla(262, 60%, 48%, 0); }
            100% { box-shadow: 0 0 0 0 hsla(262, 60%, 48%, 0); }
          }
          @keyframes progress-run {
            0% { left: -30%; width: 30%; }
            50% { left: 20%; width: 60%; }
            100% { left: 100%; width: 30%; }
          }
          @keyframes fade-in-up {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
          }
        `}</style>

        {/* Logo and Brand */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '24px',
          animation: 'fade-in-up 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards'
        }}>
          {/* Logo container with pulsing glow and floating effect */}
          <div style={{
            width: '96px',
            height: '96px',
            borderRadius: '24px',
            backgroundColor: '#ffffff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: 'var(--shadow-lg)',
            border: '1px solid var(--border)',
            animation: 'float 3s ease-in-out infinite, pulse-glow 2s infinite',
            position: 'relative'
          }}>
            <img 
              src="/assets/logo.png" 
              alt="Bachatt Logo" 
              style={{
                height: '52px',
                width: 'auto',
                objectFit: 'contain'
              }} 
            />
          </div>

          {/* Text branding */}
          <div style={{ textAlign: 'center' }}>
            <h1 style={{
              fontSize: '32px',
              fontWeight: 800,
              letterSpacing: '0.1em',
              background: 'linear-gradient(135deg, var(--primary), var(--secondary))',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              marginBottom: '6px'
            }}>
              ATLAS
            </h1>
            <p style={{
              fontSize: '11px',
              color: 'var(--text-light)',
              fontWeight: 800,
              letterSpacing: '0.15em',
              textTransform: 'uppercase'
            }}>
              Bachatt Access Portal
            </p>
          </div>

          {/* Sleek Line Progress Loader */}
          <div style={{
            width: '180px',
            height: '4px',
            backgroundColor: 'var(--border)',
            borderRadius: '999px',
            position: 'relative',
            overflow: 'hidden',
            marginTop: '12px'
          }}>
            <div style={{
              position: 'absolute',
              height: '100%',
              backgroundColor: 'var(--primary)',
              borderRadius: '999px',
              animation: 'progress-run 1.6s ease-in-out infinite'
            }} />
          </div>

          {/* Message */}
          <span style={{
            fontSize: '13px',
            fontWeight: 600,
            color: 'var(--text-muted)',
            marginTop: '8px'
          }}>
            {message}
          </span>
        </div>
      </div>
    );
  }

  // Inline / Smaller Loader
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '200px',
      height: '100%',
      width: '100%',
      gap: '16px'
    }}>
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
      <Loader2 
        size={36} 
        style={{
          color: 'var(--primary)',
          animation: 'spin 0.8s linear infinite'
        }}
      />
      <span style={{ 
        fontFamily: 'Outfit, sans-serif', 
        fontSize: '14px', 
        fontWeight: 600, 
        color: 'var(--text-muted)' 
      }}>
        {message}
      </span>
    </div>
  );
};

export default LoadingSpinner;
