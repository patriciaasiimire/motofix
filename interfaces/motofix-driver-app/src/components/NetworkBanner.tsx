// NetworkBanner.tsx — shows a small "you're offline" bar whenever the device loses
// its internet connection, and hides itself again once back online. Rendered once at
// the top of the app (in App.tsx). Relies on the browser's online/offline events.

import { useState, useEffect } from 'react';
import { WifiOff } from 'lucide-react';
import { useRequests } from '@/contexts/RequestContext';

export function NetworkBanner() {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const { isWsPaused } = useRequests();

  useEffect(() => {
    const up = () => setIsOnline(true);
    const down = () => setIsOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  if (isOnline && !isWsPaused) return null;

  if (isOnline) {
    return (
      <div
        className="fixed top-0 inset-x-0 z-[100] flex items-center justify-center bg-muted/80 text-muted-foreground text-xs py-1 px-4"
        role="status"
      >
        Live updates paused
      </div>
    );
  }

  return (
    <div className="fixed top-0 inset-x-0 z-[100] flex items-center justify-center gap-2 bg-destructive text-destructive-foreground text-sm font-medium py-2 px-4">
      <WifiOff className="w-4 h-4 shrink-0" />
      No internet connection
    </div>
  );
}
