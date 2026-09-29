// FaultChat.tsx — the full MOTOBOT chat screen (opened from the floating robot button
// or "Not sure? Let AI diagnose"). The driver chats by text, voice note, or photo and
// MOTOBOT helps work out the fault; once it has enough it produces a diagnosis the
// driver can act on. This is the car-only AI assistant; chat history is kept on-device.

import { useState, useRef, useEffect, type ReactNode } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  ArrowLeft, Send, Mic, MicOff, Paperclip, Camera,
  Zap, Battery, Disc3, Fuel, Truck, HelpCircle,
  Loader2, ChevronRight, AlertTriangle, X, Play, Pause,
  Search, History, Plus, Trash2, MessageSquare,
} from 'lucide-react';
import { MotobotFace } from '@/components/MotobotFace';
import { useAuth } from '@/hooks/useAuth';
import { diagnosisService, ChatMessage, DiagnosisResult } from '@/config/api';

/* LocalMessage extends ChatMessage with an optional image blob URL for display.
   imageUrl is never sent to the API or stored in localStorage. */
interface LocalMessage extends ChatMessage {
  imageUrl?: string;
  ts?: number; // epoch ms — for WhatsApp-style timestamps
}
import { toast } from 'sonner';

/* ── Storage keys ─────────────────────────────────────────────────────────── */
const CHAT_CURRENT_KEY = 'motofix_chat_current';
const CHAT_HISTORY_KEY = 'motofix_chat_history';

/* ── Session model ────────────────────────────────────────────────────────── */
interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: (ChatMessage & { ts?: number })[];
  diagnosis: DiagnosisResult | null;
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/* ── Evolving title logic ──────────────────────────────────────────────────
   Phase 1 — first user message (raw, truncated)
   Phase 2 — keyword extraction: fault label + vehicle type detected in msgs
   Phase 3 — diagnosis confirmed: structured "Fault Category · Severity"
   ──────────────────────────────────────────────────────────────────────── */
const _FAULT_TERMS: [string, string][] = [
  ["won't start", "Won't Start"], ["not starting", "Won't Start"],
  ["smoke",    "Smoke / Fire"],  ["fire",       "Fire Emergency"],
  ["accident", "Accident"],      ["bleeding",   "Medical Emergency"],
  ["puncture", "Puncture"],      ["flat tyre",  "Flat Tyre"],
  ["flat tire","Flat Tyre"],     ["tyre",       "Tyre Problem"],
  ["tire",     "Tyre Problem"],  ["battery",    "Battery Issue"],
  ["overheating","Overheating"], ["overheat",   "Overheating"],
  ["brake",    "Brake Issue"],   ["engine",     "Engine Issue"],
  ["fuel",     "Fuel Problem"],  ["oil",        "Oil Issue"],
  ["electrical","Electrical Fault"], ["transmission","Transmission"],
  ["suspension","Suspension"],   ["exhaust",    "Exhaust Problem"],
  ["radiator", "Radiator Issue"],["clutch",     "Clutch Problem"],
  ["gearbox",  "Gearbox Issue"], ["starter",    "Starter Problem"],
  ["coolant",  "Coolant Issue"], ["noise",      "Strange Noise"],
  ["knocking", "Knocking Noise"],["stalling",   "Stalling Issue"],
  ["stall",    "Stalling Issue"],["leaking",    "Fluid Leak"],
];

const _VEHICLE_TERMS: [string, string][] = [
  ["boda-boda","Boda-boda"], ["boda","Boda-boda"], ["motorcycle","Motorcycle"],
  ["matatu",   "Matatu"],    ["minibus","Minibus"], ["lorry","Lorry"],
  ["truck",    "Truck"],     ["saloon","Car"],      ["van","Van"],
  ["car",      "Car"],
];

function sessionTitle(messages: ChatMessage[], diag?: DiagnosisResult | null): string {
  // Phase 3 — diagnosis confirmed
  if (diag) {
    const cat = diag.fault_category.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const sev = diag.severity.charAt(0).toUpperCase() + diag.severity.slice(1);
    return `${cat} · ${sev}`;
  }

  const userMsgs = messages.filter(m => m.role === 'user');
  if (userMsgs.length === 0) return 'New conversation';

  const combined = userMsgs.map(m => m.content.toLowerCase()).join(' ');

  // Phase 2 — keyword extraction once there are 2+ user messages or a fault keyword is found
  let faultLabel = '';
  for (const [term, label] of _FAULT_TERMS) {
    if (combined.includes(term)) { faultLabel = label; break; }
  }

  let vehicleLabel = '';
  for (const [term, label] of _VEHICLE_TERMS) {
    if (combined.includes(term)) { vehicleLabel = label; break; }
  }

  if (faultLabel && vehicleLabel) return `${faultLabel} — ${vehicleLabel}`;
  if (faultLabel) return faultLabel;

  // Phase 1 — raw first message, truncated
  const raw = userMsgs[0].content;
  return raw.length > 42 ? raw.slice(0, 42) + '…' : raw;
}

function loadHistory(): ChatSession[] {
  try { return JSON.parse(localStorage.getItem(CHAT_HISTORY_KEY) || '[]'); }
  catch { return []; }
}

function saveHistory(sessions: ChatSession[]) {
  localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(sessions.slice(0, 50)));
}

/* ── Lightweight markdown → JSX (bold, italic, inline code, bullets) ─────────
   The AI replies in markdown (**bold**, - bullets); render it instead of
   showing raw asterisks. */
function renderInline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([\s\S]+?)\*\*|\*([\s\S]+?)\*|_([\s\S]+?)_|`([\s\S]+?)`/g;
  let last = 0, i = 0, m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push(s.slice(last, m.index));
    if (m[1] != null) out.push(<strong key={i++}>{m[1]}</strong>);
    else if (m[2] != null) out.push(<em key={i++}>{m[2]}</em>);
    else if (m[3] != null) out.push(<em key={i++}>{m[3]}</em>);
    else out.push(<code key={i++} style={{ background: 'rgba(255,255,255,0.08)', padding: '1px 5px', borderRadius: 5, fontSize: '0.9em' }}>{m[4]}</code>);
    last = re.lastIndex;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

