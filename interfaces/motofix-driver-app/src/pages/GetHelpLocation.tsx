// GetHelpLocation.tsx — the v1 "Where are you?" area-selection step (no GPS required).
//
// The driver picks a launch area (area_id) and optionally adds a landmark note
// (location_text) and a problem description. On submit we POST /requests/ and open
// the request detail. A clear message is shown if creation fails or matching is empty.
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { ArrowLeft, Check, ChevronDown, MapPin, Loader2, AlertTriangle } from 'lucide-react';
import { requestsService, SERVICE_AREAS } from '@/config/api';
import { useRequests } from '@/contexts/RequestContext';
import { toast } from 'sonner';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command';

export default function GetHelpLocation() {
  const navigate = useNavigate();
  const location = useLocation();
  const { requests, isLoading } = useRequests();
  const state = (location.state ?? {}) as { serviceType?: string; issueType?: string };
  const serviceType = state.serviceType === 'tow' ? 'tow' : 'mechanic';
  const issueType = state.issueType || 'general';

  const [areaId, setAreaId] = useState<number | null>(null);
  const [areaPickerOpen, setAreaPickerOpen] = useState(false);
  const [locationText, setLocationText] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isLoading) return;
    const active = requests.find((request) => request.status === 'searching' || request.status === 'assigned');
    if (active) navigate(`/requests/${active.id}`, { replace: true });
  }, [requests, isLoading, navigate]);

  const submit = async () => {
    const note = locationText.trim();
    const active = requests.find((request) => request.status === 'searching' || request.status === 'assigned');
    if (active) {
      navigate(`/requests/${active.id}`, { replace: true });
      return;
    }
    if (isLoading) return;
    if (areaId == null && !note) {
      setError('Choose an area or enter a location.');
      return;
    }
    if (issueType === 'other' && !description.trim()) {
      setError('Add a short description of what you need help with.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await requestsService.create({
        service_type: serviceType,
        issue_type: issueType,
        description: description.trim() || null,
        area_id: areaId,
        location_text: note || null,
        latitude: null,
        longitude: null,
      });
      const newId = String(res.data?.id ?? '');
      if (newId) {
        navigate(`/requests/${newId}`, { replace: true });
      } else {
        navigate('/requests', { replace: true });
      }
    } catch (e: unknown) {
      const detail = axios.isAxiosError<{ detail?: unknown }>(e) ? e.response?.data?.detail : null;
      const msg = typeof detail === 'string' ? detail : 'Could not create the request. Please try again.';
      setError(msg);
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ minHeight: '100dvh', background: 'var(--page-bg)', paddingBottom: 40 }}>
      <div style={{ maxWidth: 480, margin: '0 auto', padding: '0 16px' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 52, paddingBottom: 24 }}>
          <button
            onClick={() => navigate(-1)}
            style={{ width: 36, height: 36, borderRadius: '50%', border: 'none', background: 'var(--surface-3)', color: 'var(--text-md)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}
            aria-label="Back"
          >
            <ArrowLeft style={{ width: 18, height: 18 }} />
          </button>
          <div>
            <p style={{ color: 'rgba(245,158,11,0.75)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.22em', fontWeight: 700, marginBottom: 2 }}>
              {serviceType === 'tow' ? 'Tow' : 'Mechanic'} · {issueType.replace(/_/g, ' ')}
            </p>
            <h1 style={{ color: 'var(--text-hi)', fontWeight: 900, fontSize: 22, letterSpacing: '-0.02em', lineHeight: 1 }}>
              Where are you?
            </h1>
          </div>
        </div>

        {/* Area selector */}
        <p style={{ color: 'var(--text-md)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.22em', fontWeight: 700, marginBottom: 12 }}>
          Choose an area or enter a location
        </p>
        <Popover open={areaPickerOpen} onOpenChange={setAreaPickerOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Service area"
              aria-expanded={areaPickerOpen}
              style={{
                width: '100%', boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 10,
                padding: '14px', marginBottom: 20, borderRadius: 14, border: '1px solid var(--border-2)',
                background: 'var(--surface-1)', color: areaId == null ? 'var(--text-faint)' : 'var(--text-hi)',
                fontSize: 14, fontWeight: 700, textAlign: 'left', cursor: 'pointer',
              }}
            >
              <MapPin aria-hidden="true" style={{ width: 17, height: 17, color: '#F59E0B', flexShrink: 0 }} />
              <span style={{ flex: 1 }}>{SERVICE_AREAS.find((area) => area.id === areaId)?.name ?? 'Select your area (optional if you enter a location)'}</span>
              <ChevronDown aria-hidden="true" style={{ width: 17, height: 17, color: 'var(--text-faint)', flexShrink: 0 }} />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            sideOffset={4}
            className="w-[var(--radix-popover-trigger-width)] overflow-hidden p-0"
          >
            <Command>
              <CommandInput placeholder="Search areas..." />
              <CommandList
                style={{
                  maxHeight: 'min(55dvh, 20rem)',
                  overflowY: 'auto',
                  overscrollBehavior: 'contain',
                  WebkitOverflowScrolling: 'touch',
                }}
              >
                <CommandEmpty>No area found.</CommandEmpty>
                {SERVICE_AREAS.map((area) => (
                  <CommandItem
                    key={area.id}
                    value={`${area.name} ${area.id}`}
                    onSelect={() => {
                      setAreaId(area.id);
                      setAreaPickerOpen(false);
                    }}
                    className="min-h-11"
                  >
                    <Check
                      aria-hidden="true"
                      className="mr-2 h-4 w-4"
                      style={{ opacity: areaId === area.id ? 1 : 0, color: '#F59E0B' }}
                    />
                    {area.name}
                  </CommandItem>
                ))}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        {/* Optional landmark note */}
        <p style={{ color: 'var(--text-md)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.22em', fontWeight: 700, marginBottom: 8 }}>
          Landmark or note (optional)
        </p>
        <input
          value={locationText}
          onChange={(e) => setLocationText(e.target.value)}
          placeholder="e.g. Opposite Shell petrol station"
          maxLength={120}
          style={{
            width: '100%', boxSizing: 'border-box', padding: '13px 14px', borderRadius: 14,
            border: '1px solid var(--border-2)', background: 'var(--surface-1)', color: 'var(--text-hi)',
            fontSize: 14, outline: 'none', marginBottom: 16,
          }}
        />

        {/* Optional problem description */}
        <p style={{ color: 'var(--text-md)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.22em', fontWeight: 700, marginBottom: 8 }}>
          {issueType === 'other' ? 'Describe what happened' : 'Describe the problem (optional)'}
        </p>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={issueType === 'other' ? 'Tell us what kind of help you need' : "What's wrong with the vehicle?"}
          rows={3}
          maxLength={300}
          style={{
            width: '100%', boxSizing: 'border-box', padding: '13px 14px', borderRadius: 14,
            border: '1px solid var(--border-2)', background: 'var(--surface-1)', color: 'var(--text-hi)',
            fontSize: 14, outline: 'none', resize: 'vertical', marginBottom: 20, fontFamily: 'inherit',
          }}
        />

        {/* Error */}
        {error && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderRadius: 14, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', marginBottom: 16 }}>
            <AlertTriangle style={{ width: 16, height: 16, color: '#f87171', flexShrink: 0 }} />
            <p style={{ color: 'rgba(252,165,165,0.9)', fontSize: 12.5, lineHeight: 1.4 }}>{error}</p>
          </div>
        )}

        {/* Submit */}
        <button
          onClick={submit}
          disabled={submitting || isLoading}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            padding: '15px 0', borderRadius: 16, border: 'none',             cursor: submitting || isLoading ? 'not-allowed' : 'pointer',
            background: 'linear-gradient(135deg, #F59E0B, #D97706)', color: '#111827',
            fontWeight: 800, fontSize: 15, opacity: submitting || isLoading ? 0.7 : 1,
          }}
        >
          {submitting ? <Loader2 style={{ width: 18, height: 18, animation: 'spin 1s linear infinite' }} /> : null}
          {submitting ? 'Sending request…' : 'Request help'}
        </button>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
