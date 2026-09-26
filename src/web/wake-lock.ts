export type WakeState = 'off' | 'hidden' | 'requesting' | 'active' | 'unsupported' | 'denied' | 'released';

// Wake locks are advisory. Never spin on a browser/OS rejection or release.
export const screenWakeLock = ({ onState }: { onState: (state: WakeState) => void }) => {
  let enabled = false; let stopped = false; let pending = false; let generation = 0;
  let sentinel: WakeLockSentinel | undefined;
  const release = () => {
    const current = sentinel; sentinel = undefined;
    if (current) void current.release().catch(() => {});
  };
  const acquire = async () => {
    if (stopped || !enabled) return;
    if (document.visibilityState !== 'visible') { onState('hidden'); return; }
    if (!window.isSecureContext || !navigator.wakeLock) { onState('unsupported'); return; }
    if (sentinel || pending) return;
    pending = true; const own = generation; onState('requesting');
    try {
      const granted = await navigator.wakeLock.request('screen');
      if (stopped || !enabled || own !== generation || document.visibilityState !== 'visible') {
        await granted.release(); return;
      }
      if (granted.released) { onState('released'); return; }
      sentinel = granted; onState('active');
      granted.addEventListener('release', () => {
        if (sentinel !== granted) return;
        sentinel = undefined;
        if (enabled && !stopped) onState(document.visibilityState === 'visible' ? 'released' : 'hidden');
      }, { once: true });
    } catch { if (!stopped && enabled && own === generation) onState('denied'); }
    finally {
      pending = false;
      if (!stopped && enabled && own !== generation && document.visibilityState === 'visible') void acquire();
    }
  };
  const visibility = () => {
    generation++;
    if (document.visibilityState !== 'visible') { release(); if (enabled) onState('hidden'); }
    else void acquire();
  };
  document.addEventListener('visibilitychange', visibility);
  document.addEventListener('fullscreenchange', visibility);
  return {
    setEnabled: ({ value }: { value: boolean }) => {
      if (value === enabled || stopped) return;
      enabled = value; generation++;
      if (!enabled) { release(); onState('off'); }
      else void acquire();
    },
    retry: () => { void acquire(); },
    destroy: () => {
      stopped = true; generation++; release();
      document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('fullscreenchange', visibility);
    },
  };
};
