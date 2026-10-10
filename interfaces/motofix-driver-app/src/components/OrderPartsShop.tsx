// OrderPartsShop.tsx — the in-app spare-parts shopping experience: the driver picks
// the parts they need, MOTOBOT (AI) estimates fair UGX prices, and they place an order
// with a nearby dealer (the order is sent to the dealer via WhatsApp and saved as the
// driver's order history). Big component because it covers browse → cart → order.

import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import type { ElementType } from 'react'
import {
  ArrowLeft, Search, X, ChevronDown, ShoppingBag, ShoppingCart,
  Loader2, MessageCircle, ReceiptText, Clock, Sparkles, MapPin, Wrench,
  CheckCircle2, Truck, Star, CircleDot, Cog, Disc3, Zap, Droplets, Car, Lightbulb,
  GitBranch, Package,
} from 'lucide-react'
import { useTheme } from '@/contexts/ThemeContext'
import { partsService, motobotService, type PartsOrder } from '@/config/api'
import { MOTOBOT_ENABLED } from '@/config/features'
import { toast } from 'sonner'

const PURPLE = '#A78BFA'
const DELIVERY = { min: 5000, max: 20000 }

function fmtUGX(n: number) { return `UGX ${Math.round(n).toLocaleString('en-UG')}` }
function waDigits(raw?: string): string {
  if (!raw) return ''
  let d = raw.replace(/[^\d]/g, '')
  if (d.startsWith('0')) d = '256' + d.slice(1)
  else if (!d.startsWith('256') && d.length === 9) d = '256' + d
  return d
}

/* ── Catalogue ───────────────────────────────────────────────── */
type Zone = 'engine' | 'wheel' | 'front' | 'rear' | 'body' | 'whole'
type Spec = { key: string; label: string; type: 'select' | 'number'; options?: string[] }
type Item = { id: string; name: string; cat: string; min: number; max: number; zone: Zone; specs: Spec[] }

const CATS: { id: string; label: string; color: string; Icon: ElementType }[] = [
  { id: 'tyres',      label: 'Tyres & Wheels',     color: '#60A5FA', Icon: CircleDot },
  { id: 'engine',     label: 'Engine',             color: '#F59E0B', Icon: Cog },
  { id: 'brakes',     label: 'Brakes',             color: '#F87171', Icon: Disc3 },
  { id: 'electrical', label: 'Electrical',         color: '#A78BFA', Icon: Zap },
  { id: 'filters',    label: 'Filters & Fluids',   color: '#38BDF8', Icon: Droplets },
  { id: 'suspension', label: 'Suspension',         color: '#34D399', Icon: Car },
  { id: 'body',       label: 'Body & Glass',       color: '#FB923C', Icon: Package },
  { id: 'lights',     label: 'Lights',             color: '#FBBF24', Icon: Lightbulb },
  { id: 'fasteners',  label: 'Fasteners',          color: '#9CA3AF', Icon: Wrench },
]

const FAULT_CATEGORIES = [
  { id: 'engine', label: 'Engine' },
  { id: 'brakes_suspension', label: 'Brakes & Suspension' },
  { id: 'electrical', label: 'Electrical' },
  { id: 'tyres_wheels', label: 'Tyres & Wheels' },
  { id: 'transmission', label: 'Transmission' },
  { id: 'battery', label: 'Battery' },
  { id: 'other', label: 'Other' },
]

const faultCategoryForPart: Record<string, string> = {
  tyres: 'tyres_wheels',
  engine: 'engine',
  brakes: 'brakes_suspension',
  electrical: 'electrical',
  filters: 'engine',
  suspension: 'brakes_suspension',
  body: 'other',
  lights: 'electrical',
  fasteners: 'other',
}

const QTY: Spec = { key: 'qty', label: 'Quantity', type: 'number' }
const TYRE_BRANDS = ['Michelin', 'Bridgestone', 'Dunlop', 'Continental', 'Yokohama', 'Maxxis', 'Goodyear', 'Other']
const PLUG_BRANDS = ['NGK', 'Denso', 'Bosch', 'Other']
const TYRE_SIZES  = ['175/70 R13', '185/65 R14', '195/65 R15', '205/55 R16', '215/60 R16', '225/65 R17', '265/65 R17', '31x10.5 R15']

