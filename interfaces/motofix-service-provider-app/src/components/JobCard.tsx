// JobCard.tsx — the summary tile for one job in the mechanic's lists (available/active/past):
// shows the fault, location, time and status, and is tappable to open the full job details.

import {
  Zap, Settings, Circle, Droplets, Key, Truck,
  Thermometer, HelpCircle, MapPin, Clock, User, Phone,
  Wrench, FileText, Info, DollarSign, ExternalLink, Navigation2,
} from 'lucide-react'
import { C } from '@/styles/tokens'
import { useTheme } from '@/contexts/ThemeContext'
import { formatRelativeTime, formatUGX } from '@/utils/formatters'
import { useReadableLocation } from '@/utils/geocode'
import type { ServiceRequest } from '@/types'

const ISSUE_ICONS: Record<string, React.ElementType> = {
  Battery: Zap,
  Engine: Settings,
  Tyre: Circle,
  Fuel: Droplets,
  Lockout: Key,
  Towing: Truck,
  Overheating: Thermometer,
  Other: HelpCircle,
}

function getIssueIcon(type?: string): React.ElementType {
  if (!type) return HelpCircle
  const key = Object.keys(ISSUE_ICONS).find(k => type.toLowerCase().includes(k.toLowerCase()))
  return key ? ISSUE_ICONS[key] : HelpCircle
}

interface Props {
  request: ServiceRequest
  distance?: number
  onAccept: () => void
  onViewDetails: () => void
  expanded?: boolean
}

function DetailRow({
  icon, label, value, multiline, highlight,
}: {
  icon: React.ReactNode
  label: string
  value: string
  multiline?: boolean
  highlight?: boolean
}) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: multiline ? 'flex-start' : 'center' }}>
      <div style={{
        width: 28, height: 28, borderRadius: 8, flexShrink: 0,
        background: `${C.amber}12`, border: `1px solid ${C.amber}22`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{
          fontSize: 10, fontWeight: 800, color: C.textFaint,
          textTransform: 'uppercase', letterSpacing: '0.09em', marginBottom: 2,
        }}>
          {label}
        </p>
        <p style={{
          fontSize: 13, fontWeight: highlight ? 800 : 600,
          color: highlight ? C.amber : C.textHi,
          lineHeight: 1.5, wordBreak: 'break-word',
        }}>
          {value}
        </p>
      </div>
    </div>
  )
}

