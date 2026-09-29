// RequestCard.tsx — the summary tile for one service request, shown in the home/history
// lists. Displays the service type, status, time and location (turning raw coordinates
// into a readable address), and links through to the full request detail.

import { MapPin, Wrench, Clock, ChevronRight, Phone, Loader2, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { requestsService } from '@/config/api';
import { toast } from 'sonner';
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { reverseGeocode, isCoordString, parseCoordString } from '@/utils/geocode';

interface Request {
  id: number | string;  // Allow both — backend returns number
  service_type: string;
  location: string;
  description: string;
  status: string;
  created_at?: string;
}

interface RequestCardProps {
  request: Request;
  index: number;
  onReRequest?: () => void;
}

const statusConfig: Record<string, { label: string; className: string }> = {
  pending: {
    label: 'Pending',
    className: 'bg-warning/20 text-warning border-warning/30',
  },
  accepted: {
    label: 'Accepted',
    className: 'bg-primary/20 text-primary border-primary/30',
  },
  in_progress: {
    label: 'In Progress',
    className: 'bg-accent/20 text-accent border-accent/30',
  },
  completed: {
    label: 'Completed',
    className: 'bg-success/20 text-success border-success/30',
  },
  cancelled: {
    label: 'Cancelled',
    className: 'bg-destructive/20 text-destructive border-destructive/30',
  },
};

type GeocodeStatus = 'idle' | 'loading' | 'done' | 'error';

export function RequestCard({ request, index, onReRequest }: RequestCardProps) {
  const navigate = useNavigate();
  const status = statusConfig[request.status] || statusConfig.pending;
  const [isCalling, setIsCalling] = useState(false);
  const [displayLocation, setDisplayLocation] = useState<string>(request.location);
  const [geocodeStatus, setGeocodeStatus] = useState<GeocodeStatus>('idle');

  // Safely convert id to string and format as short ID (e.g., #000042)
  const shortId = `#${String(request.id).padStart(6, '0')}`;

  // Reverse geocode when location is raw coordinates (display only; never change stored value)
  useEffect(() => {
    const loc = request.location?.trim() ?? '';
    if (!isCoordString(loc)) {
      setDisplayLocation(loc || '—');
      setGeocodeStatus('idle');
      return;
    }
    const coords = parseCoordString(loc);
    if (!coords) {
      setDisplayLocation(loc);
      setGeocodeStatus('idle');
      return;
    }
    setGeocodeStatus('loading');
    let cancelled = false;
    reverseGeocode(coords.lat, coords.lng)
      .then((address) => {
        if (cancelled) return;
        if (address) {
          setDisplayLocation(address);
          setGeocodeStatus('done');
        } else {
          setDisplayLocation('Near your current location');
          setGeocodeStatus('error');
        }
      })
      .catch(() => {
        if (cancelled) return;
        setDisplayLocation('Near your current location');
        setGeocodeStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [request.location]);

  // Check if calling is allowed (only for accepted or en_route status)
  const canCallMechanic = request.status === 'accepted' || request.status === 'en_route';

  const handleCallMechanic = async (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent card click event
    
    if (!canCallMechanic) {
      toast.error('Calling is only available for active jobs');
      return;
    }

    setIsCalling(true);
    try {
      const response = await requestsService.getCallPartner(String(request.id));
      const phone = response.data.phone;
      
      // Never display the phone - just trigger the call
      if (phone) {
        window.location.href = `tel:${phone}`;
      }
    } catch (error: any) {
      const message = error.response?.data?.detail || 'Unable to call mechanic';
      toast.error(message);
    } finally {
      setIsCalling(false);
    }
  };

  return (
    <div 
      className="glass-card rounded-2xl p-4 animate-slide-up"
      style={{ animationDelay: `${index * 0.1}s` }}
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
            <Wrench className="w-6 h-6 text-primary" />
          </div>
          <div>
            <h3 className="font-semibold text-foreground">{request.service_type}</h3>
            <p className="text-sm text-muted-foreground">{shortId}</p>
          </div>
        </div>
        <span className={cn(
          "px-3 py-1 rounded-full text-xs font-medium border",
          status.className
        )}>
          {status.label}
        </span>
      </div>

      <div className="space-y-2 mb-3">
        <div className="flex items-start gap-2 text-sm min-h-[1.25rem]">
          <MapPin className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
          {geocodeStatus === 'loading' ? (
            <span className="text-muted-foreground inline-flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
              Finding address...
            </span>
          ) : (
            <span className="text-muted-foreground line-clamp-2" title={displayLocation}>
              {displayLocation || '—'}
            </span>
          )}
        </div>
        {request.description && (
          <p className="text-sm text-muted-foreground line-clamp-2 pl-6">
            {request.description}
          </p>
        )}
      </div>

      <div className="flex items-center justify-between pt-3 border-t border-border/50">
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Clock className="w-3.5 h-3.5" />
          <span>
            {request.created_at 
              ? new Date(request.created_at).toLocaleDateString('en-UG', {
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : 'Just now'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {canCallMechanic && (
            <button
              onClick={handleCallMechanic}
              disabled={isCalling}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title="Call Mechanic"
            >
              <Phone className="w-4 h-4" />
              {isCalling ? 'Calling...' : 'Call'}
            </button>
          )}
          <button
            onClick={() => navigate(`/requests/${request.id}`)}
            className="flex items-center gap-1 text-primary text-sm font-medium hover:gap-2 transition-all"
          >
            View Details
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {request.status === 'completed' && onReRequest && (
        <button
          onClick={onReRequest}
          className="mt-3 flex min-h-10 w-full items-center justify-center gap-2 rounded-xl border border-primary/35 bg-primary/10 px-3 text-sm font-semibold text-primary transition-colors hover:bg-primary/15"
        >
          <RefreshCw className="h-4 w-4" />
          Need similar help again?
        </button>
      )}
    </div>
  );
}