const CATALOG: Item[] = [
  // Tyres & wheels
  { id: 'tyre',     name: 'Tyre',          cat: 'tyres', min: 120000, max: 400000, zone: 'wheel', specs: [{ key: 'size', label: 'Tyre size', type: 'select', options: TYRE_SIZES }, { key: 'brand', label: 'Brand', type: 'select', options: TYRE_BRANDS }, QTY] },
  { id: 'rim',      name: 'Alloy Rim',     cat: 'tyres', min: 150000, max: 500000, zone: 'wheel', specs: [{ key: 'size', label: 'Rim size', type: 'select', options: ['13"', '14"', '15"', '16"', '17"', '18"'] }, QTY] },
  { id: 'tube',     name: 'Inner Tube',    cat: 'tyres', min: 15000,  max: 45000,  zone: 'wheel', specs: [{ key: 'size', label: 'Size', type: 'select', options: TYRE_SIZES }, QTY] },
  { id: 'wheelnut', name: 'Wheel Nuts',    cat: 'tyres', min: 2000,   max: 12000,  zone: 'wheel', specs: [QTY] },
  // Engine
  { id: 'plugs',    name: 'Spark Plugs',   cat: 'engine', min: 8000,  max: 25000,  zone: 'engine', specs: [{ key: 'brand', label: 'Brand', type: 'select', options: PLUG_BRANDS }, QTY] },
  { id: 'timing',   name: 'Timing Belt Kit', cat: 'engine', min: 90000, max: 300000, zone: 'engine', specs: [QTY] },
  { id: 'gasket',   name: 'Full Gasket Set', cat: 'engine', min: 80000, max: 300000, zone: 'engine', specs: [QTY] },
  { id: 'engine',   name: 'Engine (half-cut/complete)', cat: 'engine', min: 1500000, max: 6000000, zone: 'engine', specs: [{ key: 'condition', label: 'Condition', type: 'select', options: ['New', 'Half-cut (used import)', 'Reconditioned'] }, QTY] },
  { id: 'oil',      name: 'Engine Oil',    cat: 'engine', min: 25000,  max: 90000,  zone: 'engine', specs: [{ key: 'grade', label: 'Viscosity', type: 'select', options: ['5W-30', '10W-40', '15W-40', '20W-50'] }, { key: 'litres', label: 'Litres', type: 'number' }] },
  // Brakes
  { id: 'pads',     name: 'Brake Pads',    cat: 'brakes', min: 40000, max: 120000, zone: 'wheel', specs: [{ key: 'pos', label: 'Position', type: 'select', options: ['Front', 'Rear'] }, QTY] },
  { id: 'discs',    name: 'Brake Discs',   cat: 'brakes', min: 80000, max: 250000, zone: 'wheel', specs: [{ key: 'pos', label: 'Position', type: 'select', options: ['Front', 'Rear'] }, QTY] },
  { id: 'bfluid',   name: 'Brake Fluid',   cat: 'brakes', min: 12000, max: 35000,  zone: 'engine', specs: [{ key: 'type', label: 'Type', type: 'select', options: ['DOT 3', 'DOT 4'] }, QTY] },
  // Electrical
  { id: 'battery',  name: 'Car Battery',   cat: 'electrical', min: 180000, max: 450000, zone: 'front', specs: [{ key: 'size', label: 'Battery size', type: 'select', options: ['NS40', 'NS60', 'NS70', 'N50', 'N70'] }, QTY] },
  { id: 'alt',      name: 'Alternator',    cat: 'electrical', min: 250000, max: 700000, zone: 'engine', specs: [QTY] },
  { id: 'starter',  name: 'Starter Motor', cat: 'electrical', min: 200000, max: 550000, zone: 'engine', specs: [QTY] },
  { id: 'bulb',     name: 'Headlight Bulb', cat: 'electrical', min: 10000, max: 60000, zone: 'front', specs: [{ key: 'type', label: 'Type', type: 'select', options: ['Halogen', 'LED', 'HID/Xenon'] }, QTY] },
  // Filters & fluids
  { id: 'oilfilter', name: 'Oil Filter',   cat: 'filters', min: 12000, max: 35000, zone: 'engine', specs: [QTY] },
  { id: 'airfilter', name: 'Air Filter',   cat: 'filters', min: 15000, max: 45000, zone: 'engine', specs: [QTY] },
  { id: 'fuelfilter', name: 'Fuel Filter', cat: 'filters', min: 20000, max: 60000, zone: 'engine', specs: [QTY] },
  { id: 'coolant',  name: 'Coolant',       cat: 'filters', min: 15000, max: 50000, zone: 'engine', specs: [{ key: 'litres', label: 'Litres', type: 'number' }] },
  // Suspension
  { id: 'shock',    name: 'Shock Absorber', cat: 'suspension', min: 120000, max: 350000, zone: 'wheel', specs: [{ key: 'pos', label: 'Position', type: 'select', options: ['Front', 'Rear'] }, QTY] },
  { id: 'tierod',   name: 'Tie Rod End',   cat: 'suspension', min: 40000, max: 120000, zone: 'wheel', specs: [QTY] },
  { id: 'balljoint', name: 'Ball Joint',   cat: 'suspension', min: 35000, max: 110000, zone: 'wheel', specs: [QTY] },
  { id: 'cv',       name: 'CV Joint',      cat: 'suspension', min: 80000, max: 220000, zone: 'wheel', specs: [QTY] },
  // Body & glass
  { id: 'windscreen', name: 'Windscreen',  cat: 'body', min: 200000, max: 600000, zone: 'front', specs: [QTY] },
  { id: 'mirror',   name: 'Side Mirror',   cat: 'body', min: 60000, max: 200000, zone: 'body', specs: [{ key: 'side', label: 'Side', type: 'select', options: ['Left', 'Right'] }, QTY] },
  { id: 'bumper',   name: 'Bumper',        cat: 'body', min: 150000, max: 500000, zone: 'body', specs: [{ key: 'pos', label: 'Position', type: 'select', options: ['Front', 'Rear'] }, QTY] },
  // Lights
  { id: 'headlamp', name: 'Headlamp Assembly', cat: 'lights', min: 120000, max: 450000, zone: 'front', specs: [{ key: 'side', label: 'Side', type: 'select', options: ['Left', 'Right'] }, QTY] },
  { id: 'taillight', name: 'Tail Light',   cat: 'lights', min: 50000, max: 180000, zone: 'rear', specs: [{ key: 'side', label: 'Side', type: 'select', options: ['Left', 'Right'] }, QTY] },
  { id: 'indicator', name: 'Indicator Bulb', cat: 'lights', min: 3000, max: 15000, zone: 'front', specs: [QTY] },
  // Fasteners
  { id: 'bolts',    name: 'Bolt & Nut Assortment', cat: 'fasteners', min: 5000, max: 25000, zone: 'whole', specs: [QTY] },
  { id: 'screws',   name: 'Self-tapping Screws', cat: 'fasteners', min: 2000, max: 12000, zone: 'whole', specs: [QTY] },
  { id: 'clamps',   name: 'Hose Clamps',   cat: 'fasteners', min: 3000, max: 15000, zone: 'engine', specs: [QTY] },
  { id: 'belt',     name: 'Fan / Serpentine Belt', cat: 'engine', min: 25000, max: 90000, zone: 'engine', specs: [QTY] },
]