export default function JobCard({ request, distance, onAccept, onViewDetails, expanded }: Props) {
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const cardBorder = isDark ? '1.5px solid rgba(255,255,255,0.18)' : '1.5px solid rgba(0,0,0,0.65)'

  const IssueIcon = getIssueIcon(request.issue_type ?? request.service_type)
  const isTowJob = /tow|recovery/i.test(request.service_type ?? '')
  const jobTypeLabel = isTowJob ? 'Tow / recovery' : 'Roadside assist'
  const hasCoords = request.location_lat != null && request.location_lng != null
  const locationText = useReadableLocation(request)

  const isNear = distance != null && distance < 3
  const distanceColor = isNear ? C.green : distance != null && distance < 8 ? C.amber : C.textFaint

  return (
    <div style={{
      borderRadius: 16,
      border: cardBorder,
      boxShadow: isDark ? '0 2px 12px rgba(0,0,0,0.18)' : '0 2px 12px rgba(0,0,0,0.10)',
      background: 'var(--surface-1)',
    }}>
      <div style={{ padding: '14px' }}>
        {/* Top row: issue icon + name + time */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 38, height: 38, borderRadius: 12, flexShrink: 0,
              background: `${C.amber}16`, border: `1.5px solid ${C.amber}30`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <IssueIcon style={{ width: 17, height: 17, color: C.amber }} />
            </div>
            <div>
              <p style={{ fontSize: 14, fontWeight: 900, color: C.textHi, letterSpacing: '-0.01em' }}>
                {request.issue_type ?? jobTypeLabel}
              </p>
              <span style={{ display: 'inline-block', marginTop: 3, borderRadius: 999, padding: '2px 7px', background: `${isTowJob ? C.blue : C.green}14`, color: isTowJob ? C.blue : C.green, fontSize: 9, fontWeight: 800 }}>
                {jobTypeLabel}
              </span>
              {request.driver_name && (
                <p style={{ fontSize: 11, color: C.textFaint, marginTop: 1 }}>
                  {request.driver_name}
                </p>
              )}
            </div>
          </div>
          <span style={{ fontSize: 11, color: C.textFaint, flexShrink: 0, paddingTop: 2 }}>
            {formatRelativeTime(request.created_at)}
          </span>
        </div>

        {/* Distance + location row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
          {distance != null && (
            <span style={{
              fontSize: 11, fontWeight: 800, color: distanceColor,
              background: `${distanceColor}14`, border: `1px solid ${distanceColor}30`,
              borderRadius: 20, padding: '3px 9px', flexShrink: 0,
              display: 'flex', alignItems: 'center', gap: 4,
            }}>
              <Navigation2 style={{ width: 10, height: 10 }} />
              {distance.toFixed(1)} km
            </span>
          )}
          {locationText && (
            <span style={{
              fontSize: 12, color: C.textFaint,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
            }}>
              <MapPin style={{ width: 11, height: 11, display: 'inline', marginRight: 3 }} />
              {locationText}
            </span>
          )}
        </div>

        {/* Description preview (collapsed) */}
        {!expanded && request.description && (
          <p style={{
            fontSize: 12, color: C.textFaint, marginBottom: 10,
            overflow: 'hidden', display: '-webkit-box',
            WebkitLineClamp: 1, WebkitBoxOrient: 'vertical',
          }}>
            {request.description}
          </p>
        )}

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onViewDetails}
            style={{
              flex: 1, height: 38, borderRadius: 11, cursor: 'pointer',
              background: expanded ? `${C.amber}12` : 'transparent',
              border: expanded
                ? `1.5px solid ${C.amber}40`
                : isDark ? '1.5px solid rgba(255,255,255,0.12)' : '1.5px solid rgba(0,0,0,0.20)',
              color: expanded ? C.amber : C.textMuted,
              fontSize: 12, fontWeight: 700,
              transition: 'all 0.15s ease',
            }}>
            {expanded ? 'Hide Details' : 'View Details'}
          </button>
          <button onClick={onAccept}
            style={{
              flex: 1, height: 38, borderRadius: 11, cursor: 'pointer',
              background: `linear-gradient(135deg, ${C.amber}, ${C.amberDark})`,
              border: 'none', color: '#000', fontSize: 13, fontWeight: 900,
              letterSpacing: '-0.01em',
            }}>
            Accept Job
          </button>
        </div>

        {/* Expanded details */}
        {expanded && (
          <div style={{
            marginTop: 14,
            borderTop: isDark ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgba(0,0,0,0.10)',
            paddingTop: 14,
            display: 'flex', flexDirection: 'column', gap: 10,
          }}>
            <DetailRow icon={<Wrench style={{ width: 13, height: 13, color: C.amber }} />} label="Issue" value={request.issue_type ?? request.service_type ?? 'Not specified'} />
            {request.description && (
              <DetailRow icon={<FileText style={{ width: 13, height: 13, color: C.amber }} />} label="Description" value={request.description} multiline />
            )}
            {request.service_type && request.issue_type && request.service_type !== request.issue_type && (
              <DetailRow icon={<Info style={{ width: 13, height: 13, color: C.amber }} />} label="Service Type" value={request.service_type} />
            )}
            {locationText && (
              <DetailRow icon={<MapPin style={{ width: 13, height: 13, color: C.amber }} />} label="Location" value={locationText} />
            )}
            {request.driver_name && (
              <DetailRow icon={<User style={{ width: 13, height: 13, color: C.amber }} />} label="Driver" value={request.driver_name} />
            )}
            {request.driver_phone && (
              <DetailRow icon={<Phone style={{ width: 13, height: 13, color: C.amber }} />} label="Contact" value={request.driver_phone} />
            )}
            {hasCoords && (
              <a
                href={`https://www.google.com/maps?q=${request.location_lat},${request.location_lng}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                  padding: '10px', borderRadius: 11, textDecoration: 'none',
                  background: `${C.amber}0E`,
                  border: isDark ? `1px solid ${C.amber}28` : `1.5px solid ${C.amber}40`,
                  color: C.amber, fontSize: 12, fontWeight: 700,
                }}
              >
                <ExternalLink style={{ width: 13, height: 13 }} />
                View Location on Map
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
