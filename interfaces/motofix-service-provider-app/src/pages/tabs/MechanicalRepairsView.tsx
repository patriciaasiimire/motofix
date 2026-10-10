// tabs/MechanicalRepairsView.tsx — the mechanic's repairs reference: how-to repair guides
// with steps and YouTube links, the MOTOBOT diagnostic assistant (detailed pro guidance), and
// a parts lookup. A knowledge hub to help mechanics fix faults. Opened from the Home tab.

import { useState, useRef, useEffect, useCallback } from 'react'
import type { ElementType, ReactNode } from 'react'
import {
  ArrowLeft, Search, X, ChevronDown, ChevronRight, Send, Bot, User,
  Image as ImageIcon, Loader2, Youtube, AlertTriangle, ListChecks, Stethoscope,
  Package, Wrench, Cog, CircleDot, Battery, Disc3, Zap, Droplets, Settings2,
  Car, Fuel, Wind, Filter, Plug, Fan, Thermometer, Sparkles,
  Plus, History, Trash2, MessageSquare,
} from 'lucide-react'
import { diagnosisService } from '@/config/api'
import { MOTOBOT_ENABLED } from '@/config/features'
import type { ChatMsg } from '@/config/api'
import { useTheme } from '@/contexts/ThemeContext'

const AMBER = '#F59E0B'
const YT_RED = '#FF0000'

function fmtUGX(n: number) { return `UGX ${n.toLocaleString('en-UG')}` }