/* ── Cars common in Uganda (curated makes + models) ──────────── */
const CAR_MAKES: { make: string; models: string[] }[] = [
  { make: 'Toyota',      models: ['Corolla', 'Premio', 'Allion', 'Vitz', 'Wish', 'Harrier', 'Land Cruiser', 'Land Cruiser Prado', 'Hiace', 'Noah', 'Mark X', 'RAV4', 'Ipsum', 'Spacio', 'Succeed', 'Probox', 'Fielder', 'Camry', 'Hilux'] },
  { make: 'Isuzu',       models: ['D-Max', 'Elf', 'Forward', 'NPR', 'Trooper', 'MU-X', 'Bighorn', 'Wizard'] },
  { make: 'Mitsubishi',  models: ['Pajero', 'Canter', 'L200', 'Outlander', 'Lancer', 'Fuso', 'RVR', 'Galant'] },
  { make: 'Nissan',      models: ['X-Trail', 'Note', 'Wingroad', 'Caravan', 'Navara', 'Sunny', 'Patrol', 'Tiida', 'AD Van'] },
  { make: 'Subaru',      models: ['Forester', 'Outback', 'Legacy', 'Impreza', 'Exiga'] },
  { make: 'Mercedes-Benz', models: ['C-Class', 'E-Class', 'S-Class', 'ML', 'GLE', 'Sprinter', 'Actros', 'Vito'] },
  { make: 'Honda',       models: ['Fit', 'CR-V', 'Civic', 'Stream', 'Insight', 'Stepwagon'] },
  { make: 'Mazda',       models: ['Demio', 'Axela', 'CX-5', 'Bongo', 'Atenza', 'Familia'] },
  { make: 'Volkswagen',  models: ['Golf', 'Passat', 'Touareg', 'Polo'] },
  { make: 'Land Rover',  models: ['Defender', 'Discovery', 'Range Rover', 'Freelander'] },
  { make: 'Suzuki',      models: ['Alto', 'Swift', 'Escudo', 'Every', 'Vitara'] },
  { make: 'BMW',         models: ['3 Series', '5 Series', 'X3', 'X5', '7 Series'] },
  { make: 'Hyundai',     models: ['Tucson', 'Santa Fe', 'Elantra', 'ix35', 'H1'] },
  { make: 'Kia',         models: ['Sportage', 'Sorento', 'Rio', 'Picanto'] },
  { make: 'Ford',        models: ['Ranger', 'Everest', 'Focus'] },
  { make: 'Other',       models: [] },
]

type Step = 'shop' | 'configure' | 'searching' | 'suppliers'
type Cfg = Record<string, string>
type Supplier = { name: string; vicinity?: string; rating?: number; phone?: string; place_id?: string }

/**
 * Order Parts — the Spare Parts Shop, ported from the mechanic app. Browse a
 * catalogue → configure (specs + car) → MOTOBOT prices it & finds nearby
 * suppliers (via OSM) → dispatch the order on WhatsApp. Rendered inside the
 * Spare Parts & Self-Fix hub's "Order Parts" tab (the hub supplies the header
 * + tab bar), so this fills the tab content area rather than the whole page.
 */