function renderRich(text: string): ReactNode {
  return text.split('\n').map((line, li) => {
    const bullet = line.match(/^(\s*)([-•*])\s+(.*)$/);
    if (bullet) {
      return (
        <div key={li} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', margin: '2px 0' }}>
          <span style={{ color: '#F59E0B', flexShrink: 0, lineHeight: 1.5 }}>•</span>
          <span>{renderInline(bullet[3])}</span>
        </div>
      );
    }
    if (line.trim() === '') return <div key={li} style={{ height: 6 }} />;
    return <div key={li}>{renderInline(line)}</div>;
  });
}

/* ── Quick issue chips ──────────────────────────────────────────────────────── */
const CHIPS = [
  { label: 'Flat Tyre',   icon: Disc3,       hint: "My tyre is flat",                    color: '#F59E0B' },
  { label: 'Engine',      icon: Zap,         hint: "Engine problem, car won't start",    color: '#EF4444' },
  { label: 'Battery',     icon: Battery,     hint: "Battery dead, car won't start",      color: '#60A5FA' },
  { label: 'Out of Fuel', icon: Fuel,        hint: "I've run out of fuel",               color: '#34D399' },
  { label: 'Need Towing', icon: Truck,       hint: "My car needs to be towed",           color: '#A78BFA' },
  { label: 'Other issue', icon: HelpCircle,  hint: "I have another vehicle problem",     color: '#F59E0B' },
];

/* Live type-ahead suggestions — common vehicle problems, filtered as the driver types. */
const SUGGESTIONS = [
  "My car won't start",
  "Engine is overheating",
  "I have a flat tyre",
  "My battery is dead",
  "I've run out of fuel",
  "My brakes are making a grinding noise",
  "There's smoke coming from the engine",
  "My car is making a strange knocking sound",
  "A dashboard warning light is on",
  "My car is leaking oil",
  "The AC is not cooling",
  "My car stalls when idling",
  "The clutch is slipping",
  "Gears are hard to change",
  "My headlights are not working",
  "The car pulls to one side when driving",
  "My tyre keeps losing pressure",
  "I was in an accident",
  "My car needs towing",
  "Where can I buy spare parts?",
  "How do I make an insurance claim?",
  "The engine is misfiring",
  "My car vibrates at high speed",
  "The radiator is leaking coolant",
  "The steering feels heavy",
];

const SEVERITY_COLOR: Record<string, string> = {
  low: '#34D399', medium: '#F59E0B', high: '#F87171', critical: '#EF4444',
};
const SEVERITY_BG: Record<string, string> = {
  low: 'rgba(52,211,153,0.1)', medium: 'rgba(245,158,11,0.1)', high: 'rgba(248,113,113,0.1)', critical: 'rgba(239,68,68,0.1)',
};
const PROVIDER_LABEL: Record<string, string> = {
  mechanic: 'Mechanic', towing_provider: 'Towing Service',
  spare_parts_dealer: 'Spare Parts', ambulance: '🚨 Ambulance — Emergency',
};

/* ── Guided request flow — quick-answer decision tree ─────────────────────── */
interface GuideIssue {
  key: string; // maps to create-request issueType
  emoji: string;
  label: string;
  clarify?: { q: string; opts: string[] };
}
const GUIDE_ISSUES: GuideIssue[] = [
  { key: 'flat_tire', emoji: '🛞', label: 'Flat / damaged tyre',   clarify: { q: 'Can the car still move slowly, or is it stuck?', opts: ['It can move slowly', "It's stuck"] } },
  { key: 'battery',   emoji: '🔋', label: 'Dead battery',          clarify: { q: 'Do the dashboard lights come on?', opts: ['Yes, lights come on', 'No / nothing'] } },
  { key: 'engine',    emoji: '🔧', label: "Engine won't start",    clarify: { q: 'Does it crank (turn over) but not start, or nothing at all?', opts: ["Cranks, won't start", 'Nothing happens'] } },
  { key: 'engine',    emoji: '🌡️', label: 'Overheating',           clarify: { q: 'Any steam or a burning smell?', opts: ['Yes, steam/smell', 'No'] } },
  { key: 'fuel',      emoji: '⛽', label: 'Out of fuel' },
  { key: 'breakdown', emoji: '🚧', label: "Car won't move",        clarify: { q: 'Did it stop suddenly, or after a noise/warning?', opts: ['Stopped suddenly', 'After a noise'] } },
  { key: 'other',     emoji: '🚨', label: 'Accident / collision',  clarify: { q: 'Is anyone injured?', opts: ["Yes — someone's hurt", 'No injuries'] } },
  { key: 'other',     emoji: '💬', label: 'Something else' },
];

interface RouteState { issueType?: string; prefillLocation?: string; prefillLat?: number; prefillLng?: number; }

