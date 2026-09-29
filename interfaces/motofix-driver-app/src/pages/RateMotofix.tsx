// RateMotofix.tsx — the screen asking the driver to rate the MOTOFIX app/service overall
// (stars + optional comment). Distinct from rating an individual mechanic.

import { useMemo, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  ArrowLeft,
  CheckCircle2,
  HeartHandshake,
  Loader2,
  MessageSquareText,
  Send,
  ShieldCheck,
  Sparkles,
  Star,
  ThumbsUp,
  Wrench,
} from 'lucide-react';
import { authService, requestsService } from '@/config/api';
import { toast } from 'sonner';

const Y = '#F59E0B';
const G = '#34D399';

const APP_TAGS = [
  'Fast assistance',
  'Easy to use',
  'Clear tracking',
  'Helpful diagnosis',
  'Good design',
  'Reliable updates',
];

const MECHANIC_TAGS = [
  'Quick response',
  'Professional',
  'Quality repair',
  'Good communication',
  'Fair pricing',
  'On time',
];

const APP_RATING_COPY: Record<number, { title: string; body: string }> = {
  1: { title: 'That was not good enough', body: 'Tell us what went wrong so we can fix the experience.' },
  2: { title: 'We can do better', body: 'Your feedback helps us improve dispatch, tracking, and support.' },
  3: { title: 'Thanks for being honest', body: 'Share what would make MOTOFIX more useful for you.' },
  4: { title: 'Glad MOTOFIX helped', body: 'A few details from you help us make the app even smoother.' },
  5: { title: 'Lovely. Thank you!', body: 'If MOTOFIX is working well for you, your review helps other drivers trust it too.' },
};

const MECHANIC_RATING_COPY: Record<number, { title: string; body: string }> = {
  1: { title: 'That was not good enough', body: 'We are sorry to hear that. Your feedback helps us maintain quality.' },
  2: { title: 'We can do better', body: 'Your feedback helps us ensure mechanics meet the expected standard.' },
  3: { title: 'Thanks for being honest', body: 'Tell us what would have made the service better.' },
  4: { title: 'Glad they helped you', body: 'Great to hear! A few more details help us match you with the best mechanics.' },
  5: { title: 'Excellent service!', body: 'Wonderful! Your rating helps this mechanic get more work on MOTOFIX.' },
};

interface LocationState {
  requestId?: string;
  mechanicName?: string;
  mechanicId?: string | number;
  serviceType?: string;
  description?: string;
  mode?: 'mechanic';
}