export default function OrderPartsShop() {
  const { isDark } = useTheme()

  const [step, setStep]       = useState<Step>('shop')
  const [query, setQuery]     = useState('')
  const [catFilter, setCatFilter] = useState('All')
  const [item, setItem]       = useState<Item | null>(null)
  const [faultCategory, setFaultCategory] = useState('')
  const [cfg, setCfg]         = useState<Cfg>({})
  const [makeOpen, setMakeOpen] = useState(false)

  const [aiPrice, setAiPrice] = useState<{ min: number; max: number } | null>(null)
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [dispatched, setDispatched] = useState<Supplier | null>(null)

  const [ordersOpen, setOrdersOpen] = useState(false)
  const [orders, setOrders] = useState<PartsOrder[]>([])
  const [ordersLoading, setOrdersLoading] = useState(false)

  const posRef = useRef<{ lat: number; lng: number } | null>(null)

  useEffect(() => {
    if (!('geolocation' in navigator)) return
    navigator.geolocation.getCurrentPosition(
      p => { posRef.current = { lat: p.coords.latitude, lng: p.coords.longitude } },
      () => {}, { enableHighAccuracy: true, timeout: 8000 },
    )
  }, [])

  // theme tokens
  const surface  = 'var(--surface-1)'
  const textHi   = 'var(--text-hi)'
  const textMd   = 'var(--text-md)'
  const textLo   = 'var(--text-dim)'
  const border   = isDark ? '1.5px solid rgba(255,255,255,0.20)' : '1.5px solid rgba(0,0,0,0.65)'
  const qty = Math.max(1, Number(cfg.qty || cfg.litres || 1))

  const filtered = CATALOG.filter(it => {
    if (catFilter !== 'All' && it.cat !== catFilter) return false
    if (query.length > 1) {
      const q = query.toLowerCase()
      const catLabel = CATS.find(c => c.id === it.cat)?.label ?? ''
      return it.name.toLowerCase().includes(q) || catLabel.toLowerCase().includes(q)
    }
    return true
  })

  const openItem = (it: Item) => {
    setItem(it)
    setFaultCategory(faultCategoryForPart[it.cat] ?? 'other')
    const init: Cfg = {}
    it.specs.forEach(s => { if (s.key === 'qty' || s.key === 'litres') init[s.key] = '1' })
    setCfg(init)
    setAiPrice(null)
    setStep('configure')
  }

  const stepBack = () => {
    if (step === 'configure') setStep('shop')
    else if (step === 'suppliers' || step === 'searching') setStep('configure')
  }

  const makeObj = CAR_MAKES.find(m => m.make === cfg.make)
  const requiredFilled = !!item && item.specs.every(s => s.type === 'number' || cfg[s.key]) && !!cfg.make && !!cfg.model

  const partString = useCallback(() => {
    if (!item) return ''
    const bits = item.specs.filter(s => s.key !== 'qty' && s.key !== 'litres' && cfg[s.key]).map(s => cfg[s.key])
    const car = [cfg.make, cfg.model].filter(Boolean).join(' ')
    return `${bits.join(' ')} ${item.name}${car ? ` for ${car}` : ''}`.replace(/\s+/g, ' ').trim()
  }, [item, cfg])

  // Proceed to checkout: fetch AI price + find nearby suppliers behind the animation.
  const proceed = useCallback(async () => {
    if (!item) return
    setStep('searching')
    setSuppliers([])
    setDispatched(null)

    // Keep the curated catalogue estimate when MOTOBOT is disabled or unavailable.
    let unit = { min: item.min, max: item.max }
    if (MOTOBOT_ENABLED) {
      try {
        const res = await motobotService.priceItems([partString()])
        const p = res.data.items?.[0]
        if (p && (p.price_min || p.price_max)) unit = { min: p.price_min || item.min, max: p.price_max || item.max }
      } catch { /* keep catalogue range */ }
    }
    setAiPrice(unit)

    // 2) Nearby spare-parts suppliers (OSM, same source as the dealer finder).
    const found: Supplier[] = []
    try {
      const pos = posRef.current
      if (pos) {
        const res = await motobotService.findDealers(pos.lat, pos.lng)
        ;(res.data?.dealers ?? []).slice(0, 6).forEach(d => found.push({
          name: d.name, vicinity: d.vicinity, rating: d.rating ?? undefined, phone: d.phone ?? undefined, place_id: d.place_id,
        }))
      }
    } catch { /* ignore */ }

    // Keep the search animation visible for a beat, then reveal.
    await new Promise(r => setTimeout(r, 1700))
    setSuppliers(found)
    setStep('suppliers')
  }, [item, partString])

  // Totals (incl. delivery & transport).
  const total = useMemo(
    () => aiPrice ? { min: aiPrice.min * qty + DELIVERY.min, max: aiPrice.max * qty + DELIVERY.max } : null,
    [aiPrice, qty],
  )

  const dispatchTo = useCallback((s: Supplier) => {
    if (!item || !total) return
    const lines = [
      `Hello${s.name ? ' ' + s.name : ''}, I'm on MOTOFIX and I'd like to order a spare part:`,
      '',
      `• ${partString()}`,
      `• Quantity: ${qty}`,
      `• Estimated total (incl. delivery): ${fmtUGX(total.min)} – ${fmtUGX(total.max)}`,
    ]
    if (posRef.current) lines.push('', `Deliver to: https://maps.google.com/?q=${posRef.current.lat},${posRef.current.lng}`)
    lines.push('', 'Is this available, and what is your best price + delivery?')
    const text = encodeURIComponent(lines.join('\n'))
    const digits = waDigits(s.phone)
    window.open(digits ? `https://wa.me/${digits}?text=${text}` : `https://wa.me/?text=${text}`, '_blank')

    partsService.createOrder({
      fault_category: faultCategory,
      fault_label: `${partString()} ×${qty}`,
      parts: [{ name: partString(), price_min: total.min, price_max: total.max, qty }],
      dealer_name: s.name ?? null,
      dealer_phone: s.phone ?? null,
      dealer_place_id: s.place_id ?? null,
      estimated_total_min: total.min,
      estimated_total_max: total.max,
    }).then(() => toast.success('Order saved to your history')).catch(() => {
      toast.error('WhatsApp opened, but the order could not be saved to your history.')
    })
    setDispatched(s)
  }, [item, faultCategory, total, qty, partString])

  const openOrders = () => {
    setOrdersOpen(true); setOrdersLoading(true)
    partsService.listOrders().then(r => setOrders(r.data || [])).catch(() => setOrders([])).finally(() => setOrdersLoading(false))
  }

  const catColor = (id: string) => CATS.find(c => c.id === id)?.color ?? PURPLE

  return (
    <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <style>{`
        @keyframes ops-spin { to { transform: rotate(360deg); } }
        @keyframes ops-fade { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes ops-ring { 0% { transform: scale(0.8); opacity: 0.6; } 100% { transform: scale(2); opacity: 0; } }
        .ops-card:active { transform: scale(0.99); }
        .ops-card { transition: transform 0.16s ease, box-shadow 0.16s ease; }
      `}</style>

      {/* Slim toolbar — sub-step back (the hub header sits above) + My Orders */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--border-2)', flexShrink: 0 }}>
        {step !== 'shop' ? (
          <button onClick={stepBack} style={{ width: 34, height: 34, borderRadius: 10, flexShrink: 0, border: '1px solid var(--border-2)', cursor: 'pointer', background: 'var(--surface-2)', color: textHi, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <ArrowLeft size={17} />
          </button>
        ) : <div style={{ width: 34 }} />}
        <div style={{ flex: 1, fontSize: 12.5, fontWeight: 800, color: textLo, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
          {step === 'shop' ? 'Browse parts' : step === 'configure' ? 'Configure' : step === 'searching' ? 'Finding suppliers' : 'Suppliers nearby'}
        </div>
        <button onClick={openOrders} style={{ display: 'flex', alignItems: 'center', gap: 6, height: 34, padding: '0 12px', borderRadius: 10, flexShrink: 0, border: '1px solid var(--border-2)', cursor: 'pointer', background: 'var(--surface-2)', color: textHi, fontSize: 12.5, fontWeight: 700 }}>
          <ReceiptText size={15} /> Orders
        </button>
      </div>

      {/* ── SHOP ─────────────────────────────────────────────── */}
      {step === 'shop' && (
        <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none' }}>
          {/* Search */}
          <div style={{ padding: '12px 16px 8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--surface-2)', borderRadius: 14, border: '1px solid var(--border-2)', padding: '10px 14px' }}>
              <Search size={16} style={{ color: textLo }} />
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search parts — tyres, battery, brake pads…"
                style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: textHi, fontSize: 14 }} />
              {query && <button onClick={() => setQuery('')} style={{ background: 'none', border: 'none', cursor: 'pointer' }}><X size={15} style={{ color: textLo }} /></button>}
            </div>
          </div>
          {/* Category chips */}
          <div style={{ display: 'flex', gap: 8, overflowX: 'auto', scrollbarWidth: 'none', padding: '4px 16px 10px' }}>
            {['All', ...CATS.map(c => c.id)].map(c => {
              const lbl = c === 'All' ? 'All' : CATS.find(x => x.id === c)!.label
              const on = catFilter === c
              return (
                <button key={c} onClick={() => setCatFilter(c)} style={{ flexShrink: 0, padding: '6px 13px', borderRadius: 20, background: on ? PURPLE : 'var(--surface-2)', border: on ? 'none' : '1px solid var(--border-2)', color: on ? '#fff' : textMd, fontSize: 12, fontWeight: on ? 800 : 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>{lbl}</button>
              )
            })}
          </div>
          {/* List — wide rows */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9, padding: '4px 16px 32px' }}>
            {filtered.map(it => {
              const col = catColor(it.cat)
              const catLabel = CATS.find(c => c.id === it.cat)?.label ?? ''
              return (
                <div key={it.id} className="ops-card" onClick={() => openItem(it)}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, background: surface, borderRadius: 14, border, padding: '15px 16px', cursor: 'pointer', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
                  <div style={{ width: 4, alignSelf: 'stretch', borderRadius: 4, background: col, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ color: textHi, fontWeight: 800, fontSize: 15, lineHeight: 1.2 }}>{it.name}</p>
                    <p style={{ color: textLo, fontSize: 10.5, marginTop: 4, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700 }}>{catLabel}</p>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <p style={{ color: col, fontSize: 14, fontWeight: 800 }}>{fmtUGX(it.min)} – {fmtUGX(it.max)}</p>
                    <p style={{ color: textLo, fontSize: 9.5, marginTop: 2, textTransform: 'uppercase', letterSpacing: '0.06em' }}>est. range</p>
                  </div>
                </div>
              )
            })}
            {filtered.length === 0 && <p style={{ textAlign: 'center', color: textLo, fontSize: 13, padding: 24 }}>No parts match "{query}".</p>}
          </div>
        </div>
      )}

      {/* ── CONFIGURE ────────────────────────────────────────── */}
      {step === 'configure' && item && (() => {
        const col = catColor(item.cat)
        return (
          <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none', padding: '16px 16px 120px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
              <div style={{ width: 46, height: 46, borderRadius: 13, background: `${col}18`, border: `1.5px solid ${col}38`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                {(() => { const I = CATS.find(c => c.id === item.cat)?.Icon ?? Package; return <I size={22} style={{ color: col }} /> })()}
              </div>
              <div>
                <p style={{ color: textHi, fontWeight: 900, fontSize: 17 }}>{item.name}</p>
                <p style={{ color: col, fontSize: 12.5, fontWeight: 800 }}>{fmtUGX(item.min)} – {fmtUGX(item.max)} <span style={{ color: textLo, fontWeight: 600 }}>· before quote</span></p>
              </div>
            </div>

            {/* Spec questions */}
            <p style={{ color: textLo, fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.14em', marginBottom: 10 }}>Tell us what you need</p>
            <div style={{ marginBottom: 14 }}>
              <label htmlFor="parts-fault-category" style={{ color: textMd, fontSize: 12.5, fontWeight: 700, display: 'block', marginBottom: 6 }}>Issue category</label>
              <select
                id="parts-fault-category"
                value={faultCategory}
                onChange={e => setFaultCategory(e.target.value)}
                style={{ width: '100%', background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 11, padding: '10px 12px', color: textHi, fontSize: 14 }}
              >
                {FAULT_CATEGORIES.map(category => <option key={category.id} value={category.id}>{category.label}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 18 }}>
              {item.specs.map(s => (
                <div key={s.key}>
                  <label style={{ color: textMd, fontSize: 12.5, fontWeight: 700, display: 'block', marginBottom: 6 }}>{s.label}</label>
                  {s.type === 'select' ? (
                    <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                      {s.options!.map(opt => {
                        const on = cfg[s.key] === opt
                        return <button key={opt} onClick={() => setCfg(c => ({ ...c, [s.key]: opt }))} style={{ padding: '8px 13px', borderRadius: 11, background: on ? col : 'var(--surface-2)', border: on ? 'none' : '1px solid var(--border-2)', color: on ? '#000' : textMd, fontSize: 12.5, fontWeight: on ? 800 : 600, cursor: 'pointer' }}>{opt}</button>
                      })}
                    </div>
                  ) : (
                    <input type="number" min={1} value={cfg[s.key] ?? '1'} onChange={e => setCfg(c => ({ ...c, [s.key]: e.target.value }))}
                      style={{ width: 110, background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 11, padding: '9px 12px', color: textHi, fontSize: 14, outline: 'none' }} />
                  )}
                </div>
              ))}
            </div>

            {/* Car make */}
            <p style={{ color: textLo, fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.14em', marginBottom: 10 }}>For which car?</p>
            <div style={{ position: 'relative', marginBottom: cfg.make ? 14 : 4 }}>
              <button onClick={() => setMakeOpen(o => !o)} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderRadius: 12, background: 'var(--surface-2)', border: '1px solid var(--border-2)', cursor: 'pointer', color: cfg.make ? textHi : textLo, fontSize: 14, fontWeight: cfg.make ? 700 : 500 }}>
                {cfg.make || 'Select car make'}
                <ChevronDown size={17} style={{ color: textLo, transform: makeOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
              </button>
              {makeOpen && (
                <div style={{ position: 'absolute', top: 50, left: 0, right: 0, zIndex: 20, maxHeight: 260, overflowY: 'auto', background: 'var(--overlay-bg)', border: '1px solid var(--border-3)', borderRadius: 14, boxShadow: '0 16px 48px rgba(0,0,0,0.4)' }}>
                  {CAR_MAKES.map(m => (
                    <button key={m.make} onClick={() => { setCfg(c => ({ ...c, make: m.make, model: '' })); setMakeOpen(false) }} style={{ width: '100%', textAlign: 'left', padding: '11px 14px', background: 'transparent', border: 'none', borderBottom: '1px solid var(--border-1)', cursor: 'pointer', color: textHi, fontSize: 13.5, fontWeight: 600 }}>{m.make}</button>
                  ))}
                </div>
              )}
            </div>

            {/* AI-matched models */}
            {cfg.make && (
              <div style={{ animation: 'ops-fade 0.3s ease both', marginBottom: 8 }}>
                <p style={{ color: textMd, fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                  <Sparkles size={13} style={{ color: col }} /> Available {cfg.make} models — pick yours
                </p>
                {cfg.make === 'Other' || (makeObj && makeObj.models.length === 0) ? (
                  <input value={cfg.model ?? ''} onChange={e => setCfg(c => ({ ...c, model: e.target.value }))} placeholder="Type your car model"
                    style={{ width: '100%', boxSizing: 'border-box', background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 11, padding: '10px 13px', color: textHi, fontSize: 14, outline: 'none' }} />
                ) : (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {makeObj!.models.map(md => {
                      const on = cfg.model === md
                      return <button key={md} onClick={() => setCfg(c => ({ ...c, model: md }))} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 13px', borderRadius: 11, background: on ? col : 'var(--surface-2)', border: on ? 'none' : '1px solid var(--border-2)', color: on ? '#000' : textMd, fontSize: 12.5, fontWeight: on ? 800 : 600, cursor: 'pointer' }}>
                        {on && <CheckCircle2 size={13} />}{md}
                      </button>
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })()}

      {/* Configure footer CTA */}
      {step === 'configure' && item && (
        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '12px 16px', paddingBottom: 'max(12px, env(safe-area-inset-bottom, 12px))', background: 'var(--header-bg)', borderTop: '1px solid var(--border-2)' }}>
          <button onClick={proceed} disabled={!requiredFilled}
            style={{ width: '100%', height: 52, borderRadius: 15, border: 'none', cursor: requiredFilled ? 'pointer' : 'not-allowed', background: requiredFilled ? `linear-gradient(135deg, ${PURPLE}, #7C3AED)` : 'var(--surface-3)', color: requiredFilled ? '#fff' : 'var(--text-ghost)', fontSize: 15, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9 }}>
            <ShoppingCart size={18} /> {requiredFilled ? 'Proceed to Checkout' : 'Choose options & car first'}
          </button>
        </div>
      )}

      {/* ── SEARCHING animation ──────────────────────────────── */}
      {step === 'searching' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 22, padding: 32 }}>
          <div style={{ position: 'relative', width: 96, height: 96, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {[0, 1, 2].map(i => <div key={i} style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: `1.5px solid ${PURPLE}`, animation: `ops-ring 1.8s ${i * 0.5}s ease-out infinite` }} />)}
            <div style={{ width: 64, height: 64, borderRadius: '50%', background: `${PURPLE}18`, border: `1.5px solid ${PURPLE}55`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Truck size={28} style={{ color: PURPLE }} />
            </div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <p style={{ color: textHi, fontWeight: 900, fontSize: 18, marginBottom: 6 }}>Finding suppliers near you…</p>
            <p style={{ color: textLo, fontSize: 13, lineHeight: 1.6, maxWidth: 280 }}>
              {MOTOBOT_ENABLED
                ? 'MOTOBOT is pricing your part and matching it with spare-parts suppliers in your area.'
                : 'Using the catalogue estimate while we find spare-parts suppliers in your area.'}
            </p>
          </div>
          <Loader2 size={22} style={{ color: PURPLE, animation: 'ops-spin 0.9s linear infinite' }} />
        </div>
      )}

      {/* ── SUPPLIERS / dispatch ─────────────────────────────── */}
      {step === 'suppliers' && item && total && (
        <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none', padding: '16px 16px 32px' }}>
          {dispatched ? (
            <div style={{ textAlign: 'center', padding: '40px 12px', animation: 'ops-fade 0.3s ease both' }}>
              <div style={{ width: 72, height: 72, borderRadius: '50%', margin: '0 auto 16px', background: 'rgba(34,197,94,0.14)', border: '1.5px solid rgba(34,197,94,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <CheckCircle2 size={36} style={{ color: '#22c55e' }} />
              </div>
              <p style={{ color: textHi, fontWeight: 900, fontSize: 19, marginBottom: 8 }}>Request sent</p>
              <p style={{ color: textMd, fontSize: 13.5, lineHeight: 1.65, marginBottom: 22, maxWidth: 300, marginLeft: 'auto', marginRight: 'auto' }}>
                Your order for <strong style={{ color: textHi }}>{partString()}</strong> (×{qty}) was sent to <strong style={{ color: textHi }}>{dispatched.name}</strong>. They'll confirm availability and final price. Check My Orders to confirm it was saved.
              </p>
              <button onClick={() => { setStep('shop'); setItem(null) }} style={{ width: '100%', maxWidth: 280, height: 48, borderRadius: 14, border: 'none', cursor: 'pointer', background: `linear-gradient(135deg, ${PURPLE}, #7C3AED)`, color: '#fff', fontWeight: 800, fontSize: 14.5 }}>Back to Shop</button>
            </div>
          ) : (
            <>
              {/* Order summary */}
              <div style={{ borderRadius: 18, border, background: surface, padding: '16px', marginBottom: 16 }}>
                <p style={{ color: textHi, fontWeight: 800, fontSize: 14, marginBottom: 4 }}>{partString()}</p>
                <p style={{ color: textLo, fontSize: 12, marginBottom: 12 }}>Quantity: {qty}</p>
                <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', paddingTop: 12, borderTop: '1px dashed var(--border-2)' }}>
                  <div>
                    <p style={{ color: textLo, fontSize: 11, display: 'flex', alignItems: 'center', gap: 5 }}>
                      {MOTOBOT_ENABLED && <Sparkles size={11} style={{ color: PURPLE }} />}
                      {MOTOBOT_ENABLED ? 'MOTOBOT estimate' : 'Catalogue estimate'} · incl. delivery
                    </p>
                    <p style={{ color: PURPLE, fontWeight: 900, fontSize: 20, marginTop: 3 }}>{fmtUGX(total.min)} – {fmtUGX(total.max)}</p>
                  </div>
                  <span style={{ fontSize: 10.5, color: textLo, display: 'flex', alignItems: 'center', gap: 4 }}><Truck size={12} /> +{fmtUGX(DELIVERY.min)}–{fmtUGX(DELIVERY.max)} transport</span>
                </div>
              </div>

              <p style={{ color: textLo, fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.14em', marginBottom: 10 }}>
                {suppliers.length > 0 ? `${suppliers.length} supplier${suppliers.length === 1 ? '' : 's'} found nearby` : 'Send your request'}
              </p>

              {suppliers.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {suppliers.map((s, i) => (
                    <div key={i} className="ops-card" onClick={() => dispatchTo(s)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 14px', borderRadius: 15, border, background: surface, cursor: 'pointer' }}>
                      <div style={{ width: 42, height: 42, borderRadius: 12, flexShrink: 0, background: `${PURPLE}18`, border: `1.5px solid ${PURPLE}38`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <ShoppingBag size={19} style={{ color: PURPLE }} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ color: textHi, fontWeight: 700, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</p>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
                          {s.rating != null && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, color: '#F59E0B', fontWeight: 700 }}><Star size={11} style={{ fill: '#F59E0B' }} /> {s.rating.toFixed(1)}</span>}
                          {s.vicinity && <span style={{ fontSize: 11, color: textLo, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.vicinity}</span>}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#25D366', fontSize: 12, fontWeight: 800, flexShrink: 0 }}><MessageCircle size={15} /> Send</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ borderRadius: 16, border, background: surface, padding: '18px 16px', textAlign: 'center' }}>
                  <MapPin size={26} style={{ color: textLo, margin: '0 auto 10px' }} />
                  <p style={{ color: textHi, fontWeight: 700, fontSize: 13, marginBottom: 4 }}>No nearby suppliers detected</p>
                  <p style={{ color: textLo, fontSize: 12, marginBottom: 14 }}>You can still send your request out on WhatsApp and we'll save it.</p>
                  <button onClick={() => dispatchTo({ name: 'a nearby supplier' })} style={{ width: '100%', height: 46, borderRadius: 13, border: 'none', cursor: 'pointer', background: '#25D366', color: '#fff', fontWeight: 800, fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}><MessageCircle size={16} /> Send request on WhatsApp</button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Orders history */}
      {ordersOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'var(--bg)', display: 'flex', flexDirection: 'column', maxWidth: 480, margin: '0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', background: 'var(--header-bg)', borderBottom: '1px solid var(--border-2)', paddingTop: 'max(14px, env(safe-area-inset-top, 14px))' }}>
            <button onClick={() => setOrdersOpen(false)} style={{ width: 36, height: 36, borderRadius: 10, border: '1px solid var(--border-2)', cursor: 'pointer', background: 'var(--surface-2)', color: textHi, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><ArrowLeft size={18} /></button>
            <div style={{ fontSize: 15, fontWeight: 800, color: textHi }}>My Orders</div>
          </div>
          {ordersLoading ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Loader2 size={26} style={{ color: PURPLE, animation: 'ops-spin 0.9s linear infinite' }} /></div>
          ) : orders.length === 0 ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 32, textAlign: 'center' }}>
              <ShoppingBag size={34} style={{ color: textLo, opacity: 0.6 }} />
              <div style={{ fontSize: 14, fontWeight: 700, color: textHi }}>No orders yet</div>
              <div style={{ fontSize: 12.5, color: textLo }}>Parts you order will appear here.</div>
            </div>
          ) : (
            <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
              {orders.map(o => (
                <div key={o.id} style={{ background: surface, borderRadius: 14, padding: 14, border }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <GitBranch size={15} style={{ color: PURPLE, flexShrink: 0 }} />
                    <span style={{ fontSize: 13.5, fontWeight: 700, color: textHi }}>{o.fault_label || 'Spare part'}</span>
                  </div>
                  {o.dealer_name && <div style={{ fontSize: 12.5, color: textMd, marginBottom: 4 }}>Supplier: <strong>{o.dealer_name}</strong>{o.dealer_phone ? ` · ${o.dealer_phone}` : ''}</div>}
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: textLo }}>
                    <Clock size={11} /> {new Date(o.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
