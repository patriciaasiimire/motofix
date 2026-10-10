// SelfFixGuides.tsx — a browsable library of simple "fix it yourself" guides for common
// faults, with steps and YouTube how-to links, plus a shortcut to ask MOTOBOT. Helps a
// driver attempt a safe quick fix (e.g. changing a tyre) before requesting a mechanic.

import { useState, useMemo } from 'react'
import type { ElementType } from 'react'
import { useNavigate } from 'react-router-dom'
import { MOTOBOT_ENABLED } from '@/config/features'
import {
  ArrowLeft, Search, X, ChevronDown, ChevronRight, AlertTriangle, ListChecks,
  Youtube, Bot, Cog, CircleDot, Battery, Disc3, Zap, Droplets, Settings2, Car, Fuel, Wind,
} from 'lucide-react'

const AMBER = '#F59E0B'
const YT_RED = '#FF0000'

/* YouTube search for an issue — opens a fresh how-to results page. */
function ytUrl(q: string) {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(q + ' car repair tutorial')}`
}

/* ── Car systems data (shared look with the mechanic app's Guides) ─────────── */
type Issue  = { name: string; symptoms: string[]; steps: string[] }
type System = { id: string; name: string; Icon: ElementType; color: string; desc: string; issues: Issue[] }

const CAR_SYSTEMS: System[] = [
  {
    id: 'engine', name: 'Engine', Icon: Cog, color: '#F59E0B', desc: 'Internal combustion, oil, timing',
    issues: [
      { name: 'Engine Overheating', symptoms: ['Temperature warning light on', 'Steam rising from bonnet', 'Sweet/burning smell', 'Coolant loss'], steps: ['Check coolant level first — top up if low (cold engine only)', 'Inspect radiator for leaks or blockage', 'Test water pump and thermostat', 'Check radiator cap seal', 'Look for cracked hoses'] },
      { name: 'Oil Leak', symptoms: ['Dark spots under the vehicle', 'Burning oil smell while driving', 'Low oil warning light', 'Blue/grey exhaust smoke'], steps: ['Identify exact leak source before doing anything else', 'Common spots: valve cover gasket, drain plug, oil filter', 'Clean the engine and run it to locate the leak', 'Replace worn gaskets or seals — do not over-tighten'] },
      { name: "Engine Won't Start", symptoms: ['No cranking sound', "Cranks but won't fire", 'Clicking noise only', 'Engine turns over slowly'], steps: ['Check battery voltage — should read 12.4V+', 'Test starter motor and solenoid', 'Check fuel pump — listen for hum when key turns to ON', 'Inspect spark plugs and ignition coils', 'Check for fault codes with OBD scanner'] },
      { name: 'Rough Idle / Misfires', symptoms: ['Engine shaking at idle', 'Loss of power', 'Poor fuel economy', 'Check engine light flashing'], steps: ['Check spark plugs — replace if worn or fouled', 'Test ignition coils one at a time', 'Clean or replace dirty fuel injectors', 'Check for vacuum leaks — listen for hissing', 'Inspect MAF and oxygen sensors'] },
      { name: 'Timing Belt / Chain', symptoms: ['Ticking noise from engine', "Engine won't start suddenly", 'Slapping noise at startup'], steps: ['Timing belt should be replaced every 60–100k km', 'Never run engine if timing belt is suspected broken — valve damage', 'Check timing marks carefully before reassembly', 'Always replace tensioner and idler with belt'] },
    ],
  },
  {
    id: 'tyres', name: 'Tyres', Icon: CircleDot, color: '#60A5FA', desc: 'Flats, pressure, alignment, wear',
    issues: [
      { name: 'Flat Tyre', symptoms: ['Vehicle pulling to one side', 'Vibration through steering', 'Visible deflation', 'Thumping noise'], steps: ['Engage hazard lights immediately', 'Park well off the road before changing', 'Loosen wheel nuts before jacking', 'Never work under a vehicle supported only by a jack', 'Check spare tyre pressure before fitting'] },
      { name: 'Tyre Wear Patterns', symptoms: ['Centre wear: overinflation', 'Edge wear: underinflation', 'One-side wear: alignment issue', 'Cupping/scalloping: suspension problem'], steps: ['Check tyre pressure monthly — correct to vehicle placard', 'Rotate tyres every 10,000 km', 'Get wheel alignment when fitting new tyres or after a pothole', 'Uneven wear often means worn shocks — inspect suspension'] },
      { name: 'Tyre Pressure Issues', symptoms: ['TPMS warning light', 'Poor fuel economy', 'Handling feels vague', 'Tyres look low visually'], steps: ['Always check cold pressure (before driving)', "Refer to sticker inside driver's door for correct PSI", "Don't forget the spare when checking", 'Temperature drops 1 PSI per 5°C — recheck seasonally'] },
    ],
  },
  {
    id: 'battery', name: 'Battery', Icon: Battery, color: '#4ADE80', desc: 'Charging, jump starts, replacement',
    issues: [
      { name: 'Dead Battery', symptoms: ['No power when turning key', 'Dim lights', 'Rapid clicking from starter', 'Battery warning light'], steps: ['Jump start: red to dead+ → red to good+ → black to good- → black to bare metal on dead car', 'Run engine for 20–30 min after jump to recharge', 'Test battery with multimeter: 12.6V = good, below 12.0V = replace', 'Check for parasitic drain if battery keeps dying'] },
      { name: 'Battery Not Charging', symptoms: ['Battery warning light while driving', 'Voltage reads below 13.5V while running', 'Lights dim while driving', 'Battery keeps going flat'], steps: ['Test alternator output — should be 13.8–14.7V at idle', 'Check alternator belt for wear or slipping', 'Inspect battery terminals for corrosion — clean with baking soda', 'Test voltage regulator if alternator output is unstable'] },
      { name: 'Corroded Terminals', symptoms: ['White/blue powder on terminals', 'Slow cranking', 'Electrical issues', 'Battery voltage drops suddenly'], steps: ['Disconnect negative terminal first, then positive', 'Clean with baking soda and warm water', 'Use a wire brush or terminal cleaner', 'Apply petroleum jelly after cleaning to prevent recurrence', 'Reconnect positive first, then negative'] },
    ],
  },
  {
    id: 'brakes', name: 'Brakes', Icon: Disc3, color: '#F87171', desc: 'Pads, discs, fluid, ABS',
    issues: [
      { name: 'Squealing Brakes', symptoms: ['High-pitched squeal when braking', 'Noise stops when brake is released', 'Grinding when severe'], steps: ['Squeal = wear indicator touching disc — replace pads now', 'Grinding = metal-to-metal — replace pads AND discs', 'Check pad thickness: minimum 3mm', 'Dust or moisture causes temporary squeal — this is normal'] },
      { name: 'Soft / Spongy Brake Pedal', symptoms: ['Pedal sinks to floor', 'Reduced braking power', 'Pedal feels different from usual'], steps: ['Likely air in the brake lines — needs bleeding', 'Check brake fluid level in reservoir', 'Inspect all brake lines and hoses for leaks', 'Check master cylinder if fluid is full but pedal is still soft', 'Do NOT drive if pedal goes to floor — serious safety risk'] },
      { name: 'Vehicle Pulls When Braking', symptoms: ['Car pulls left or right under braking', 'One wheel locking up', 'Uneven pad wear'], steps: ['Check caliper — may be seized on the pulling side', 'Inspect brake hoses for internal collapse', 'Check for contaminated pads (oil or fluid)', 'Verify both sides have matching pads and disc condition'] },
      { name: 'Brake Fluid', symptoms: ['Low fluid level', 'Dark/dirty fluid', 'Brake warning light'], steps: ['Brake fluid should be clear to light yellow — dark = contaminated', 'Replace fluid every 2 years or when moisture content is high', 'DOT 4 is most common — never mix DOT types', 'Low fluid = either leak or worn pads (normal) — always check both'] },
    ],
  },
  {
    id: 'electrical', name: 'Electrical', Icon: Zap, color: '#A78BFA', desc: 'Fuses, lights, sensors, wiring',
    issues: [
      { name: 'Fuse Problems', symptoms: ['Specific component not working', 'Fuse box shows blown fuse', 'Circuit keeps blowing fuses'], steps: ['Find the correct fuse box (usually under dash and in engine bay)', 'Never replace a fuse with higher amperage — find the cause', 'Test fuses with a test light or multimeter', 'Repeatedly blown fuse = short circuit — trace the wiring'] },
      { name: 'Warning Lights', symptoms: ['Check engine light', 'ABS light', 'Airbag light', 'Service lights'], steps: ['Use an OBD2 scanner to read fault codes — essential for diagnosis', 'Check engine light flashing = active misfire — reduce load immediately', "ABS light alone doesn't disable normal brakes", 'Airbag light = do NOT disturb wiring — safety system risk'] },
      { name: 'Alternator Failure', symptoms: ['Battery warning light', 'Electrical systems failing while driving', 'Whining noise from engine bay', 'Burning rubber smell'], steps: ['Test output: should be 13.8–14.7V at idle with accessories on', 'Inspect serpentine belt first — simple fix if worn', 'Check alternator diodes — AC ripple on DC output means diode failure', 'Replace brushes before full alternator if accessible'] },
    ],
  },
  {
    id: 'cooling', name: 'Cooling', Icon: Droplets, color: '#38BDF8', desc: 'Radiator, coolant, thermostat',
    issues: [
      { name: 'Coolant Leak', symptoms: ['Puddle under car (sweet smell)', 'Reservoir keeps emptying', 'Overheating', 'White exhaust smoke'], steps: ['Pressure test the cooling system to find leaks', 'Check radiator, hoses, heater core, water pump weep hole', 'White exhaust smoke = coolant in combustion chamber — head gasket', 'Never open radiator cap when engine is hot — severe burn risk'] },
      { name: 'Thermostat Failure', symptoms: ['Engine takes too long to warm up (stuck open)', 'Engine overheats quickly (stuck closed)', 'Temperature gauge erratic'], steps: ["Stuck open: heater won't heat, engine runs cold — replace thermostat", 'Stuck closed: overheating within minutes — replace immediately', 'Thermostats are cheap — always replace when doing water pump or timing belt'] },
    ],
  },
  {
    id: 'transmission', name: 'Transmission', Icon: Settings2, color: '#FB923C', desc: 'Gearbox, clutch, fluid',
    issues: [
      { name: 'Clutch Problems (Manual)', symptoms: ['Slipping under load', 'Hard to engage gears', 'Grinding when changing', 'Clutch pedal to floor'], steps: ['Slipping = worn clutch plate — replacement needed', 'Hard pedal = worn cable or hydraulic issue', 'Grinding = synchroniser wear or clutch not fully disengaging', 'Adjust clutch pedal free-play first — often overlooked'] },
      { name: 'Automatic Gearbox Issues', symptoms: ['Harsh shifts', 'Slipping between gears', 'Delayed engagement', 'Gearbox warning light'], steps: ['Check ATF level and condition — burnt smell = damage', 'Change transmission fluid every 60k km', 'Solenoid or valve body issues are common causes of harsh shifts', 'Never tow a vehicle with auto trans beyond short distances'] },
    ],
  },
  {
    id: 'suspension', name: 'Suspension', Icon: Car, color: '#34D399', desc: 'Shocks, struts, steering',
    issues: [
      { name: 'Worn Shock Absorbers', symptoms: ['Bouncing after bumps', 'Nose diving under braking', 'Body roll in corners', 'Cupped tyre wear'], steps: ['Bounce test: push each corner — car should settle in 1–2 bounces', 'Replace in axle pairs — never one side only', 'Worn shocks increase stopping distance by up to 20%', 'Check for oil leaks on shock body'] },
      { name: 'Steering Problems', symptoms: ['Loose/vague steering', 'Vibration through wheel', 'Noise when turning', 'Pulling to one side'], steps: ['Check power steering fluid level', 'Inspect tie rod ends and ball joints for play', 'Vibration at highway speed = wheel balance issue', 'Noise when turning = CV joint or power steering pump'] },
    ],
  },
  {
    id: 'fuel', name: 'Fuel System', Icon: Fuel, color: '#FBBF24', desc: 'Pump, injectors, filter',
    issues: [
      { name: 'Fuel Pump Failure', symptoms: ["Car won't start (no pump hum)", 'Engine stutters at high load', 'Loss of power going uphill', 'Whining from fuel tank'], steps: ['Listen for pump hum for 2 sec when key turns to ON — silence = pump issue', 'Test fuel pressure at rail — spec varies by vehicle', 'Check fuel filter first — blockage can mimic pump failure', 'Strainer in tank can clog — often replaced with pump'] },
      { name: 'Dirty Fuel Injectors', symptoms: ['Rough idle', 'Poor fuel economy', 'Hesitation on acceleration', 'Black smoke'], steps: ['Use fuel injector cleaner in tank as first step', 'Professional ultrasonic cleaning for badly clogged injectors', 'Test injector spray pattern — should be fine mist, not stream', 'Check fuel pressure regulator if all injectors seem affected'] },
    ],
  },
  {
    id: 'exhaust', name: 'Exhaust', Icon: Wind, color: '#9CA3AF', desc: 'Pipes, catalytic converter, DPF',
    issues: [
      { name: 'Exhaust Leaks', symptoms: ['Ticking/popping noise', 'Smell of exhaust inside cabin', 'Louder engine note', 'Failed emissions test'], steps: ['Carbon black soot around joints = leak location', 'Run engine in dark — visible wisps of smoke reveal leaks', 'Exhaust leaks before O2 sensor affect fuel trim', 'Do NOT ignore cabin exhaust smell — carbon monoxide risk'] },
      { name: 'Catalytic Converter', symptoms: ['Rotten egg smell', 'Check engine light (O2 sensor codes)', 'Reduced power', 'Rattling from under car'], steps: ['Rattling = substrate broken inside — replace cat', 'Rich running damages cats — fix fuel/ignition issues first', 'Cat theft is common — check vehicle underside for signs', 'DPF (diesel) — ensure enough highway driving to regenerate'] },
    ],
  },
]

/**
 * Self-Fix guides — searchable car-systems reference with symptom/step accordions
 * and YouTube how-to links. Mirrors the mechanic app's Guides tab, framed for a
 * driver doing a roadside self-fix. Rendered inside the Spare Parts hub's content
 * area (the hub supplies the header + tab bar), so this owns no top chrome.
 */
export default function SelfFixGuides() {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [selectedSystem, setSelectedSystem] = useState<System | null>(null)
  const [expandedIssue, setExpandedIssue] = useState<string | null>(null)

  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length < 2) return [] as { name: string; systemName: string; SystemIcon: ElementType; systemColor: string }[]
    const out: { name: string; systemName: string; SystemIcon: ElementType; systemColor: string }[] = []
    for (const sys of CAR_SYSTEMS) {
      for (const issue of sys.issues) {
        const hay = (issue.name + ' ' + sys.name + ' ' + issue.symptoms.join(' ')).toLowerCase()
        if (hay.includes(q)) out.push({ name: issue.name, systemName: sys.name, SystemIcon: sys.Icon, systemColor: sys.color })
      }
    }
    return out
  }, [query])

  return (
    <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none' }}>
      <style>{`
        .sfg-card { transition: transform 0.18s ease, box-shadow 0.18s ease; }
        .sfg-card:active { transform: scale(0.98); }
        .sfg-yt { transition: filter 0.15s, transform 0.15s; }
        .sfg-yt:active { transform: translateY(1px); }
      `}</style>

      {/* Search (system grid only) */}
      {!selectedSystem && (
        <div style={{ padding: '14px 16px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--surface-2)', borderRadius: 14, border: '1px solid var(--border-2)', padding: '10px 14px' }}>
            <Search style={{ width: 16, height: 16, color: 'var(--text-dim)', flexShrink: 0 }} />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search faults, symptoms, systems…"
              style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-hi)', fontSize: 14 }} />
            {query && (
              <button onClick={() => setQuery('')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                <X style={{ width: 15, height: 15, color: 'var(--text-dim)' }} />
              </button>
            )}
          </div>
          {searchResults.length > 0 && (
            <div style={{ marginTop: 10, background: 'var(--surface-1)', borderRadius: 14, border: '1px solid var(--border-2)', overflow: 'hidden' }}>
              {searchResults.slice(0, 6).map((r, i) => (
                <div key={i} onClick={() => {
                  const sys = CAR_SYSTEMS.find(s => s.name === r.systemName)!
                  setSelectedSystem(sys); setExpandedIssue(r.name); setQuery('')
                }} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px', cursor: 'pointer', borderBottom: i < Math.min(searchResults.length, 6) - 1 ? '1px solid var(--border-2)' : 'none' }}>
                  <r.SystemIcon style={{ width: 17, height: 17, color: r.systemColor, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ color: 'var(--text-hi)', fontWeight: 700, fontSize: 13, lineHeight: 1 }}>{r.name}</p>
                    <p style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 3 }}>{r.systemName}</p>
                  </div>
                  <ChevronRight style={{ width: 14, height: 14, color: 'var(--text-dim)', flexShrink: 0 }} />
                </div>
              ))}
            </div>
          )}
          {query.length > 1 && searchResults.length === 0 && (
            <p style={{ color: 'var(--text-dim)', fontSize: 12, textAlign: 'center', marginTop: 10 }}>No results for "{query}"</p>
          )}
        </div>
      )}

      {/* System grid */}
      {!selectedSystem && (
        <div style={{ padding: '16px 16px 32px' }}>
          <p style={{ color: 'var(--text-dim)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.14em', fontWeight: 700, marginBottom: 14 }}>
            Car Systems — {CAR_SYSTEMS.length} categories
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {CAR_SYSTEMS.map(sys => (
              <div key={sys.id} className="sfg-card" onClick={() => { setSelectedSystem(sys); setExpandedIssue(null) }}
                style={{ background: 'var(--surface-1)', borderRadius: 18, border: '1px solid var(--border-2)', padding: '16px 14px', cursor: 'pointer', boxShadow: '0 1px 4px rgba(0,0,0,0.07)' }}>
                <div style={{ width: 44, height: 44, borderRadius: 13, marginBottom: 10, background: `${sys.color}18`, border: `1.5px solid ${sys.color}38`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <sys.Icon style={{ width: 22, height: 22, color: sys.color }} />
                </div>
                <p style={{ color: 'var(--text-hi)', fontWeight: 800, fontSize: 14, lineHeight: 1, marginBottom: 5 }}>{sys.name}</p>
                <p style={{ color: 'var(--text-dim)', fontSize: 11, lineHeight: 1.4, marginBottom: 8 }}>{sys.desc}</p>
                <p style={{ color: sys.color, fontSize: 11, fontWeight: 700 }}>{sys.issues.length} guides →</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* System detail (accordions) */}
      {selectedSystem && (
        <div style={{ padding: '16px 16px 32px' }}>
          <button onClick={() => { setSelectedSystem(null); setExpandedIssue(null) }}
            style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 16, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
            <ArrowLeft style={{ width: 15, height: 15, color: 'var(--text-dim)' }} />
            <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>All Systems</span>
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20, padding: '14px 16px', borderRadius: 18, background: `${selectedSystem.color}12`, border: `1.5px solid ${selectedSystem.color}30` }}>
            <div style={{ width: 48, height: 48, borderRadius: 14, flexShrink: 0, background: `${selectedSystem.color}1e`, border: `1.5px solid ${selectedSystem.color}40`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <selectedSystem.Icon style={{ width: 24, height: 24, color: selectedSystem.color }} />
            </div>
            <div>
              <p style={{ color: 'var(--text-hi)', fontWeight: 900, fontSize: 18, lineHeight: 1 }}>{selectedSystem.name}</p>
              <p style={{ color: 'var(--text-dim)', fontSize: 12, marginTop: 4 }}>{selectedSystem.desc}</p>
            </div>
          </div>

          <p style={{ color: 'var(--text-dim)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.14em', fontWeight: 700, marginBottom: 12 }}>Common Issues</p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {selectedSystem.issues.map(issue => {
              const open = expandedIssue === issue.name
              return (
                <div key={issue.name} style={{ background: 'var(--surface-1)', borderRadius: 16, border: `1px solid ${open ? `${selectedSystem.color}45` : 'var(--border-2)'}`, overflow: 'hidden' }}>
                  <div onClick={() => setExpandedIssue(open ? null : issue.name)}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', cursor: 'pointer' }}>
                    <p style={{ color: 'var(--text-hi)', fontWeight: 800, fontSize: 14 }}>{issue.name}</p>
                    <ChevronDown style={{ width: 16, height: 16, color: 'var(--text-dim)', flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s ease' }} />
                  </div>

                  {open && (
                    <div style={{ padding: '0 16px 16px', borderTop: '1px solid var(--border-2)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 12, marginBottom: 8 }}>
                        <AlertTriangle style={{ width: 13, height: 13, color: selectedSystem.color }} />
                        <p style={{ color: 'var(--text-dim)', fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.12em' }}>Symptoms</p>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 16 }}>
                        {issue.symptoms.map((s, i) => (
                          <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                            <div style={{ width: 5, height: 5, borderRadius: '50%', background: selectedSystem.color, flexShrink: 0, marginTop: 6 }} />
                            <p style={{ color: 'var(--text-md)', fontSize: 13, lineHeight: 1.5 }}>{s}</p>
                          </div>
                        ))}
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
                        <ListChecks style={{ width: 13, height: 13, color: selectedSystem.color }} />
                        <p style={{ color: 'var(--text-dim)', fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.12em' }}>Step by Step</p>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {issue.steps.map((step, i) => (
                          <div key={i} style={{ display: 'flex', gap: 11, padding: '11px 12px', background: 'var(--surface-2)', borderRadius: 12 }}>
                            <div style={{ width: 22, height: 22, borderRadius: 7, flexShrink: 0, background: `${selectedSystem.color}1e`, border: `1px solid ${selectedSystem.color}40`, display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 1 }}>
                              <span style={{ color: selectedSystem.color, fontWeight: 900, fontSize: 11 }}>{i + 1}</span>
                            </div>
                            <p style={{ color: 'var(--text-md)', fontSize: 13, lineHeight: 1.55, flex: 1 }}>{step}</p>
                          </div>
                        ))}
                      </div>

                      <a className="sfg-yt" href={ytUrl(issue.name)} target="_blank" rel="noopener noreferrer"
                        style={{ marginTop: 14, width: '100%', height: 44, borderRadius: 12, background: YT_RED, color: '#fff', fontWeight: 800, fontSize: 13.5, textDecoration: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, boxShadow: '0 4px 14px rgba(255,0,0,0.28)', boxSizing: 'border-box' }}>
                        <Youtube style={{ width: 19, height: 19 }} /> Watch how-to on YouTube
                      </a>
                      {MOTOBOT_ENABLED && <button onClick={() => navigate('/fault-chat')}
                        style={{ marginTop: 8, width: '100%', height: 40, borderRadius: 12, background: `${AMBER}15`, border: `1px solid ${AMBER}38`, color: AMBER, fontWeight: 700, fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7 }}>
                        <Bot style={{ width: 15, height: 15 }} /> Ask MOTOBOT about this
                      </button>}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