/* YouTube search for an issue/part — opens a fresh how-to results page. */
function ytUrl(q: string) {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(q + ' car repair tutorial')}`
}

/* ── Car systems data ───────────────────────────────────────── */
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

/* ── Spare parts catalogue — what each part does & rough UGX cost ─────────── */
type Part = { name: string; Icon: ElementType; system: string; color: string; use: string; min: number; max: number }
const SPARE_PARTS: Part[] = [
  { name: 'Brake Pads', Icon: Disc3, system: 'Brakes', color: '#F87171', use: 'Friction blocks that clamp the disc to slow the car. Replace in axle pairs once below 3mm or when the wear indicator squeals.', min: 40000, max: 120000 },
  { name: 'Brake Disc (Rotor)', Icon: CircleDot, system: 'Brakes', color: '#F87171', use: 'The metal disc the pads grip. Skim or replace when scored, warped (causes judder) or below minimum thickness.', min: 80000, max: 250000 },
  { name: 'Car Battery', Icon: Battery, system: 'Battery', color: '#4ADE80', use: "Stores 12V to crank the engine and run electronics. Replace when it won't hold 12.4V+ or cranks slowly.", min: 180000, max: 450000 },
  { name: 'Alternator', Icon: Zap, system: 'Electrical', color: '#A78BFA', use: 'Charges the battery and powers electrics while running (13.8–14.7V). Replace on charging light + low output.', min: 250000, max: 700000 },
  { name: 'Spark Plugs', Icon: Plug, system: 'Engine', color: '#F59E0B', use: 'Ignite the fuel-air mix. Worn or fouled plugs cause misfires and poor economy — always replace as a full set.', min: 8000, max: 25000 },
  { name: 'Oil Filter', Icon: Filter, system: 'Engine', color: '#F59E0B', use: 'Traps metal and grit from the engine oil. Replace at every oil change — cheap insurance for the engine.', min: 12000, max: 35000 },
  { name: 'Air Filter', Icon: Wind, system: 'Engine', color: '#F59E0B', use: 'Keeps dust out of the intake. A clogged filter chokes power and fuel economy — inspect every service.', min: 15000, max: 45000 },
  { name: 'Fuel Filter', Icon: Filter, system: 'Fuel System', color: '#FBBF24', use: 'Stops dirt reaching the injectors and pump. A blockage mimics a failing fuel pump — check it first.', min: 20000, max: 60000 },
  { name: 'Fuel Pump', Icon: Fuel, system: 'Fuel System', color: '#FBBF24', use: 'Delivers pressurised fuel to the engine. No 2-second hum on key-on usually means a failed pump.', min: 120000, max: 400000 },
  { name: 'Timing Belt Kit', Icon: Settings2, system: 'Engine', color: '#F59E0B', use: 'Synchronises crank and cam. Replace every 60–100k km WITH the tensioner — a snapped belt bends valves.', min: 90000, max: 300000 },
  { name: 'Radiator', Icon: Fan, system: 'Cooling', color: '#38BDF8', use: 'Sheds engine heat into the air through coolant. Replace if leaking, blocked or the fins are corroded.', min: 150000, max: 450000 },
  { name: 'Thermostat', Icon: Thermometer, system: 'Cooling', color: '#38BDF8', use: 'Valve that controls coolant flow during warm-up. Cheap — always replace alongside a water pump or timing job.', min: 20000, max: 70000 },
  { name: 'Water Pump', Icon: Droplets, system: 'Cooling', color: '#38BDF8', use: 'Circulates coolant through the engine. A weeping seal or noisy bearing means it is on the way out.', min: 90000, max: 280000 },
  { name: 'Shock Absorber', Icon: Car, system: 'Suspension', color: '#34D399', use: 'Damps spring bounce for control and grip. Replace in pairs — worn shocks lengthen braking distance.', min: 120000, max: 350000 },
  { name: 'Clutch Kit', Icon: Cog, system: 'Transmission', color: '#FB923C', use: 'Plate, cover and bearing that couple the engine to the gearbox. Slipping under load = a worn plate.', min: 250000, max: 650000 },
  { name: 'Tyre', Icon: CircleDot, system: 'Tyres', color: '#60A5FA', use: 'The only contact with the road. Replace at 1.6mm tread, on sidewall damage, or with uneven wear.', min: 120000, max: 400000 },
]

/* ── Markdown-lite bold renderer for chat ────────────────────── */
function renderBold(line: string): ReactNode[] {
  return line.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part, i) =>
    part.startsWith('**') && part.endsWith('**')
      ? <strong key={i} style={{ color: 'var(--text-hi)', fontWeight: 800 }}>{part.slice(2, -2)}</strong>
      : <span key={i}>{part}</span>
  )
}

type ChatItem = { id: number; role: 'user' | 'ai'; text?: string; image?: string }

const QUICK_CHIPS = [
  "Car cranks but won't start",
  'Overheating after 10 minutes',
  'Brake judder under braking',
  'Rough idle and misfire',
  'Battery keeps going flat',
  'Knock from front suspension',
]

/* ── MOTOBOT chat history (persisted in localStorage) ────────── */
const GREETING_TEXT = "👋 I'm **MOTOBOT**, your repair assistant. Tell me the fault you're working on — symptoms, what you've checked, the vehicle — and I'll walk you through diagnosing and fixing it, step by step.\n\nYou can also attach a photo of the part or fault."
const newGreeting = (): ChatItem => ({ id: 0, role: 'ai', text: GREETING_TEXT })

type ChatSession = { id: string; title: string; updatedAt: number; messages: ChatItem[] }
const HISTORY_KEY = 'motofix_sp_motobot_history'

/* Blob image URLs don't survive a reload, so store a placeholder instead. */
function serialize(msgs: ChatItem[]): ChatItem[] {
  return msgs.map(m => (m.image && !m.text) ? { id: m.id, role: m.role, text: '📷 Photo' } : { id: m.id, role: m.role, text: m.text })
}
function sessionTitle(msgs: ChatItem[]): string {
  const firstUser = msgs.find(m => m.role === 'user' && m.text)?.text
  const t = (firstUser || 'New chat').replace(/\s+/g, ' ').trim()
  return t.length > 44 ? t.slice(0, 44) + '…' : t
}
function fmtAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  const d = Math.floor(s / 86400)
  if (d === 1) return 'yesterday'
  if (d < 7) return `${d}d ago`
  return new Date(ts).toLocaleDateString('en-UG', { day: 'numeric', month: 'short' })
}
function loadSessions(): ChatSession[] {
  try { const raw = localStorage.getItem(HISTORY_KEY); if (raw) { const a = JSON.parse(raw); if (Array.isArray(a)) return a } } catch { /* ignore */ }
  return []
}

interface Props { onBack: () => void }

export default function MechanicalRepairsView({ onBack }: Props) {
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  // Match the Home-tab card outline (black-ish in light, subtle white in dark).
  const cardBorder = isDark ? '1.5px solid rgba(255,255,255,0.20)' : '1.5px solid rgba(0,0,0,0.65)'

  const [activeTab,      setActiveTab]      = useState<'guides' | 'motobot' | 'parts'>('guides')
  const [searchQuery,    setSearchQuery]    = useState('')
  const [selectedSystem, setSelectedSystem] = useState<System | null>(null)
  const [expandedIssue,  setExpandedIssue]  = useState<string | null>(null)
  const [partFilter,     setPartFilter]     = useState('All')

  const [sessions,    setSessions]    = useState<ChatSession[]>(() => loadSessions())
  const [currentId,   setCurrentId]   = useState<string>(() => loadSessions()[0]?.id ?? `s${Date.now()}`)
  const [showHistory, setShowHistory] = useState(false)
  const [messages, setMessages] = useState<ChatItem[]>(() => {
    const last = loadSessions()[0]
    return last?.messages?.length ? last.messages : [newGreeting()]
  })
  const [inputText, setInputText] = useState('')
  const [sending,   setSending]   = useState(false)

  const chatEndRef    = useRef<HTMLDivElement>(null)
  const inputRef      = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (MOTOBOT_ENABLED && activeTab === 'motobot') setTimeout(() => inputRef.current?.focus(), 150) }, [activeTab])
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, sending])

  /* Persist the active conversation (once it has a real exchange) — newest first, capped at 40. */
  useEffect(() => {
    if (!messages.some(m => m.role === 'user')) return
    setSessions(prev => {
      const session: ChatSession = { id: currentId, title: sessionTitle(messages), updatedAt: Date.now(), messages: serialize(messages) }
      const next = [session, ...prev.filter(s => s.id !== currentId)].slice(0, 40)
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)) } catch { /* quota */ }
      return next
    })
  }, [messages, currentId])

  const newChat = useCallback(() => {
    setCurrentId(`s${Date.now()}`)
    setMessages([newGreeting()])
    setShowHistory(false)
    setTimeout(() => inputRef.current?.focus(), 120)
  }, [])

  const openSession = useCallback((s: ChatSession) => {
    setCurrentId(s.id)
    setMessages(s.messages.length ? s.messages : [newGreeting()])
    setShowHistory(false)
  }, [])

  const deleteSession = useCallback((id: string) => {
    setSessions(prev => {
      const next = prev.filter(s => s.id !== id)
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
    if (id === currentId) { setCurrentId(`s${Date.now()}`); setMessages([newGreeting()]) }
  }, [currentId])

  /* Build Claude-style history from the visible chat (skip media-only bubbles). */
  const buildHistory = useCallback((items: ChatItem[]): ChatMsg[] =>
    items.filter(m => m.text).map(m => ({ role: m.role === 'ai' ? 'assistant' : 'user', content: m.text! }))
  , [])

  const askMotobot = useCallback(async (text: string) => {
    const clean = text.trim()
    if (!clean || sending) return
    const userMsg: ChatItem = { id: Date.now(), role: 'user', text: clean }
    const next = [...messages, userMsg]
    setMessages(next)
    setInputText('')
    setSending(true)
    try {
      const res = await diagnosisService.chat(buildHistory(next), 'mechanic')
      setMessages(prev => [...prev, { id: Date.now() + 1, role: 'ai', text: res.data.reply || 'Sorry, I could not generate a reply. Try rephrasing the fault.' }])
    } catch {
      setMessages(prev => [...prev, { id: Date.now() + 1, role: 'ai', text: '⚠️ I could not reach the diagnosis service. Check your connection and try again.' }])
    } finally {
      setSending(false)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [messages, sending, buildHistory])

  const sendImage = useCallback(async (file: File) => {
    if (sending) return
    const src = URL.createObjectURL(file)
    const next: ChatItem[] = [...messages, { id: Date.now(), role: 'user', image: src }]
    setMessages(next)
    setSending(true)
    try {
      const form = new FormData()
      form.append('file', file)
      form.append('messages', JSON.stringify(buildHistory(messages)))
      form.append('user_text', 'A mechanic uploaded this photo — identify the part/fault and advise.')
      form.append('persona', 'mechanic')
      const res = await diagnosisService.chatWithImage(form)
      setMessages(prev => [...prev, { id: Date.now() + 1, role: 'ai', text: res.data.reply || 'I could not read that image clearly — describe what you are seeing.' }])
    } catch {
      setMessages(prev => [...prev, { id: Date.now() + 1, role: 'ai', text: '⚠️ Could not analyse the photo. Try again or describe the fault in words.' }])
    } finally {
      setSending(false)
    }
  }, [messages, sending, buildHistory])

  /* Search across all systems (Guides) */
  const searchResults = searchQuery.length > 1
    ? CAR_SYSTEMS.flatMap(sys =>
        sys.issues
          .filter(issue =>
            issue.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            issue.symptoms.some(s => s.toLowerCase().includes(searchQuery.toLowerCase())) ||
            sys.name.toLowerCase().includes(searchQuery.toLowerCase()))
          .map(issue => ({ ...issue, systemName: sys.name, systemColor: sys.color, SystemIcon: sys.Icon })))
    : []

  const partCategories = ['All', ...Array.from(new Set(SPARE_PARTS.map(p => p.system)))]
  const filteredParts   = partFilter === 'All' ? SPARE_PARTS : SPARE_PARTS.filter(p => p.system === partFilter)

  const askAboutIssue = (issue: Issue, sys: System) => {
    setActiveTab('motobot')
    askMotobot(`I'm working on a ${sys.name.toLowerCase()} fault: ${issue.name}. How do I diagnose and fix it?`)
  }

  const TABS: { id: 'guides' | 'motobot' | 'parts'; label: string; Icon: ElementType }[] = [
    { id: 'guides',  label: 'Guides',  Icon: ListChecks },
    ...(MOTOBOT_ENABLED ? [{ id: 'motobot' as const, label: 'MOTOBOT', Icon: Bot }] : []),
    { id: 'parts',   label: 'Parts',   Icon: Package },
  ]

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 300, background: 'var(--bg)',
      display: 'flex', flexDirection: 'column',
      animation: 'mrv-slide-in 0.3s cubic-bezier(0.4,0,0.2,1)', maxWidth: 480, margin: '0 auto',
    }}>
      <style>{`
        @keyframes mrv-slide-in { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        @keyframes mrv-blink { 0%,100% { opacity: 0.3; } 50% { opacity: 1; } }
        .mrv-card:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,0.14) !important; }
        .mrv-card { transition: transform 0.18s ease, box-shadow 0.18s ease; }
        .mrv-row:hover { background: var(--surface-3) !important; }
        .mrv-row { transition: background 0.15s ease; }
        .mrv-yt:hover { filter: brightness(1.08); transform: translateY(-1px); }
        .mrv-yt { transition: filter 0.15s, transform 0.15s; }
        .mrv-send:hover { filter: brightness(1.12); }
      `}</style>

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px',
        background: 'var(--header-bg)', borderBottom: '1px solid var(--border-2)', flexShrink: 0,
        paddingTop: 'max(14px, env(safe-area-inset-top, 14px))',
      }}>
        <button onClick={onBack} style={{
          width: 38, height: 38, borderRadius: 12, flexShrink: 0,
          background: 'var(--surface-2)', border: '1px solid var(--border-2)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
        }}>
          <ArrowLeft style={{ width: 18, height: 18, color: 'var(--text-hi)' }} />
        </button>
        <div style={{ flex: 1 }}>
          <p style={{ color: 'var(--text-hi)', fontWeight: 900, fontSize: 17, lineHeight: 1 }}>Mechanical Repairs</p>
          <p style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 2 }}>
            {MOTOBOT_ENABLED ? 'Guides · MOTOBOT AI · Spare parts' : 'Guides · Spare parts'}
          </p>
        </div>
        <div style={{ width: 38, height: 38, borderRadius: 12, flexShrink: 0, background: `${AMBER}18`, border: `1px solid ${AMBER}40`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Wrench style={{ width: 18, height: 18, color: AMBER }} />
        </div>
      </div>

      {/* Search (Guides grid only) */}
      {activeTab === 'guides' && !selectedSystem && (
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-2)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--surface-2)', borderRadius: 14, border: '1px solid var(--border-2)', padding: '10px 14px' }}>
            <Search style={{ width: 16, height: 16, color: 'var(--text-dim)', flexShrink: 0 }} />
            <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search faults, symptoms, systems…"
              style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-hi)', fontSize: 14 }} />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                <X style={{ width: 15, height: 15, color: 'var(--text-dim)' }} />
              </button>
            )}
          </div>
          {searchResults.length > 0 && (
            <div style={{ marginTop: 10, background: 'var(--surface-1)', borderRadius: 14, border: '1px solid var(--border-2)', overflow: 'hidden' }}>
              {searchResults.slice(0, 6).map((issue, i) => (
                <div key={i} className="mrv-row" onClick={() => {
                  const sys = CAR_SYSTEMS.find(s => s.name === issue.systemName)!
                  setSelectedSystem(sys); setExpandedIssue(issue.name); setSearchQuery('')
                }} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px', cursor: 'pointer', borderBottom: i < Math.min(searchResults.length, 6) - 1 ? '1px solid var(--border-2)' : 'none' }}>
                  <issue.SystemIcon style={{ width: 17, height: 17, color: issue.systemColor, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ color: 'var(--text-hi)', fontWeight: 700, fontSize: 13, lineHeight: 1 }}>{issue.name}</p>
                    <p style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 3 }}>{issue.systemName}</p>
                  </div>
                  <ChevronRight style={{ width: 14, height: 14, color: 'var(--text-ghost)', flexShrink: 0 }} />
                </div>
              ))}
            </div>
          )}
          {searchQuery.length > 1 && searchResults.length === 0 && (
            <p style={{ color: 'var(--text-dim)', fontSize: 12, textAlign: 'center', marginTop: 10 }}>No results for "{searchQuery}"</p>
          )}
        </div>
      )}

      {/* Tab bar */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border-2)', flexShrink: 0, background: 'var(--bg)' }}>
        {TABS.map(({ id, label, Icon }) => (
          <button key={id} onClick={() => setActiveTab(id)} style={{
            flex: 1, height: 46, background: 'transparent', border: 'none',
            borderBottom: activeTab === id ? `2px solid ${AMBER}` : '2px solid transparent',
            color: activeTab === id ? AMBER : 'var(--text-dim)', fontWeight: activeTab === id ? 800 : 600,
            fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
          }}>
            <Icon style={{ width: 15, height: 15 }} /> {label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>

        {/* ── GUIDES: system grid ─────────────────────────────── */}
        {activeTab === 'guides' && !selectedSystem && (
          <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none', padding: '16px 16px 32px' }}>
            <p style={{ color: 'var(--text-dim)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.14em', fontWeight: 700, marginBottom: 14 }}>
              Car Systems — {CAR_SYSTEMS.length} categories
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {CAR_SYSTEMS.map(sys => (
                <div key={sys.id} className="mrv-card" onClick={() => { setSelectedSystem(sys); setExpandedIssue(null) }}
                  style={{ background: 'var(--surface-1)', borderRadius: 18, border: cardBorder, padding: '16px 14px', cursor: 'pointer', boxShadow: '0 1px 4px rgba(0,0,0,0.07)' }}>
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

        {/* ── GUIDES: system detail (accordions) ──────────────── */}
        {activeTab === 'guides' && selectedSystem && (
          <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none', padding: '16px 16px 32px' }}>
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
                    <div className="mrv-row" onClick={() => setExpandedIssue(open ? null : issue.name)}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', cursor: 'pointer' }}>
                      <p style={{ color: 'var(--text-hi)', fontWeight: 800, fontSize: 14 }}>{issue.name}</p>
                      <ChevronDown style={{ width: 16, height: 16, color: 'var(--text-dim)', flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s ease' }} />
                    </div>

                    {open && (
                      <div style={{ padding: '0 16px 16px', borderTop: '1px solid var(--border-2)' }}>
                        {/* Symptoms */}
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

                        {/* Step-by-step */}
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

                        {/* YouTube + MOTOBOT actions */}
                        <a className="mrv-yt" href={ytUrl(issue.name)} target="_blank" rel="noopener noreferrer"
                          style={{ marginTop: 14, width: '100%', height: 44, borderRadius: 12, background: YT_RED, color: '#fff', fontWeight: 800, fontSize: 13.5, textDecoration: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, boxShadow: '0 4px 14px rgba(255,0,0,0.28)', boxSizing: 'border-box' }}>
                          <Youtube style={{ width: 19, height: 19 }} /> Watch how-to on YouTube
                        </a>
                        {MOTOBOT_ENABLED && <button onClick={() => askAboutIssue(issue, selectedSystem)}
                          style={{ marginTop: 8, width: '100%', height: 40, borderRadius: 12, background: `${selectedSystem.color}15`, border: `1px solid ${selectedSystem.color}38`, color: selectedSystem.color, fontWeight: 700, fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7 }}>
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

        {/* ── MOTOBOT chat ────────────────────────────────────── */}
        {MOTOBOT_ENABLED && activeTab === 'motobot' && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <input ref={imageInputRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) sendImage(f); e.target.value = '' }} />

            {/* Chat toolbar — new chat + history */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 16px', borderBottom: '1px solid var(--border-2)', flexShrink: 0 }}>
              <button onClick={newChat}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 10, background: `${AMBER}15`, border: `1px solid ${AMBER}38`, color: AMBER, fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>
                <Plus style={{ width: 14, height: 14 }} /> New chat
              </button>
              <button onClick={() => setShowHistory(true)}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border-2)', color: 'var(--text-md)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>
                <History style={{ width: 14, height: 14 }} /> History{sessions.length ? ` (${sessions.length})` : ''}
              </button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '16px 16px 8px', scrollbarWidth: 'none', display: 'flex', flexDirection: 'column', gap: 12 }}>
              {messages.map(msg => (
                <div key={msg.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexDirection: msg.role === 'user' ? 'row-reverse' : 'row' }}>
                  <div style={{ width: 32, height: 32, borderRadius: '50%', flexShrink: 0, background: msg.role === 'ai' ? `${AMBER}26` : 'rgba(96,165,250,0.18)', border: `1.5px solid ${msg.role === 'ai' ? `${AMBER}66` : 'rgba(96,165,250,0.45)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {msg.role === 'ai' ? <Bot style={{ width: 15, height: 15, color: AMBER }} /> : <User style={{ width: 15, height: 15, color: '#60A5FA' }} />}
                  </div>
                  <div style={{ maxWidth: '80%', borderRadius: msg.role === 'ai' ? '4px 16px 16px 16px' : '16px 4px 16px 16px', background: msg.role === 'ai' ? 'var(--surface-2)' : 'rgba(96,165,250,0.12)', border: `1px solid ${msg.role === 'ai' ? 'var(--border-2)' : 'rgba(96,165,250,0.25)'}`, overflow: 'hidden' }}>
                    {msg.image && <img src={msg.image} alt="upload" style={{ width: '100%', maxWidth: 240, display: 'block' }} />}
                    {msg.text && (
                      <div style={{ padding: '10px 14px' }}>
                        {msg.text.split('\n').map((line, i) => (
                          <p key={i} style={{ color: 'var(--text-md)', fontSize: 13, lineHeight: 1.6, marginBottom: i < msg.text!.split('\n').length - 1 ? 5 : 0 }}>
                            {renderBold(line)}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {sending && (
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <div style={{ width: 32, height: 32, borderRadius: '50%', flexShrink: 0, background: `${AMBER}26`, border: `1.5px solid ${AMBER}66`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Bot style={{ width: 15, height: 15, color: AMBER }} />
                  </div>
                  <div style={{ display: 'flex', gap: 4, padding: '12px 16px', background: 'var(--surface-2)', borderRadius: '4px 16px 16px 16px', border: '1px solid var(--border-2)' }}>
                    {[0, 1, 2].map(i => <div key={i} style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--text-dim)', animation: `mrv-blink 1.2s ${i * 0.2}s infinite` }} />)}
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Quick chips */}
            <div style={{ padding: '6px 16px', display: 'flex', gap: 8, overflowX: 'auto', scrollbarWidth: 'none', flexShrink: 0 }}>
              {QUICK_CHIPS.map(chip => (
                <button key={chip} onClick={() => askMotobot(chip)} disabled={sending}
                  style={{ flexShrink: 0, padding: '6px 12px', borderRadius: 20, background: 'var(--surface-2)', border: '1px solid var(--border-3)', color: 'var(--text-md)', fontSize: 12, fontWeight: 600, cursor: sending ? 'default' : 'pointer', whiteSpace: 'nowrap', opacity: sending ? 0.5 : 1 }}>
                  {chip}
                </button>
              ))}
            </div>

            {/* Input */}
            <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border-2)', flexShrink: 0, paddingBottom: 'max(10px, env(safe-area-inset-bottom, 10px))', display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <button onClick={() => imageInputRef.current?.click()} disabled={sending}
                style={{ width: 44, height: 44, borderRadius: 14, flexShrink: 0, background: 'var(--surface-2)', border: '1px solid var(--border-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: sending ? 'default' : 'pointer' }}>
                <ImageIcon style={{ width: 17, height: 17, color: 'var(--text-dim)' }} />
              </button>
              <input ref={inputRef} value={inputText} onChange={e => setInputText(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && askMotobot(inputText)}
                placeholder="Describe the fault you're working on…" disabled={sending}
                style={{ flex: 1, background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 14, padding: '11px 14px', outline: 'none', color: 'var(--text-hi)', fontSize: 14, opacity: sending ? 0.6 : 1 }} />
              <button className="mrv-send" onClick={() => askMotobot(inputText)} disabled={sending || !inputText.trim()}
                style={{ width: 44, height: 44, borderRadius: 14, border: 'none', flexShrink: 0, background: inputText.trim() && !sending ? `linear-gradient(135deg, ${AMBER}, #D97706)` : 'var(--surface-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: inputText.trim() && !sending ? 'pointer' : 'default' }}>
                {sending ? <Loader2 style={{ width: 16, height: 16, color: 'var(--text-dim)', animation: 'spin 0.8s linear infinite' }} /> : <Send style={{ width: 16, height: 16, color: inputText.trim() ? '#000' : 'var(--text-ghost)' }} />}
              </button>
            </div>

            {/* History overlay */}
            {showHistory && (
              <div style={{ position: 'absolute', inset: 0, zIndex: 30, background: 'var(--bg)', display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderBottom: '1px solid var(--border-2)', flexShrink: 0, paddingTop: 'max(14px, env(safe-area-inset-top, 14px))' }}>
                  <button onClick={() => setShowHistory(false)} style={{ width: 36, height: 36, borderRadius: 10, flexShrink: 0, background: 'var(--surface-2)', border: '1px solid var(--border-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                    <X style={{ width: 17, height: 17, color: 'var(--text-hi)' }} />
                  </button>
                  <div style={{ flex: 1 }}>
                    <p style={{ color: 'var(--text-hi)', fontWeight: 900, fontSize: 16, lineHeight: 1 }}>Chat history</p>
                    <p style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 2 }}>{sessions.length} saved conversation{sessions.length === 1 ? '' : 's'}</p>
                  </div>
                  <button onClick={newChat} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 10, background: `${AMBER}15`, border: `1px solid ${AMBER}38`, color: AMBER, fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>
                    <Plus style={{ width: 14, height: 14 }} /> New
                  </button>
                </div>
                <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none', padding: '12px 16px 24px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {sessions.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '48px 16px' }}>
                      <MessageSquare style={{ width: 30, height: 30, color: 'var(--text-ghost)', margin: '0 auto 10px' }} />
                      <p style={{ color: 'var(--text-md)', fontSize: 13, fontWeight: 700 }}>No saved chats yet</p>
                      <p style={{ color: 'var(--text-dim)', fontSize: 12, marginTop: 4 }}>Your MOTOBOT conversations will appear here.</p>
                    </div>
                  ) : sessions.map(s => {
                    const count = s.messages.filter(m => m.role === 'user').length
                    return (
                      <div key={s.id} className="mrv-row" onClick={() => openSession(s)}
                        style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', background: s.id === currentId ? `${AMBER}10` : 'var(--surface-1)', borderRadius: 14, border: `1px solid ${s.id === currentId ? `${AMBER}40` : 'var(--border-2)'}`, cursor: 'pointer' }}>
                        <div style={{ width: 36, height: 36, borderRadius: 10, flexShrink: 0, background: `${AMBER}15`, border: `1px solid ${AMBER}30`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <MessageSquare style={{ width: 16, height: 16, color: AMBER }} />
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p style={{ color: 'var(--text-hi)', fontWeight: 700, fontSize: 13, lineHeight: 1.3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.title}</p>
                          <p style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 3 }}>{fmtAgo(s.updatedAt)} · {count} message{count === 1 ? '' : 's'}</p>
                        </div>
                        <button onClick={e => { e.stopPropagation(); deleteSession(s.id) }}
                          style={{ width: 32, height: 32, borderRadius: 9, flexShrink: 0, background: 'transparent', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                          <Trash2 style={{ width: 15, height: 15, color: 'var(--text-dim)' }} />
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── PARTS catalogue ─────────────────────────────────── */}
        {activeTab === 'parts' && (
          <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none', padding: '16px 16px 32px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 14 }}>
              <Sparkles style={{ width: 14, height: 14, color: AMBER, flexShrink: 0, marginTop: 2 }} />
              <p style={{ color: 'var(--text-dim)', fontSize: 12, lineHeight: 1.55 }}>
                Common spare parts, what each one does and a rough <strong style={{ color: AMBER }}>UGX</strong> price guide. Prices vary by vehicle, brand and whether the part is new or used.
              </p>
            </div>

            <div style={{ display: 'flex', gap: 8, overflowX: 'auto', scrollbarWidth: 'none', marginBottom: 16 }}>
              {partCategories.map(cat => (
                <button key={cat} onClick={() => setPartFilter(cat)}
                  style={{ flexShrink: 0, padding: '6px 14px', borderRadius: 20, background: partFilter === cat ? AMBER : 'var(--surface-2)', border: partFilter === cat ? 'none' : '1px solid var(--border-2)', color: partFilter === cat ? '#000' : 'var(--text-md)', fontSize: 12, fontWeight: partFilter === cat ? 800 : 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  {cat}
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {filteredParts.map(part => (
                <div key={part.name} className="mrv-card" style={{ background: 'var(--surface-1)', borderRadius: 16, border: `1px solid ${part.color}33`, padding: '14px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                    <div style={{ width: 42, height: 42, borderRadius: 12, flexShrink: 0, background: `${part.color}18`, border: `1.5px solid ${part.color}38`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <part.Icon style={{ width: 21, height: 21, color: part.color }} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
                        <p style={{ color: 'var(--text-hi)', fontWeight: 800, fontSize: 14 }}>{part.name}</p>
                        <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 800, color: part.color, background: `${part.color}14`, padding: '3px 9px', borderRadius: 8 }}>{part.system}</span>
                      </div>
                      <p style={{ color: 'var(--text-md)', fontSize: 12.5, lineHeight: 1.55, marginBottom: 9 }}>{part.use}</p>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <Stethoscope style={{ width: 12, height: 12, color: 'var(--text-dim)' }} />
                        <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>Typical price</span>
                        <span style={{ marginLeft: 'auto', color: 'var(--text-hi)', fontSize: 12.5, fontWeight: 800 }}>{fmtUGX(part.min)} – {fmtUGX(part.max)}</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