export default function FaultChat() {
  const navigate   = useNavigate();
  const location   = useLocation();
  const { user }   = useAuth();
  const routeState = location.state as RouteState | null;

  const isOtherIssue = routeState?.issueType === 'other';
  const firstName = user?.full_name?.trim().split(/\s+/)[0] || 'there';

  const defaultGreeting: LocalMessage = {
    role: 'assistant',
    content: isOtherIssue
      ? `👋 Welcome, ${firstName}! I'm MOTOBOT, the AI for MOTOFIX. You've flagged an unspecified vehicle issue — describe what you're experiencing (unusual sounds, smells, warning lights, loss of power) and I'll help. You can also type, send a photo, or record a voice note. (Vehicle & roadside problems only.)`
      : `👋 Welcome, ${firstName}! I'm MOTOBOT, the AI for MOTOFIX — how can I help with your vehicle today?\n\nTap an option below, or just type / send a photo or voice note. (I only handle vehicle & roadside problems.)`,
  };

  /* ── Session ID ─────────────────────────────────────────────────────────── */
  const sessionIdRef = useRef<string>(makeId());

  /* ── Core state ─────────────────────────────────────────────────────────── */
  const [messages,     setMessages]     = useState<LocalMessage[]>([defaultGreeting]);
  const [input,        setInput]        = useState('');
  const [sending,      setSending]      = useState(false);
  const [diagnosis,    setDiagnosis]    = useState<DiagnosisResult | null>(null);
  const [step,         setStep]         = useState<'issue' | 'clarify' | 'consent' | 'idle'>('issue');
  const [pendingIssue, setPendingIssue] = useState<GuideIssue | null>(null);
  const [guidedIssueKey, setGuidedIssueKey] = useState<string>('other');
  const [recording,    setRecording]    = useState(false);
  const [audioBlob,    setAudioBlob]    = useState<Blob | null>(null);
  const [audioUrl,     setAudioUrl]     = useState('');
  const [playing,      setPlaying]      = useState(false);
  const [attachments,  setAttachments]  = useState<File[]>([]);

  /* ── History drawer state ───────────────────────────────────────────────── */
  const [showHistory, setShowHistory] = useState(false);
  const [historyList, setHistoryList] = useState<ChatSession[]>([]);

  const bottomRef   = useRef<HTMLDivElement>(null);
  const fileRef     = useRef<HTMLInputElement>(null);
  const cameraRef   = useRef<HTMLInputElement>(null);
  const audioRef    = useRef<HTMLAudioElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef   = useRef<Blob[]>([]);

  /* ── Restore current session on mount ──────────────────────────────────── */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(CHAT_CURRENT_KEY);
      if (raw) {
        const saved: ChatSession = JSON.parse(raw);
        if (saved.messages && saved.messages.length > 1) {
          sessionIdRef.current = saved.id;
          setMessages(saved.messages);
          setDiagnosis(saved.diagnosis ?? null);
          setStep('idle'); // restored mid-conversation — don't show the greeting options
        }
      }
    } catch { /* ignore corrupt storage */ }
  }, []);

  /* ── Auto-save current session whenever messages or diagnosis change ────── */
  useEffect(() => {
    const hasUserMessages = messages.some(m => m.role === 'user');
    if (!hasUserMessages) return;
    // Strip imageUrl (blob URLs don't survive a reload)
    const storable = messages.map(({ role, content, ts }) => ({ role, content, ts }));
    const session: ChatSession = {
      id: sessionIdRef.current,
      title: sessionTitle(messages, diagnosis),
      createdAt: sessionIdRef.current,
      updatedAt: new Date().toISOString(),
      messages: storable,
      diagnosis,
    };
    localStorage.setItem(CHAT_CURRENT_KEY, JSON.stringify(session));
  }, [messages, diagnosis]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, diagnosis]);

  /* ── New Chat ────────────────────────────────────────────────────────────── */
  function newChat() {
    const hasUserMessages = messages.some(m => m.role === 'user');
    if (hasUserMessages) {
      const storable = messages.map(({ role, content, ts }) => ({ role, content, ts }));
      const session: ChatSession = {
        id: sessionIdRef.current,
        title: sessionTitle(messages, diagnosis),
        createdAt: sessionIdRef.current,
        updatedAt: new Date().toISOString(),
        messages: storable,
        diagnosis,
      };
      const history = loadHistory();
      const filtered = history.filter(s => s.id !== session.id);
      saveHistory([session, ...filtered]);
    }
    localStorage.removeItem(CHAT_CURRENT_KEY);
    sessionIdRef.current = makeId();
    setMessages([defaultGreeting]);
    setDiagnosis(null);
    setStep('issue');
    setPendingIssue(null);
    setInput('');
    setAudioBlob(null);
    setAudioUrl('');
    setAttachments([]);
  }

  /* ── Guided quick-answer flow ────────────────────────────────────────────── */
  function pushUser(text: string) { setMessages(m => [...m, { role: 'user', content: text, ts: Date.now() }]); }
  function pushBot(text: string)  { setMessages(m => [...m, { role: 'assistant', content: text, ts: Date.now() }]); }

  function pickIssue(issue: GuideIssue) {
    pushUser(`${issue.emoji} ${issue.label}`);
    if (issue.label === 'Something else') {
      setStep('idle'); setPendingIssue(null);
      setTimeout(() => pushBot("Sure — tell me what's happening in your own words. You can also send a photo or a voice note."), 250);
      return;
    }
    if (issue.clarify) {
      setPendingIssue(issue);
      setStep('clarify');
      setTimeout(() => pushBot(issue.clarify!.q), 250);
    } else {
      runDiagnose(issue, '');
    }
  }

  function pickClarify(answer: string) {
    const issue = pendingIssue;
    pushUser(answer);
    if (issue) runDiagnose(issue, `${issue.clarify?.q ?? ''} ${answer}`);
  }

  async function runDiagnose(issue: GuideIssue, extra: string) {
    setStep('idle');
    setGuidedIssueKey(issue.key);
    setSending(true);
    try {
      const res = await diagnosisService.diagnoseText(`${issue.label}. ${extra}`.trim());
      setDiagnosis(res.data);
      pushBot("Here's my assessment 👇");
      setStep('consent');
    } catch {
      pushBot("I couldn't analyse that just now — could you describe the problem in your own words?");
    } finally { setSending(false); }
  }

  // Hand off to the current request flow (same as Home): /locating → /describe-issue.
  function goToLocating(issueType: string, triage?: DiagnosisResult | null) {
    const serviceType = issueType === 'towing' ? 'towing_provider' : issueType === 'breakdown' ? 'both' : 'mechanic';
    const breakdownPrefs = issueType === 'breakdown' ? { fixOnSpot: true, allowTow: true } : undefined;
    navigate('/locating', {
      state: {
        issueType,
        serviceType,
        breakdownPrefs,
        aiSummary: triage?.fault_description,
        aiDiagnosis: triage ?? undefined,
      },
    });
  }

  function shareLocation() {
    pushUser('📍 Share my location');
    setStep('idle');
    goToLocating(guidedIssueKey, diagnosis);
  }

  function declineLocation() {
    pushUser('Not now');
    setStep('idle');
    pushBot('No problem. When you’re ready, tap "Find Nearby Help" on the summary above and I’ll send help to you.');
  }

  /* ── Open history drawer ─────────────────────────────────────────────────── */
  function openHistory() {
    setHistoryList(loadHistory());
    setShowHistory(true);
  }

  /* ── Load a history session as the active chat ───────────────────────────── */
  function openSession(s: ChatSession) {
    // Save current chat to history first (if it has messages and isn't the same session)
    const hasUserMessages = messages.some(m => m.role === 'user');
    if (hasUserMessages && sessionIdRef.current !== s.id) {
      const current: ChatSession = {
        id: sessionIdRef.current,
        title: sessionTitle(messages, diagnosis),
        createdAt: sessionIdRef.current,
        updatedAt: new Date().toISOString(),
        messages,
        diagnosis,
      };
      const history = loadHistory();
      const filtered = history.filter(h => h.id !== current.id && h.id !== s.id);
      saveHistory([s, current, ...filtered]);
    }

    // Load the selected session as the active chat
    sessionIdRef.current = s.id;
    setMessages(s.messages);
    setDiagnosis(s.diagnosis ?? null);
    localStorage.setItem(CHAT_CURRENT_KEY, JSON.stringify(s));
    setShowHistory(false);
  }

  /* ── Delete a history session ────────────────────────────────────────────── */
  function deleteSession(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    const updated = historyList.filter(s => s.id !== id);
    setHistoryList(updated);
    saveHistory(updated);
  }

  /* ── Voice recording ─────────────────────────────────────────────────────── */
  async function startRec() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        setAudioBlob(blob);
        setAudioUrl(URL.createObjectURL(blob));
        stream.getTracks().forEach(t => t.stop());
        toast.success('Voice note ready — tap Send to analyse');
      };
      mr.start();
      recorderRef.current = mr;
      setRecording(true);
    } catch { toast.error('Microphone access denied'); }
  }

  function stopRec() { recorderRef.current?.stop(); setRecording(false); }

  function togglePlay() {
    if (!audioRef.current) return;
    if (audioRef.current.paused) { audioRef.current.play(); setPlaying(true); }
    else { audioRef.current.pause(); setPlaying(false); }
  }

  /* ── File attach ─────────────────────────────────────────────────────────── */
  function addFile(files: FileList | null) {
    if (!files) return;
    setAttachments(a => [...a, ...Array.from(files)]);
  }

  /* ── Send message ────────────────────────────────────────────────────────── */
  async function send(overrideText?: string) {
    let text = (overrideText ?? input).trim();
    if (!text && !audioBlob && attachments.length === 0) return;
    setStep('idle'); // free-text/voice/photo send → leave the guided quick-reply flow
    // Block image-only sends — require a description to help the AI
    if (attachments.some(f => f.type.startsWith('image/')) && !text && !audioBlob) {
      toast.error('Please describe the issue in the photo so the AI can analyse it correctly.');
      return;
    }

    const imageFile = attachments.find(f => f.type.startsWith('image/'));

    // Voice note → transcribe to text first (skipped when a photo is attached — that flow reads the image).
    if (audioBlob && !imageFile) {
      setSending(true);
      try {
        const voiceFile = new File([audioBlob], 'voice.webm', { type: 'audio/webm' });
        const tr = await diagnosisService.transcribe(voiceFile);
        const spoken = (tr.data?.text || '').trim();
        if (spoken) text = text ? `${text} ${spoken}` : spoken;
        else if (!text) {
          toast.error("Couldn't understand the voice note — please try again or type your issue.");
          setSending(false); setAudioBlob(null); setAudioUrl('');
          return;
        }
      } catch {
        if (!text) {
          toast.error('Voice transcription failed — please type your issue instead.');
          setSending(false);
          return;
        }
      }
    }
    const userContent = imageFile
      ? (text ? `📷 Photo — ${text}` : '📷 Photo')
      : text || (audioBlob ? '[Voice note recorded]' : `[${attachments.length} file(s) attached]`);

    const newUserMsg: LocalMessage = {
      role: 'user',
      content: userContent,
      imageUrl: imageFile ? URL.createObjectURL(imageFile) : undefined,
      ts: Date.now(),
    };
    const newMessages: LocalMessage[] = [...messages, newUserMsg];
    setMessages(newMessages);
    setInput('');
    setSending(true);

    try {
      if (imageFile) {
        // Vision-aware chat: model reads the photo, asks questions, then diagnoses
        const priorMessages = messages.slice(1).map(({ role, content }) => ({ role, content }));
        const res = await diagnosisService.chatWithImage(imageFile, priorMessages, text);
        setMessages(m => [...m, { role: 'assistant', content: res.data.reply, ts: Date.now() }]);
        if (res.data.diagnosis_ready && res.data.diagnosis) setDiagnosis(res.data.diagnosis);
        setAttachments([]);
        setSending(false);
        return;
      }

      const chatHistory = newMessages.slice(1).map(({ role, content }) => ({ role, content }));
      const res = await diagnosisService.chat(chatHistory);
      setMessages(m => [...m, { role: 'assistant', content: res.data.reply }]);
      if (res.data.diagnosis_ready && res.data.diagnosis) setDiagnosis(res.data.diagnosis);
      setAudioBlob(null); setAudioUrl(''); setAttachments([]);
    } catch (err: any) {
      const status  = err?.response?.status;
      const detail  = err?.response?.data?.detail ?? err?.message ?? 'Unknown error';
      console.error('Chat error', status, detail, err);

      let userMsg = "I couldn't connect right now. Please try again in a moment.";
      if (status === 401) userMsg = "Session expired — please log out and log back in, then try again.";
      else if (status === 503) userMsg = "The AI service is not configured on this server yet.";
      else if (!navigator.onLine) userMsg = "You appear to be offline. Check your internet connection and try again.";

      setMessages(m => [...m, { role: 'assistant', content: userMsg, ts: Date.now() }]);
      toast.error(`Chat error ${status ?? ''}: ${detail}`.trim());
    } finally { setSending(false); }
  }

  function sendChip(chip: typeof CHIPS[0]) { setInput(''); send(chip.hint); }

  function faultCategoryToIssueType(category: string, providerType: string): string {
    const c = category.toLowerCase();
    if (c.includes('tyre') || c.includes('tire') || c.includes('puncture')) return 'flat_tire';
    if (c.includes('battery'))                                               return 'battery';
    if (c.includes('fuel') || c.includes('gas'))                            return 'fuel';
    if (c.includes('engine') || c.includes('overheat') || c.includes('transmission')) return 'engine';
    if (providerType === 'towing_provider')                                  return 'towing';
    return 'other';
  }

  function findHelp() {
    // Parts-fixable fault → route to the self-fix "parts you'll need" screen.
    if (diagnosis?.provider_type === 'spare_parts_dealer') {
      navigate('/parts-needed', {
        state: {
          diagnosis,
          lat:     routeState?.prefillLat,
          lng:     routeState?.prefillLng,
          address: routeState?.prefillLocation,
        },
      });
      return;
    }
    const issueType = diagnosis
      ? faultCategoryToIssueType(diagnosis.fault_category, diagnosis.provider_type)
      : 'other';
    goToLocating(issueType, diagnosis);
  }

  const guidedOptions: { label: string; onPick: () => void }[] =
    step === 'issue'   ? GUIDE_ISSUES.map(i => ({ label: `${i.emoji} ${i.label}`, onPick: () => pickIssue(i) }))
    : step === 'clarify' && pendingIssue?.clarify ? pendingIssue.clarify.opts.map(o => ({ label: o, onPick: () => pickClarify(o) }))
    : step === 'consent' ? [{ label: '📍 Share my location', onPick: shareLocation }, { label: 'Not now', onPick: declineLocation }]
    : [];
  const q = input.trim().toLowerCase();
  const suggestions = q.length >= 2 && !sending && attachments.length === 0 && !audioBlob
    ? SUGGESTIONS.filter(s => s.toLowerCase().includes(q)).slice(0, 5)
    : [];
  const canSend = !!(input.trim() || audioBlob || attachments.length);

  return (
    <div className="fixed inset-0 flex items-stretch justify-center"
      style={{ background: 'var(--page-bg)', zIndex: 50 }}>

      {/* Ambient glow */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-80 h-80 rounded-full blur-3xl"
          style={{ background: 'radial-gradient(circle, rgba(245,158,11,0.08) 0%, transparent 70%)' }} />
      </div>

      <div className="w-full flex flex-col relative" style={{ maxWidth: 480 }}>

        {/* ── Header (WhatsApp-style) ── */}
        <div className="flex items-center gap-2.5 px-2.5 flex-shrink-0 relative z-10"
          style={{
            paddingTop: 'max(env(safe-area-inset-top, 0px), 12px)',
            paddingBottom: 10,
            borderBottom: '1px solid var(--border-3)',
            background: 'var(--overlay-bg)',
            backdropFilter: 'blur(20px)',
          }}>

          <button onClick={() => navigate(-1)} aria-label="Back"
            className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 transition-all active:scale-90">
            <ArrowLeft className="w-5 h-5" style={{ color: '#F59E0B' }} />
          </button>

          {/* MOTOBOT avatar */}
          <div className="relative flex-shrink-0">
            <div className="w-9 h-9 rounded-full flex items-center justify-center overflow-hidden"
              style={{ background: 'linear-gradient(135deg, #F8B62B, #D97706)', boxShadow: '0 2px 8px rgba(245,158,11,0.4)' }}>
              <MotobotFace size={32} />
            </div>
            <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full"
              style={{ background: '#34D399', border: '2px solid var(--overlay-bg)' }} />
          </div>

          <div className="flex-1 min-w-0">
            <p className="font-bold text-[15px] leading-tight truncate" style={{ color: 'var(--text-hi)' }}>MOTOBOT</p>
            <p className="text-[11px] leading-tight truncate" style={{ color: '#34D399' }}>
              online <span style={{ color: 'var(--text-dim)' }}>· vehicle help only</span>
            </p>
          </div>

          <button onClick={newChat} title="New chat" aria-label="New chat"
            className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 transition-all active:scale-90">
            <Plus className="w-5 h-5" style={{ color: 'var(--text-md)' }} />
          </button>
          <button onClick={openHistory} title="Chat history" aria-label="Chat history"
            className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 transition-all active:scale-90">
            <History className="w-5 h-5" style={{ color: 'var(--text-md)' }} />
          </button>
        </div>

        {/* ── Messages (WhatsApp-style on an amber-dotted wallpaper) ── */}
        <div className="flex-1 overflow-y-auto px-3 py-4 space-y-1.5"
          style={{
            scrollbarWidth: 'none',
            backgroundColor: 'var(--page-bg)',
            backgroundImage: 'radial-gradient(rgba(245,158,11,0.06) 1px, transparent 1px)',
            backgroundSize: '22px 22px',
          }}>
          {messages.map((msg, i) => {
            const isUser = msg.role === 'user';
            const showText = msg.content && !(msg.imageUrl && msg.content === '📷 Photo');
            const time = msg.ts ? new Date(msg.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
            return (
              <div key={i} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
                style={{ animation: 'msg-in 0.2s ease both' }}>
                <div className={`wa-bubble ${isUser ? 'wa-out' : 'wa-in'}`}>
                  {msg.imageUrl && (
                    <img src={msg.imageUrl} alt="uploaded"
                      style={{ width: '100%', maxHeight: 240, objectFit: 'cover', display: 'block', borderRadius: 9, marginBottom: showText ? 6 : 0 }} />
                  )}
                  {showText && (
                    <div className="text-sm leading-relaxed"
                      style={{ whiteSpace: isUser ? 'pre-wrap' : 'normal', fontWeight: isUser ? 600 : 400 }}>
                      {isUser
                        ? (msg.imageUrl ? msg.content.replace('📷 Photo — ', '') : msg.content)
                        : renderRich(msg.content)}
                    </div>
                  )}
                  {time && (
                    <div style={{ fontSize: 10, lineHeight: 1, textAlign: 'right', marginTop: 4, opacity: 0.65, color: isUser ? 'rgba(0,0,0,0.6)' : 'var(--text-dim)' }}>
                      {time}
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* Typing indicator */}
          {sending && (
            <div className="flex justify-start" style={{ animation: 'msg-in 0.2s ease both' }}>
              <div className="wa-bubble wa-in flex items-center gap-1.5" style={{ paddingTop: 9, paddingBottom: 9 }}>
                {[0, 1, 2].map(j => (
                  <div key={j} className="w-1.5 h-1.5 rounded-full"
                    style={{ background: '#F59E0B', animation: `bounce 1s ease-in-out ${j * 0.15}s infinite` }} />
                ))}
              </div>
            </div>
          )}

          {/* ── Diagnosis result card ── */}
          {diagnosis && (
            <div className="rounded-2xl overflow-hidden mt-2"
              style={{
                border: `1.5px solid ${SEVERITY_COLOR[diagnosis.severity]}50`,
                background: 'var(--surface-1)',
                boxShadow: `0 0 24px ${SEVERITY_COLOR[diagnosis.severity]}15`,
                animation: 'msg-in 0.3s ease both',
              }}>
              {/* Severity header */}
              <div className="px-3.5 py-2.5 flex items-center gap-2"
                style={{ background: SEVERITY_BG[diagnosis.severity] }}>
                <AlertTriangle className="w-4 h-4 flex-shrink-0"
                  style={{ color: SEVERITY_COLOR[diagnosis.severity] }} />
                <span className="text-sm font-black tracking-tight"
                  style={{ color: SEVERITY_COLOR[diagnosis.severity] }}>
                  {diagnosis.severity.toUpperCase()}
                </span>
                <span className="text-xs font-semibold" style={{ color: 'var(--text-md)' }}>
                  · {diagnosis.fault_category.replace(/_/g, ' ')}
                </span>
                <span className="ml-auto text-[11px] font-bold px-2 py-0.5 rounded-full"
                  style={{ background: 'var(--surface-4)', color: 'var(--text-lo)' }}>
                  {Math.round(diagnosis.confidence * 100)}% confident
                </span>
              </div>

              <div className="px-3.5 py-3 space-y-2.5">
                <p className="text-sm" style={{ color: 'var(--text-md)' }}>
                  {diagnosis.fault_description}
                </p>

                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest mb-1.5"
                    style={{ color: 'rgba(245,158,11,0.6)' }}>Recommended actions</p>
                  <ul className="space-y-1">
                    {diagnosis.recommended_actions.map((a, i) => (
                      <li key={i} className="flex items-start gap-2 text-xs"
                        style={{ color: 'var(--text-md)' }}>
                        <span className="mt-0.5 flex-shrink-0 font-bold" style={{ color: '#F59E0B' }}>→</span>
                        {a}
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="flex items-center justify-between gap-2 pt-1">
                  <span className="text-xs px-2.5 py-1 rounded-full font-bold"
                    style={{ background: 'rgba(245,158,11,0.12)', color: '#F59E0B', border: '1px solid rgba(245,158,11,0.25)' }}>
                    {PROVIDER_LABEL[diagnosis.provider_type]}
                  </span>
                  <button onClick={findHelp}
                    className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-black text-black transition-all active:scale-95"
                    style={{
                      background: 'linear-gradient(135deg, #F59E0B, #D97706)',
                      boxShadow: '0 0 14px rgba(245,158,11,0.4)',
                    }}>
                    Find Nearby Help <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── Guided quick-answer options ── */}
          {guidedOptions.length > 0 && !sending && (
            <div className="flex flex-wrap justify-end gap-2 pt-1" style={{ animation: 'msg-in 0.25s ease both' }}>
              {guidedOptions.map((o, idx) => (
                <button key={idx} onClick={o.onPick}
                  className="px-3.5 py-2 rounded-full text-[13px] font-semibold transition-all active:scale-95"
                  style={{ background: 'rgba(245,158,11,0.12)', border: '1.5px solid rgba(245,158,11,0.45)', color: '#F59E0B' }}>
                  {o.label}
                </button>
              ))}
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* ── Voice note preview ── */}
        {audioUrl && (
          <div className="px-3 pb-2 flex-shrink-0">
            <div className="flex items-center gap-2.5 rounded-2xl px-3 py-2.5"
              style={{ background: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.2)' }}>
              <button onClick={togglePlay}
                className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
                style={{ background: 'linear-gradient(135deg, #F59E0B, #D97706)' }}>
                {playing
                  ? <Pause className="w-3.5 h-3.5 text-black" />
                  : <Play className="w-3.5 h-3.5 text-black" />}
              </button>
              <div className="flex-1 h-1.5 rounded-full" style={{ background: 'var(--surface-5)' }}>
                <div className="h-full w-1/3 rounded-full animate-pulse" style={{ background: '#F59E0B' }} />
              </div>
              <span className="text-xs font-semibold" style={{ color: 'rgba(245,158,11,0.7)' }}>Voice note</span>
              <button onClick={() => { setAudioBlob(null); setAudioUrl(''); setPlaying(false); }}>
                <X className="w-3.5 h-3.5" style={{ color: 'var(--text-dim)' }} />
              </button>
              <audio ref={audioRef} src={audioUrl} onEnded={() => setPlaying(false)} />
            </div>
          </div>
        )}

        {/* ── Attachments preview ── */}
        {attachments.length > 0 && (
          <div className="px-3 pb-2 flex-shrink-0">
            <div className="flex gap-2 overflow-x-auto mb-2" style={{ scrollbarWidth: 'none' }}>
              {attachments.map((f, i) => (
                <div key={i} className="relative flex-shrink-0">
                  {f.type.startsWith('image/')
                    ? <img src={URL.createObjectURL(f)} alt="" className="w-14 h-14 rounded-xl object-cover"
                        style={{ border: '1.5px solid rgba(245,158,11,0.3)' }} />
                    : <div className="w-14 h-14 rounded-xl flex items-center justify-center text-xl"
                        style={{ background: 'rgba(245,158,11,0.08)', border: '1.5px solid rgba(245,158,11,0.2)' }}>
                        📎
                      </div>
                  }
                  <button onClick={() => setAttachments(a => a.filter((_, j) => j !== i))}
                    className="absolute -top-1 -right-1 w-4 h-4 rounded-full flex items-center justify-center"
                    style={{ background: '#EF4444' }}>
                    <X className="w-2.5 h-2.5 text-white" />
                  </button>
                </div>
              ))}
            </div>
            {/* Shown only when a photo is attached but no text typed yet */}
            {attachments.some(f => f.type.startsWith('image/')) && !input.trim() && (
              <div className="flex items-center justify-between rounded-xl px-3 py-2"
                style={{ background: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.18)' }}>
                <span className="text-xs" style={{ color: 'var(--text-lo)' }}>
                  Add a description, or…
                </span>
                <button
                  onClick={() => setInput("I'm not sure what's wrong — please look at my photo and tell me what you see.")}
                  className="text-xs font-bold px-2.5 py-1 rounded-lg transition-all active:scale-95"
                  style={{ background: 'rgba(245,158,11,0.15)', color: '#F59E0B', border: '1px solid rgba(245,158,11,0.3)' }}>
                  I don't know — let AI analyse
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── Input bar ── */}
        <div className="flex-shrink-0 px-3 pt-2"
          style={{
            paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 12px)',
            borderTop: '1px solid rgba(245,158,11,0.1)',
            background: 'var(--overlay-bg)',
            backdropFilter: 'blur(20px)',
          }}>

          {/* Live suggestions — appear as the driver types (search-engine style) */}
          {suggestions.length > 0 && (
            <div className="mb-2 flex flex-col gap-1.5" style={{ animation: 'msg-in 0.15s ease both' }}>
              {suggestions.map((s, i) => (
                <button key={i} onClick={() => { setInput(''); send(s); }}
                  className="flex items-center gap-2 px-3 py-2 rounded-xl text-left transition-all active:scale-[0.98]"
                  style={{ background: 'var(--surface-3)', border: '1px solid rgba(245,158,11,0.18)' }}>
                  <Search className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'rgba(245,158,11,0.7)' }} />
                  <span className="text-[13px]" style={{ color: 'var(--text-md)' }}>{s}</span>
                </button>
              ))}
            </div>
          )}

          {/* WhatsApp-style composer: rounded pill (text + camera + attach) + round mic/send */}
          <div className="flex items-end gap-2">
            {recording ? (
              <div className="flex-1 flex items-center gap-2.5 rounded-3xl px-4 py-3"
                style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.35)' }}>
                <span className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                  style={{ background: '#EF4444', animation: 'pulse-rec 1s ease-in-out infinite' }} />
                <span className="text-sm font-semibold" style={{ color: '#f87171' }}>Recording… tap the button to stop</span>
              </div>
            ) : (
              <div className="flex-1 flex items-end gap-0.5 rounded-3xl pl-4 pr-1.5"
                style={{ background: 'var(--surface-3)', border: '1.5px solid rgba(245,158,11,0.18)' }}>
                <textarea
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                  placeholder={attachments.length > 0 ? 'Add a description…' : 'Message MOTOBOT…'}
                  rows={1}
                  className="flex-1 resize-none bg-transparent py-2.5 outline-none"
                  style={{ maxHeight: 96, color: 'hsl(var(--foreground))', caretColor: '#F59E0B', fontSize: 16 }}
                />
                <button onClick={() => cameraRef.current?.click()} title="Camera"
                  className="p-2 rounded-full flex-shrink-0 transition-all active:scale-90">
                  <Camera className="w-5 h-5" style={{ color: 'var(--text-dim)' }} />
                </button>
                <button onClick={() => fileRef.current?.click()} title="Attach file"
                  className="p-2 rounded-full flex-shrink-0 transition-all active:scale-90">
                  <Paperclip className="w-5 h-5" style={{ color: 'var(--text-dim)' }} />
                </button>
              </div>
            )}

            <button
              onClick={recording ? stopRec : (canSend ? () => send() : startRec)}
              disabled={sending}
              title={recording ? 'Stop recording' : canSend ? 'Send' : 'Record a voice note'}
              className="w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0 transition-all active:scale-90 disabled:opacity-50"
              style={{
                background: recording
                  ? 'linear-gradient(135deg, #EF4444, #DC2626)'
                  : 'linear-gradient(135deg, #F59E0B, #D97706)',
                boxShadow: recording ? '0 0 16px rgba(239,68,68,0.5)' : '0 0 16px rgba(245,158,11,0.45)',
              }}>
              {sending ? <Loader2 className="w-5 h-5 text-black animate-spin" />
                : recording ? <MicOff className="w-5 h-5 text-black" />
                : canSend ? <Send className="w-5 h-5 text-black" />
                : <Mic className="w-5 h-5 text-black" />}
            </button>
          </div>
        </div>

        <input ref={fileRef} type="file" multiple className="hidden" onChange={e => addFile(e.target.files)} />
        <input ref={cameraRef} type="file" accept="image/*" className="hidden" onChange={e => addFile(e.target.files)} />
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          History Drawer
         ══════════════════════════════════════════════════════════════════════ */}
      {showHistory && (
        <div className="fixed inset-0 z-[60] flex"
          style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(4px)' }}
          onClick={() => setShowHistory(false)}>

          <div className="ml-auto h-full flex flex-col"
            style={{
              width: 'min(92vw, 420px)',
              background: 'var(--surface-1)',
              borderLeft: '1px solid rgba(245,158,11,0.15)',
              boxShadow: '-20px 0 60px rgba(0,0,0,0.5)',
              animation: 'slide-in-right 0.25s ease',
            }}
            onClick={e => e.stopPropagation()}>

            {/* Drawer header */}
            <div className="flex items-center gap-3 px-4 flex-shrink-0"
              style={{
                paddingTop: 'max(env(safe-area-inset-top, 0px), 16px)',
                paddingBottom: 14,
                borderBottom: '1px solid rgba(245,158,11,0.12)',
                background: 'var(--overlay-bg)',
              }}>

              <div className="w-8 h-8 rounded-xl flex items-center justify-center"
                style={{ background: 'rgba(167,139,250,0.12)', border: '1px solid rgba(167,139,250,0.2)' }}>
                <History className="w-4 h-4" style={{ color: '#A78BFA' }} />
              </div>

              <div className="flex-1 min-w-0">
                <p className="font-black text-sm" style={{ color: '#A78BFA' }}>Chat History</p>
                <p className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
                  {historyList.length} conversation{historyList.length !== 1 ? 's' : ''}
                </p>
              </div>

              <button onClick={() => setShowHistory(false)}
                className="w-8 h-8 rounded-xl flex items-center justify-center transition-all active:scale-90"
                style={{ background: 'var(--surface-3)', border: '1px solid var(--border-3)' }}>
                <X className="w-4 h-4" style={{ color: 'var(--text-md)' }} />
              </button>
            </div>

            {/* ── Session list ── */}
            <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: 'none' }}>

              {historyList.length === 0 ? (
                  /* Empty state */
                  <div className="flex flex-col items-center justify-center h-full gap-3 px-6 text-center">
                    <div className="w-14 h-14 rounded-2xl flex items-center justify-center"
                      style={{ background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.15)' }}>
                      <MessageSquare className="w-6 h-6" style={{ color: 'rgba(167,139,250,0.5)' }} />
                    </div>
                    <p className="text-sm font-semibold" style={{ color: 'var(--text-dim)' }}>No previous chats</p>
                    <p className="text-xs" style={{ color: 'var(--text-faint)' }}>
                      Conversations are saved automatically and will appear here.
                    </p>
                  </div>
                ) : (
                  /* Session list */
                  <div className="p-3 space-y-2">
                    {historyList.map(s => (
                      <button key={s.id}
                        onClick={() => openSession(s)}
                        className="w-full flex items-start gap-3 p-3.5 rounded-2xl text-left transition-all active:scale-[0.98]"
                        style={{
                          background: 'var(--surface-1)',
                          border: '1px solid rgba(245,158,11,0.1)',
                        }}>
                        <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 mt-0.5"
                          style={{ background: 'linear-gradient(135deg, #F59E0B22, #D9770622)', border: '1px solid rgba(245,158,11,0.2)' }}>
                          <MessageSquare className="w-4 h-4" style={{ color: '#F59E0B' }} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold truncate"
                            style={{ color: 'var(--text-hi)' }}>{s.title}</p>
                          <p className="text-[11px] mt-0.5"
                            style={{ color: 'var(--text-dim)' }}>
                            {new Date(s.updatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                            {' · '}
                            {s.messages.filter(m => m.role === 'user').length} message{s.messages.filter(m => m.role === 'user').length !== 1 ? 's' : ''}
                          </p>
                          {s.diagnosis && (
                            <span className="inline-block mt-1 text-[10px] font-bold px-2 py-0.5 rounded-full"
                              style={{
                                background: `${SEVERITY_COLOR[s.diagnosis.severity]}15`,
                                color: SEVERITY_COLOR[s.diagnosis.severity],
                                border: `1px solid ${SEVERITY_COLOR[s.diagnosis.severity]}30`,
                              }}>
                              {s.diagnosis.severity.toUpperCase()} · {s.diagnosis.fault_category.replace(/_/g, ' ')}
                            </span>
                          )}
                        </div>
                        <button
                          onClick={e => deleteSession(s.id, e)}
                          className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 transition-all active:scale-90"
                          style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)' }}>
                          <Trash2 className="w-3.5 h-3.5" style={{ color: '#F87171' }} />
                        </button>
                      </button>
                    ))}
                  </div>
                )}
            </div>
          </div>
        </div>
      )}

      <style>{`
        /* WhatsApp-style bubbles (amber outgoing, dark incoming, top-corner tails) */
        .wa-bubble {
          position: relative;
          max-width: 80%;
          padding: 6px 10px 7px;
          border-radius: 12px;
          box-shadow: 0 1px 1.5px rgba(0,0,0,0.22);
          word-break: break-word;
        }
        .wa-out {
          background: linear-gradient(135deg, #F8B62B, #F59E0B);
          color: #1a1206;
          border-top-right-radius: 4px;
        }
        .wa-in {
          background: var(--surface-3);
          color: hsl(var(--foreground));
          border: 1px solid var(--border-3);
          border-top-left-radius: 4px;
        }
        .wa-out::after {
          content: ''; position: absolute; top: 0; right: -7px;
          border: 7px solid transparent; border-top-color: #F8B62B; border-right: 0;
        }
        .wa-in::after {
          content: ''; position: absolute; top: -1px; left: -7px;
          border: 7px solid transparent; border-top-color: var(--surface-3); border-left: 0;
        }
        .wa-in strong { color: #F59E0B; }
        @keyframes bounce {
          0%,80%,100% { transform: translateY(0); }
          40%          { transform: translateY(-5px); }
        }
        @keyframes msg-in {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes pulse-rec {
          0%,100% { opacity: 1; }
          50%      { opacity: 0.6; }
        }
        @keyframes slide-in-right {
          from { transform: translateX(100%); opacity: 0; }
          to   { transform: translateX(0);    opacity: 1; }
        }
      `}</style>
    </div>
  );
}