export default function RateMotofix() {
  const navigate = useNavigate();
  const location = useLocation();
  const state = (location.state ?? {}) as LocationState;
  const isMechanicMode = state.mode === 'mechanic' && !!state.requestId;
  const requestId = state.requestId;
  const mechanicName = state.mechanicName ?? 'your mechanic';
  const mechanicId = Number(state.mechanicId);

  const [rating, setRating] = useState(0);
  const [hovered, setHovered] = useState(0);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [feedback, setFeedback] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [preferenceStepDone, setPreferenceStepDone] = useState(!isMechanicMode || !Number.isSafeInteger(mechanicId) || mechanicId <= 0);
  const [savingPreference, setSavingPreference] = useState(false);
  const [preferredSaved, setPreferredSaved] = useState(false);

  const TAGS = isMechanicMode ? MECHANIC_TAGS : APP_TAGS;
  const RATING_COPY = isMechanicMode ? MECHANIC_RATING_COPY : APP_RATING_COPY;

  const activeRating = hovered || rating;
  const defaultCopy = isMechanicMode
    ? { title: `How did ${mechanicName} do?`, body: 'Rate the quality of service you received and help other drivers make better choices.' }
    : { title: 'How is MOTOFIX working for you?', body: 'Rate your driver app experience and help us improve roadside assistance for everyone.' };
  const copy = rating ? RATING_COPY[rating] : defaultCopy;

  const canSubmit = rating > 0;
  const selectedTagText = useMemo(() => selectedTags.join(', '), [selectedTags]);

  const toggleTag = (tag: string) => {
    setSelectedTags(prev =>
      prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]
    );
  };

  const submit = async () => {
    if (!canSubmit || isSubmitting) return;
    setIsSubmitting(true);

    const commentParts = [
      feedback.trim(),
      selectedTags.length ? `Highlights: ${selectedTags.join(', ')}` : '',
    ].filter(Boolean);
    const comment = commentParts.join(' | ');

    // Rating now (or already-reviewed) → drop the "Rate now" nudge so it never
    // re-appears on Home. It should only persist when the driver DEFERS rating.
    const clearReviewNudge = () => {
      if (!isMechanicMode) return;
      try { sessionStorage.removeItem('motofix_pending_review'); } catch { /* ignore */ }
    };

    try {
      if (isMechanicMode && requestId) {
        await requestsService.submitReview(requestId, { rating, comment });
      }

      localStorage.setItem('motofix_last_rating', JSON.stringify({
        rating,
        tags: selectedTags,
        feedback: feedback.trim(),
        submitted_at: new Date().toISOString(),
      }));
      clearReviewNudge();
      setSubmitted(true);
    } catch (err: any) {
      if (err?.response?.status === 409) {
        clearReviewNudge();  // already reviewed — also drop the nudge
        setSubmitted(true);
      } else {
        toast.error('Could not save your rating. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleBack = () => {
    if (isMechanicMode) {
      // '/' is the Splash screen (re-runs the entry/auth flow → bounces to login).
      // The Home tab is '/requests'.
      navigate('/requests', { replace: true });
    } else {
      navigate('/settings', { replace: true, state: { skipSettingsIntro: true } });
    }
  };

  const savePreferredHelper = async () => {
    if (!Number.isSafeInteger(mechanicId) || mechanicId <= 0 || savingPreference) return;
    setSavingPreference(true);
    try {
      await authService.savePreferences({ preferred_mechanic_id: mechanicId });
      setPreferredSaved(true);
      setPreferenceStepDone(true);
    } catch {
      toast.error('Could not save your preferred helper. You can still request help again.');
    } finally {
      setSavingPreference(false);
    }
  };

  const requestSimilarHelp = () => {
    const tow = /tow|recovery/i.test(state.serviceType ?? '');
    navigate('/locating', {
      state: {
        skipTriage: true,
        issueType: tow ? 'towing' : 'other',
        serviceType: tow ? 'towing_provider' : 'mechanic',
        reRequestServiceType: tow ? 'Tow / recovery' : 'Roadside assist',
        reRequestDescription: state.description ?? '',
        reRequestId: requestId,
      },
    });
  };

  const pageTitle = isMechanicMode ? `Rate ${mechanicName}` : 'Rate MOTOFIX';
  const pageLabel = isMechanicMode ? 'Job Review' : 'MOTOFIX Feedback';

  return (
    <div style={{
      minHeight: '100dvh',
      background: 'var(--page-bg)',
      color: 'var(--text-hi)',
      paddingBottom: 44,
    }}>
      <div style={{
        position: 'sticky',
        top: 0,
        zIndex: 20,
        background: 'var(--overlay-bg)',
        borderBottom: '1px solid var(--border-2)',
        backdropFilter: 'blur(18px)',
        WebkitBackdropFilter: 'blur(18px)',
      }}>
        <div style={{
          maxWidth: 680,
          margin: '0 auto',
          padding: 'max(env(safe-area-inset-top, 0px), 14px) 16px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}>
          <button
            onClick={handleBack}
            aria-label="Back"
            style={{
              width: 38,
              height: 38,
              borderRadius: 12,
              border: '1px solid var(--border-3)',
              background: 'var(--surface-3)',
              color: 'var(--text-md)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <ArrowLeft style={{ width: 18, height: 18 }} />
          </button>

          <div style={{ minWidth: 0, flex: 1 }}>
            <p style={{
              color: `${Y}d9`,
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: '0.2em',
              fontWeight: 800,
              marginBottom: 3,
            }}>
              {pageLabel}
            </p>
            <h1 style={{ color: 'var(--text-hi)', fontWeight: 900, fontSize: 19, lineHeight: 1.1 }}>
              {pageTitle}
            </h1>
          </div>
        </div>
      </div>

      <main style={{ maxWidth: 680, margin: '0 auto', padding: '22px 16px 0' }}>
        <section style={{
          borderRadius: 22,
          background: 'var(--surface-1)',
          border: '1px solid var(--border-2)',
          overflow: 'hidden',
          marginBottom: 18,
        }}>
          <div style={{
            padding: '24px 20px',
            background: `linear-gradient(135deg, ${Y}16, transparent 66%)`,
            borderBottom: '1px solid var(--border-1)',
          }}>
            <div style={{
              width: 58,
              height: 58,
              borderRadius: 18,
              background: submitted ? `${G}18` : `${Y}18`,
              border: `1.5px solid ${submitted ? `${G}3d` : `${Y}3d`}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 16,
              boxShadow: submitted ? `0 0 28px ${G}16` : `0 0 28px ${Y}16`,
            }}>
              {submitted
                ? <CheckCircle2 style={{ width: 28, height: 28, color: G }} />
                : <Star style={{ width: 28, height: 28, color: Y, fill: `${Y}44` }} />}
            </div>

            <h2 style={{
              color: 'var(--text-hi)',
              fontSize: 24,
              lineHeight: 1.15,
              fontWeight: 900,
              marginBottom: 10,
            }}>
              {submitted
                ? (isMechanicMode ? `Thanks for rating ${mechanicName}` : 'Thanks for rating MOTOFIX')
                : copy.title}
            </h2>

            <p style={{ color: 'var(--text-md)', fontSize: 13, lineHeight: 1.65, maxWidth: 560 }}>
              {submitted
                ? (isMechanicMode
                    ? 'Your review has been submitted. It helps us maintain a high standard of service.'
                    : 'Your feedback has been saved on this device. It will help shape the driver experience as we keep improving the app.')
                : copy.body}
            </p>
          </div>

          {!submitted ? (
            <div style={{ padding: '22px 20px 20px' }}>
              <div style={{ display: 'flex', justifyContent: 'center', gap: 9, marginBottom: 18 }}>
                {[1, 2, 3, 4, 5].map(value => {
                  const active = value <= activeRating;
                  return (
                    <button
                      key={value}
                      onClick={() => setRating(value)}
                      onMouseEnter={() => setHovered(value)}
                      onMouseLeave={() => setHovered(0)}
                      aria-label={`${value} star rating`}
                      style={{
                        width: 48,
                        height: 48,
                        borderRadius: 16,
                        border: active ? `1.5px solid ${Y}80` : '1.5px solid var(--border-2)',
                        background: active ? `${Y}18` : 'var(--surface-2)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        transition: 'transform 0.15s ease, background 0.15s ease, border-color 0.15s ease',
                        transform: active ? 'translateY(-2px)' : 'none',
                      }}
                    >
                      <Star
                        style={{
                          width: 25,
                          height: 25,
                          color: active ? Y : 'var(--text-faint)',
                          fill: active ? Y : 'transparent',
                        }}
                      />
                    </button>
                  );
                })}
              </div>

              <p style={{
                minHeight: 20,
                textAlign: 'center',
                color: rating ? Y : 'var(--text-dim)',
                fontSize: 12,
                fontWeight: 800,
                marginBottom: 20,
              }}>
                {rating ? `${rating} out of 5 stars` : 'Tap a star to rate'}
              </p>

              <div style={{ marginBottom: 20 }}>
                <p style={{ color: 'var(--text-hi)', fontSize: 13, fontWeight: 800, marginBottom: 10 }}>
                  What stood out?
                </p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {TAGS.map(tag => {
                    const active = selectedTags.includes(tag);
                    return (
                      <button
                        key={tag}
                        onClick={() => toggleTag(tag)}
                        style={{
                          minHeight: 34,
                          padding: '0 12px',
                          borderRadius: 999,
                          border: active ? `1px solid ${Y}66` : '1px solid var(--border-3)',
                          background: active ? `${Y}16` : 'var(--surface-2)',
                          color: active ? Y : 'var(--text-md)',
                          fontSize: 12,
                          fontWeight: 700,
                          cursor: 'pointer',
                        }}
                      >
                        {tag}
                      </button>
                    );
                  })}
                </div>
              </div>

              <label style={{ display: 'block', marginBottom: 18 }}>
                <span style={{ display: 'block', color: 'var(--text-hi)', fontSize: 13, fontWeight: 800, marginBottom: 10 }}>
                  Add a note
                </span>
                <textarea
                  value={feedback}
                  onChange={e => setFeedback(e.target.value)}
                  placeholder={isMechanicMode
                    ? 'Describe your experience with the mechanic...'
                    : 'Tell us what worked well or what we should improve...'}
                  rows={5}
                  style={{
                    width: '100%',
                    resize: 'vertical',
                    minHeight: 118,
                    borderRadius: 16,
                    border: '1px solid var(--border-3)',
                    background: 'var(--input-bg)',
                    color: 'var(--text-hi)',
                    padding: '13px 14px',
                    outline: 'none',
                    fontSize: 13,
                    lineHeight: 1.55,
                    fontFamily: 'inherit',
                  }}
                />
              </label>

              <button
                onClick={submit}
                disabled={!canSubmit || isSubmitting}
                style={{
                  width: '100%',
                  height: 52,
                  borderRadius: 16,
                  border: canSubmit ? `1px solid ${Y}70` : '1px solid var(--border-3)',
                  background: canSubmit ? `linear-gradient(135deg, ${Y}, #D97706)` : 'var(--surface-3)',
                  color: canSubmit ? '#111827' : 'var(--text-dim)',
                  fontSize: 14,
                  fontWeight: 900,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 9,
                  cursor: canSubmit ? 'pointer' : 'not-allowed',
                  boxShadow: canSubmit ? `0 10px 34px ${Y}30` : 'none',
                }}
              >
                {isSubmitting
                  ? <Loader2 style={{ width: 17, height: 17, animation: 'spin 1s linear infinite' }} />
                  : <Send style={{ width: 17, height: 17 }} />}
                {isSubmitting ? 'Submitting…' : 'Submit Rating'}
              </button>
            </div>
          ) : (
            <div style={{ padding: '22px 20px 20px' }}>
              {isMechanicMode && !preferenceStepDone && (
                <div style={{ borderRadius: 16, border: `1px solid ${Y}55`, background: `${Y}0d`, padding: 16, marginBottom: 18 }}>
                  <h3 style={{ color: 'var(--text-hi)', fontSize: 15, fontWeight: 900, marginBottom: 5 }}>Save {mechanicName} as your preferred helper?</h3>
                  <p style={{ color: 'var(--text-md)', fontSize: 12, lineHeight: 1.55, marginBottom: 13 }}>
                    Motofix will try them first when they are verified, available, nearby, and right for the job. Otherwise, we’ll look for the next suitable provider.
                  </p>
                  <div style={{ display: 'flex', gap: 9 }}>
                    <button onClick={savePreferredHelper} disabled={savingPreference} style={{ flex: 1, minHeight: 42, border: 'none', borderRadius: 12, background: Y, color: '#111827', fontWeight: 800, fontSize: 12, cursor: 'pointer', opacity: savingPreference ? 0.65 : 1 }}>
                      {savingPreference ? 'Saving…' : 'Save as preferred'}
                    </button>
                    <button onClick={() => setPreferenceStepDone(true)} style={{ minHeight: 42, padding: '0 13px', border: '1px solid var(--border-3)', borderRadius: 12, background: 'var(--surface-2)', color: 'var(--text-md)', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
                      Not now
                    </button>
                  </div>
                </div>
              )}
              {isMechanicMode && preferenceStepDone && (
                <div style={{ borderRadius: 14, background: 'var(--surface-2)', border: '1px solid var(--border-2)', padding: '11px 13px', marginBottom: 14 }}>
                  <p style={{ color: 'var(--text-md)', fontSize: 12, lineHeight: 1.5 }}>
                    {preferredSaved ? `${mechanicName} is saved as your preferred helper.` : 'Your next request stays on Motofix: we’ll check your preferred helper first, then the next suitable verified provider.'}
                  </p>
                </div>
              )}
              {isMechanicMode && preferenceStepDone && (
                <button onClick={requestSimilarHelp} style={{ width: '100%', minHeight: 50, border: 'none', borderRadius: 14, background: `linear-gradient(135deg, ${Y}, #D97706)`, color: '#111827', fontSize: 13, fontWeight: 900, cursor: 'pointer', marginBottom: 12 }}>
                  Need help again? Request in Motofix
                </button>
              )}
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 10,
                marginBottom: 18,
              }}>
                {[
                  { Icon: ThumbsUp, label: `${rating}/5`, sub: 'Rating' },
                  { Icon: Sparkles, label: selectedTags.length ? String(selectedTags.length) : '0', sub: 'Highlights' },
                  { Icon: MessageSquareText, label: feedback.trim() ? 'Yes' : 'No', sub: 'Note' },
                ].map(({ Icon, label, sub }) => (
                  <div
                    key={sub}
                    style={{
                      borderRadius: 16,
                      background: 'var(--surface-2)',
                      border: '1px solid var(--border-2)',
                      padding: '14px 10px',
                      textAlign: 'center',
                    }}
                  >
                    <Icon style={{ width: 18, height: 18, color: G, marginBottom: 7 }} />
                    <p style={{ color: 'var(--text-hi)', fontWeight: 900, fontSize: 14, marginBottom: 2 }}>{label}</p>
                    <p style={{ color: 'var(--text-dim)', fontSize: 10, fontWeight: 700 }}>{sub}</p>
                  </div>
                ))}
              </div>

              {(selectedTagText || feedback.trim()) && (
                <div style={{
                  borderRadius: 16,
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border-2)',
                  padding: 14,
                  marginBottom: 18,
                }}>
                  {selectedTagText && (
                    <p style={{ color: 'var(--text-md)', fontSize: 12, lineHeight: 1.55, marginBottom: feedback.trim() ? 8 : 0 }}>
                      <strong style={{ color: 'var(--text-hi)' }}>Highlights:</strong> {selectedTagText}
                    </p>
                  )}
                  {feedback.trim() && (
                    <p style={{ color: 'var(--text-md)', fontSize: 12, lineHeight: 1.55 }}>
                      <strong style={{ color: 'var(--text-hi)' }}>Note:</strong> {feedback.trim()}
                    </p>
                  )}
                </div>
              )}

              <button
                onClick={handleBack}
                style={{
                  width: '100%',
                  height: 50,
                  borderRadius: 16,
                  border: `1px solid ${G}50`,
                  background: `${G}16`,
                  color: G,
                  fontSize: 14,
                  fontWeight: 900,
                  cursor: 'pointer',
                }}
              >
                {isMechanicMode ? 'Back to Home' : 'Back to Settings'}
              </button>
            </div>
          )}
        </section>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 10,
        }}>
          {[
            { Icon: Wrench, title: 'Roadside', sub: 'Request flow' },
            { Icon: ShieldCheck, title: 'Safety', sub: 'Trusted help' },
            { Icon: HeartHandshake, title: 'Support', sub: 'Driver care' },
          ].map(({ Icon, title, sub }) => (
            <div
              key={title}
              style={{
                borderRadius: 16,
                background: 'var(--surface-1)',
                border: '1px solid var(--border-2)',
                padding: '14px 10px',
                textAlign: 'center',
              }}
            >
              <Icon style={{ width: 18, height: 18, color: Y, marginBottom: 8 }} />
              <p style={{ color: 'var(--text-hi)', fontSize: 12, fontWeight: 900, marginBottom: 2 }}>{title}</p>
              <p style={{ color: 'var(--text-dim)', fontSize: 10 }}>{sub}</p>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
