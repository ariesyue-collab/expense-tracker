import { useState, useRef, useCallback } from "react"
const PDFJS_VERSION = "3.11.174"
const PDFJS_CDN = `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/build`

async function getPdfJs(): Promise<any> {
  if ((window as any).pdfjsLib) return (window as any).pdfjsLib
  await new Promise<void>((resolve, reject) => {
    const s = document.createElement("script")
    s.src = `${PDFJS_CDN}/pdf.min.js`
    s.onload = () => resolve()
    s.onerror = () => reject(new Error("Failed to load PDF.js from CDN"))
    document.head.appendChild(s)
  })
  const lib = (window as any).pdfjsLib
  lib.GlobalWorkerOptions.workerSrc = `${PDFJS_CDN}/pdf.worker.min.js`
  return lib
}

// ─── Types ────────────────────────────────────────────────────────────────────

type CardSource = "main" | "sub"
type Assignment = "main" | "sub" | "split" | "skip" | "unassigned"
type AppView = "landing" | "upload" | "app"
type AppTab = "cc" | "manual" | "summary"

interface Transaction {
  id: string
  date: string
  description: string
  amount: number
  cardSource: CardSource
  assignment: Assignment
}

interface ManualExpense {
  id: string
  date: string
  description: string
  amount: number
  paidBy: "main" | "sub"
  assignment: Assignment
}

interface Contribution {
  id: string
  date: string
  description: string
  amount: number
  paidBy: "main" | "sub"
}

interface Settings {
  mainName: string
  subName: string
  month: string
}

// ─── PDF Parser ───────────────────────────────────────────────────────────────

interface RawTextItem {
  str: string
  x: number
  y: number
  w: number   // glyph width — needed for word-gap detection
  page: number
}

// Citibank section header: "CARD PRODUCT NNNN NNNN NNNN NNNN - CARDHOLDER NAME"
// e.g. "CITI PREMIERMILES WORLD MASTER 5425 5033 0148 5032 - LEE DELIANG"
const CITI_SECTION_RE = /\d{4}\s+\d{4}\s+\d{4}\s+\d{4}\s+-\s+([A-Z][A-Z\s]+)$/

// Generic supplementary / principal keywords for other banks (DBS, OCBC, UOB, HSBC…)
const GENERIC_SUB_RE = /supplementary\s+card(?:\s*holder)?|add[\s-]?on\s+card|additional\s+card/i
const GENERIC_MAIN_RE = /principal\s+card(?:\s*holder)?|basic\s+card|primary\s+card(?:\s*holder)?/i

// Transaction date: "31 JUL", "04 AUG", "01 SEP" — Citibank uses DD MMM only
const TX_DATE_RE = /^(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:\s+\d{2,4})?|\d{1,2}\/\d{2}(?:\/\d{2,4})?)/i

// Rows we must always skip regardless of content
const ALWAYS_SKIP_RE = /sub[\s-]?total|grand\s+total|minimum\s+pay|payment\s+due|credit\s+limit|available\s+credit|previous\s+balance|opening\s+balance|closing\s+balance|balance\s+b\/f|balance\s+c\/f|brought\s+forward|carried\s+forward|statement\s+date|retail\s+interest|cash\s+interest|reward|miles\s+summary|transactions\s+for|all\s+transactions\s+billed/i

// Rows that look like transaction dates but are actually payments to skip
const PAYMENT_DESC_RE = /inbound\s+ft\s+pymt|payment\s+received|balance\s+transfer|autopay|auto[\s-]?pay/i

async function parsePDF(file: File): Promise<{
  transactions: Transaction[]
  pageCount: number
  mainCount: number
  subCount: number
  sectionSwitches: string[]
  detectedNames: { main?: string; sub?: string }
  debugRows: string[]
}> {
  const pdfjsLib = await getPdfJs()
  const arrayBuffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise

  // 1. Extract every text token with XY position and glyph width
  const rawItems: RawTextItem[] = []
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum)
    const vp = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()
    for (const item of content.items as any[]) {
      const s: string = item.str ?? ""
      if (!s.trim()) continue
      const x = item.transform[4]
      // Citibank A4: content lives between x≈40 and x≈565.
      // Anything beyond 565 is vertical margin text ("0000001901401264", etc.)
      // that leaks into transaction rows — discard it.
      if (x > 565) continue
      rawItems.push({
        str: s,
        x,
        y: vp.height - item.transform[5], // flip Y: 0 = top
        w: item.width ?? 0,
        page: pageNum,
      })
    }
  }

  // 2. Sort by page → y → x; group items within 6 px vertically into one row
  rawItems.sort((a, b) =>
    a.page !== b.page ? a.page - b.page : a.y !== b.y ? a.y - b.y : a.x - b.x
  )

  const ROW_GAP = 6
  const rowGroups: RawTextItem[][] = []
  let cur: RawTextItem[] = []
  let curY = -Infinity
  let curPage = -1

  for (const item of rawItems) {
    if (item.page !== curPage || item.y - curY > ROW_GAP) {
      if (cur.length) rowGroups.push(cur)
      cur = [item]; curY = item.y; curPage = item.page
    } else {
      cur.push(item)
    }
  }
  if (cur.length) rowGroups.push(cur)

  // 3. Sort each row left→right; join using GLYPH WIDTH to detect word gaps.
  //    gap = next.x − (prev.x + prev.w)
  //    gap < 2 px → same word (no space); gap ≥ 2 px → word boundary (space).
  //    This collapses individually-positioned glyphs ("3","1","J","U","L")
  //    back into words ("31 JUL") instead of the naive "3 1 J U L".
  function joinRow(items: RawTextItem[]): string {
    const sorted = [...items].sort((a, b) => a.x - b.x)
    let result = sorted[0].str
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i].x - (sorted[i - 1].x + sorted[i - 1].w)
      result += gap >= 2 ? " " + sorted[i].str : sorted[i].str
    }
    return result.replace(/\s{2,}/g, " ").trim()
  }

  const rows = rowGroups.map((items) => ({ text: joinRow(items) }))

  // 4. Scan rows top-to-bottom, track active cardholder section
  const transactions: Transaction[] = []
  let cardSource: CardSource = "main"
  const sectionSwitches: string[] = []
  const detectedNames: { main?: string; sub?: string } = {}
  let citiSectionsFound = 0

  for (const { text: t } of rows) {
    // ── Skip masked card-number continuation lines (XXXX-XXXX-XXXX-1250) ──
    if (/^[Xx]{4}[-\s][Xx]{4}[-\s][Xx]{4}[-\s]\d{4}$/.test(t)) continue

    // ── Citibank section headers ───────────────────────────────────────────
    // Pattern: "... NNNN NNNN NNNN NNNN - CARDHOLDER NAME"
    const citiMatch = t.match(CITI_SECTION_RE)
    if (citiMatch) {
      citiSectionsFound++
      const name = citiMatch[1].trim()
      if (citiSectionsFound === 1) {
        cardSource = "main"
        detectedNames.main = name
      } else {
        cardSource = "sub"
        if (!detectedNames.sub) detectedNames.sub = name
      }
      sectionSwitches.push(
        `→ ${citiSectionsFound === 1 ? "Main" : "Supplementary"} card: ${name}`
      )
      continue
    }

    // ── Generic bank section headers (DBS, OCBC, UOB, HSBC, SCB…) ────────
    if (GENERIC_SUB_RE.test(t)) {
      cardSource = "sub"
      sectionSwitches.push(`→ Supplementary card section: "${t.slice(0, 70)}"`)
      continue
    }
    if (GENERIC_MAIN_RE.test(t)) {
      cardSource = "main"
      sectionSwitches.push(`→ Main card section: "${t.slice(0, 70)}"`)
      continue
    }

    // ── Skip obviously non-transaction rows ───────────────────────────────
    if (ALWAYS_SKIP_RE.test(t)) continue

    // ── Transaction rows must start with a date ───────────────────────────
    const dateMatch = t.match(TX_DATE_RE)
    if (!dateMatch) continue

    // Citibank credits are shown as (amount) — skip refunds
    if (/\(\s*[\d,]+\.\d{2}\s*\)\s*$/.test(t)) continue

    // Amount must be the last token: a bare decimal number
    const amtMatch = t.match(/([\d,]+\.\d{2})\s*$/)
    if (!amtMatch) continue

    const amount = parseFloat(amtMatch[1].replace(/,/g, ""))
    if (isNaN(amount) || amount <= 0 || amount > 99_999) continue

    // Description: everything between date end and amount
    const raw = t
      .slice(dateMatch[0].length)          // strip leading date
      .replace(/([\d,]+\.\d{2})\s*$/, "")  // strip trailing amount
      .trim()

    // Clean Citibank merchant-name noise:
    // "SUBWAY - OASIS TERRACE  SINGAPORE  SG" → "SUBWAY - OASIS TERRACE"
    const desc = raw
      .replace(/\s+SINGAPORE\s+SG\s*$/i, "")
      .replace(/\s+Singapore\s+SG\s*$/i, "")
      .replace(/\s+N\/A\s+SG\s*$/i, "")
      .replace(/\s+SG\s*$/, "")
      .replace(/\s{2,}/g, " ")
      .trim()

    if (desc.length < 2) continue

    // Skip payment/reversal rows even if they have a date
    if (PAYMENT_DESC_RE.test(desc)) continue

    transactions.push({
      id: crypto.randomUUID(),
      date: dateMatch[0].trim(),
      description: desc,
      amount,
      cardSource,
      assignment: "unassigned",
    })
  }

  const mainCount = transactions.filter((t) => t.cardSource === "main").length
  const subCount = transactions.filter((t) => t.cardSource === "sub").length
  const debugRows = rows.slice(0, 60).map((r) => r.text).filter(Boolean)

  return { transactions, pageCount: pdf.numPages, mainCount, subCount, sectionSwitches, detectedNames, debugRows }
}

// ─── Sample Data ──────────────────────────────────────────────────────────────

const SAMPLE: Transaction[] = [
  { id: "s1", date: "01 Sep", description: "NTUC FAIRPRICE ONLINE", amount: 87.50, cardSource: "main", assignment: "unassigned" },
  { id: "s2", date: "02 Sep", description: "GRAB FOOD DELIVERY", amount: 23.80, cardSource: "main", assignment: "unassigned" },
  { id: "s3", date: "03 Sep", description: "SHELL PETROL STATION", amount: 110.00, cardSource: "main", assignment: "unassigned" },
  { id: "s4", date: "05 Sep", description: "NETFLIX SUBSCRIPTION", amount: 18.98, cardSource: "main", assignment: "unassigned" },
  { id: "s5", date: "07 Sep", description: "COLD STORAGE SUPERMART", amount: 64.30, cardSource: "main", assignment: "unassigned" },
  { id: "s6", date: "10 Sep", description: "GUARDIAN PHARMACY", amount: 35.60, cardSource: "sub", assignment: "unassigned" },
  { id: "s7", date: "12 Sep", description: "UNIQLO SINGAPORE", amount: 89.90, cardSource: "sub", assignment: "unassigned" },
  { id: "s8", date: "14 Sep", description: "KOPITIAM FOOD COURT", amount: 12.50, cardSource: "sub", assignment: "unassigned" },
  { id: "s9", date: "18 Sep", description: "LAZADA MARKETPLACE", amount: 156.00, cardSource: "sub", assignment: "unassigned" },
  { id: "s10", date: "22 Sep", description: "PARKWAY PARADE DINING", amount: 78.40, cardSource: "sub", assignment: "unassigned" },
]

// ─── Settlement calc ──────────────────────────────────────────────────────────

function calcSettlement(txs: Transaction[], manual: ManualExpense[], contributions: Contribution[] = []) {
  let subOwesMain = 0
  let splitTotal = 0
  for (const t of txs) {
    if (t.assignment === "sub") subOwesMain += t.amount
    else if (t.assignment === "split") splitTotal += t.amount
  }
  let net = subOwesMain + splitTotal / 2
  for (const e of manual) {
    const amt = e.amount || 0
    if (e.assignment === "split") {
      net += e.paidBy === "main" ? amt / 2 : -(amt / 2)
    } else if (e.assignment === "sub" && e.paidBy === "main") {
      net += amt
    } else if (e.assignment === "main" && e.paidBy === "sub") {
      net -= amt
    }
  }
  // Contributions directly reduce what the contributor owes
  for (const c of contributions) {
    const amt = c.amount || 0
    if (c.paidBy === "sub") net -= amt   // sub already paid → owes less
    else net += amt                       // main already paid on sub's behalf → sub owes more
  }
  return { net, splitTotal, subOwesMain }
}

// ─── Icons ───────────────────────────────────────────────────────────────────

function IconUpload() {
  return (
    <svg width="20" height="20" fill="none" viewBox="0 0 20 20">
      <path d="M10 3v10M6 7l4-4 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 15v1a2 2 0 002 2h10a2 2 0 002-2v-1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function IconSplit() {
  return (
    <svg width="20" height="20" fill="none" viewBox="0 0 20 20">
      <path d="M4 10h12M10 4l6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function IconCheck() {
  return (
    <svg width="16" height="16" fill="none" viewBox="0 0 16 16">
      <path d="M3 8l3.5 3.5L13 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function IconExport() {
  return (
    <svg width="16" height="16" fill="none" viewBox="0 0 16 16">
      <path d="M8 2v9M5 8l3 3 3-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2 13h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

// ─── Product Screenshot Mockup (hero UI) ─────────────────────────────────────

function ProductMockup() {
  return (
    <div className="w-full max-w-2xl mx-auto rounded-2xl overflow-hidden border border-[#E5E3F0] bg-white"
      style={{ boxShadow: "0 32px 80px 0 rgba(79,70,229,0.12), 0 8px 32px 0 rgba(31,32,51,0.08)" }}>
      {/* Mock browser bar */}
      <div className="flex items-center gap-2 px-4 py-3 bg-[#F7F6FB] border-b border-[#E5E3F0]">
        <div className="flex gap-1.5">
          <div className="w-3 h-3 rounded-full bg-[#E5E3F0]" />
          <div className="w-3 h-3 rounded-full bg-[#E5E3F0]" />
          <div className="w-3 h-3 rounded-full bg-[#E5E3F0]" />
        </div>
        <div className="flex-1 mx-3 rounded-full bg-white border border-[#E5E3F0] px-3 py-1 text-xs text-[#9CA3AF] text-center">
          splitbill.app
        </div>
        <div className="w-6 h-6 rounded-full bg-[#4F46E5] flex items-center justify-center">
          <span className="text-white text-[8px] font-bold">SB</span>
        </div>
      </div>
      {/* Mock app content */}
      <div className="p-5 space-y-3 bg-[#F7F6FB]">
        {/* Header row */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-[#1F2033]">September 2026</p>
            <p className="text-xs text-[#6B7280]">Husband & Wife · 10 transactions</p>
          </div>
          <div className="flex gap-2">
            <div className="h-7 px-3 rounded-full bg-[#4F46E5] text-white text-xs font-medium flex items-center">Export</div>
          </div>
        </div>
        {/* Tabs */}
        <div className="flex gap-1 bg-white rounded-xl p-1 border border-[#E5E3F0]">
          {["Credit Card", "Other Expenses", "Summary"].map((t, i) => (
            <div key={t} className={`flex-1 text-center py-1.5 rounded-lg text-xs font-medium ${i === 0 ? "bg-[#4F46E5] text-white" : "text-[#6B7280]"}`}>{t}</div>
          ))}
        </div>
        {/* Transaction rows */}
        {[
          { date: "01 Sep", desc: "NTUC FAIRPRICE ONLINE", amt: "87.50", tag: "Split", tagColor: "bg-amber-100 text-amber-700" },
          { date: "03 Sep", desc: "SHELL PETROL STATION", amt: "110.00", tag: "Husband", tagColor: "bg-indigo-100 text-indigo-700" },
          { date: "07 Sep", desc: "COLD STORAGE SUPERMART", amt: "64.30", tag: "Split", tagColor: "bg-amber-100 text-amber-700" },
          { date: "12 Sep", desc: "UNIQLO SINGAPORE", amt: "89.90", tag: "Wife", tagColor: "bg-purple-100 text-purple-700" },
          { date: "18 Sep", desc: "LAZADA MARKETPLACE", amt: "156.00", tag: "Wife", tagColor: "bg-purple-100 text-purple-700" },
        ].map((row) => (
          <div key={row.desc} className="flex items-center gap-3 bg-white rounded-xl px-4 py-3 border border-[#E5E3F0]">
            <div className="w-8 h-8 rounded-lg bg-[#EEF2FF] flex items-center justify-center shrink-0">
              <div className="w-3 h-3 rounded-sm bg-[#4F46E5] opacity-60" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-[#1F2033] truncate">{row.desc}</p>
              <p className="text-[10px] text-[#9CA3AF]">{row.date}</p>
            </div>
            <span className="font-mono text-xs font-semibold text-[#1F2033]">${row.amt}</span>
            <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${row.tagColor}`}>{row.tag}</span>
          </div>
        ))}
        {/* Settlement card */}
        <div className="bg-[#4F46E5] rounded-xl px-4 py-3 flex items-center justify-between">
          <div>
            <p className="text-xs text-indigo-200 font-medium">Settlement</p>
            <p className="text-xs text-indigo-300 mt-0.5">Wife pays Husband</p>
          </div>
          <p className="text-2xl font-bold text-white font-mono">$284.35</p>
        </div>
      </div>
    </div>
  )
}

// ─── Landing Page ─────────────────────────────────────────────────────────────

function LandingPage({ onGetStarted }: { onGetStarted: () => void }) {
  const logos = ["DBS", "OCBC", "UOB", "Citibank", "HSBC", "Standard Chartered"]
  const features = [
    {
      icon: (
        <svg width="24" height="24" fill="none" viewBox="0 0 24 24">
          <rect x="3" y="5" width="18" height="14" rx="3" stroke="#4F46E5" strokeWidth="1.8" />
          <path d="M3 9h18" stroke="#4F46E5" strokeWidth="1.8" />
          <path d="M7 14h4M15 14h2" stroke="#4F46E5" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      ),
      title: "PDF Statement Upload",
      desc: "Drop in your monthly credit card PDF. We automatically parse every line item from both main and supplementary cards.",
    },
    {
      icon: (
        <svg width="24" height="24" fill="none" viewBox="0 0 24 24">
          <circle cx="8" cy="12" r="3" stroke="#4F46E5" strokeWidth="1.8" />
          <circle cx="16" cy="12" r="3" stroke="#4F46E5" strokeWidth="1.8" />
          <path d="M11 12h2" stroke="#4F46E5" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      ),
      title: "One-click Assignment",
      desc: "Tag each expense as yours, your spouse's, or split 50/50. Bulk-assign a whole card section in seconds.",
    },
    {
      icon: (
        <svg width="24" height="24" fill="none" viewBox="0 0 24 24">
          <path d="M12 3v18M3 12h18" stroke="#4F46E5" strokeWidth="1.8" strokeLinecap="round" />
          <rect x="7" y="7" width="10" height="10" rx="2" stroke="#4F46E5" strokeWidth="1.8" />
        </svg>
      ),
      title: "Non-CC Consolidation",
      desc: "Add PayNow transfers, tuition fees, and online orders. Everything rolls up into one clean settlement number.",
    },
  ]

  return (
    <div className="min-h-screen bg-white font-sans">
      {/* Nav */}
      <nav className="sticky top-0 z-50 bg-white/80 backdrop-blur-md border-b border-[#E5E3F0]">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-[#4F46E5] flex items-center justify-center">
              <span className="text-white text-[11px] font-bold tracking-tight">SB</span>
            </div>
            <span className="text-sm font-semibold text-[#1F2033]">SplitBill</span>
          </div>
          <button
            onClick={onGetStarted}
            className="h-9 px-5 rounded-full bg-[#4F46E5] text-white text-sm font-semibold hover:bg-[#4338CA] transition-colors cursor-pointer"
          >
            Get started free
          </button>
        </div>
      </nav>

      {/* Hero */}
      <section className="bg-white pt-20 pb-16 px-6 text-center">
        <div className="max-w-3xl mx-auto">
          <div className="inline-flex items-center gap-2 bg-[#EEF2FF] text-[#4F46E5] text-xs font-semibold px-4 py-1.5 rounded-full mb-8">
            <span className="w-1.5 h-1.5 rounded-full bg-[#4F46E5]" />
            Built for Singapore households
          </div>
          <h1 className="text-5xl font-black text-[#1F2033] leading-[1.1] tracking-tight mb-6">
            Stop the monthly<br />
            <span className="text-[#4F46E5]">bill-splitting headache.</span>
          </h1>
          <p className="text-lg text-[#6B7280] leading-relaxed max-w-xl mx-auto mb-10">
            Upload your credit card statement, assign expenses to each cardholder,
            split shared costs 50/50, and get one exact settlement figure — in minutes.
          </p>
          <div className="flex items-center justify-center gap-3 flex-wrap">
            <button
              onClick={onGetStarted}
              className="h-12 px-8 rounded-full bg-[#4F46E5] text-white text-base font-semibold hover:bg-[#4338CA] transition-colors cursor-pointer shadow-lg shadow-indigo-200"
            >
              Start splitting →
            </button>
            <button
              onClick={onGetStarted}
              className="h-12 px-8 rounded-full bg-[#F7F6FB] text-[#1F2033] text-base font-semibold hover:bg-[#EEEDF7] transition-colors cursor-pointer border border-[#E5E3F0]"
            >
              Try sample data
            </button>
          </div>
        </div>

        {/* Hero product screenshot */}
        <div className="max-w-2xl mx-auto mt-16">
          <ProductMockup />
        </div>
      </section>

      {/* Logo row */}
      <section className="bg-[#F7F6FB] border-y border-[#E5E3F0] py-10 px-6">
        <p className="text-center text-xs font-semibold text-[#9CA3AF] uppercase tracking-widest mb-8">
          Works with statements from
        </p>
        <div className="flex items-center justify-center gap-8 flex-wrap">
          {logos.map((logo) => (
            <span key={logo} className="text-sm font-bold text-[#C4C4D0] tracking-tight select-none">
              {logo}
            </span>
          ))}
        </div>
      </section>

      {/* Three-up features */}
      <section className="bg-white py-20 px-6">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-14">
            <h2 className="text-3xl font-black text-[#1F2033] tracking-tight mb-4">
              Everything you need, nothing you don't.
            </h2>
            <p className="text-[#6B7280] max-w-md mx-auto">
              A purpose-built tool for couples who share a credit card account and want a fair monthly split.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {features.map((f) => (
              <div key={f.title} className="bg-[#F7F6FB] rounded-2xl p-8 flex flex-col gap-4">
                <div className="w-12 h-12 rounded-xl bg-[#EEF2FF] flex items-center justify-center">
                  {f.icon}
                </div>
                <h3 className="text-base font-bold text-[#1F2033]">{f.title}</h3>
                <p className="text-sm text-[#6B7280] leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Alt section – how it works */}
      <section className="bg-[#F7F6FB] py-20 px-6">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-3xl font-black text-[#1F2033] tracking-tight mb-14">How it works</h2>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
            {[
              { n: "1", title: "Upload PDF", desc: "Drop your monthly credit card statement PDF." },
              { n: "2", title: "Assign items", desc: "Tag each charge: yours, theirs, or split." },
              { n: "3", title: "Add extras", desc: "Include PayNow, tuition, and other costs." },
              { n: "4", title: "Settle up", desc: "One number. Transfer done." },
            ].map((step) => (
              <div key={step.n} className="flex flex-col items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-[#4F46E5] text-white font-bold text-sm flex items-center justify-center">
                  {step.n}
                </div>
                <h4 className="font-bold text-[#1F2033] text-sm">{step.title}</h4>
                <p className="text-xs text-[#6B7280] leading-relaxed">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA banner */}
      <section className="bg-[#4F46E5] py-20 px-6 text-center">
        <div className="max-w-2xl mx-auto">
          <h2 className="text-3xl font-black text-white tracking-tight mb-4">
            Ready to end the spreadsheet?
          </h2>
          <p className="text-indigo-200 mb-8 leading-relaxed">
            No sign-up. No subscription. Just upload your bill and get your settlement figure.
          </p>
          <button
            onClick={onGetStarted}
            className="h-12 px-8 rounded-full bg-white text-[#4F46E5] text-base font-bold hover:bg-[#F7F6FB] transition-colors cursor-pointer shadow-xl shadow-indigo-900/30"
          >
            Open SplitBill →
          </button>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-white border-t border-[#E5E3F0] py-8 px-6 text-center">
        <p className="text-xs text-[#9CA3AF]">
          © 2026 SplitBill · Your PDF is processed locally and never uploaded to any server.
        </p>
      </footer>
    </div>
  )
}

function DebugRows(rows: string[]) {
  return (
    <div className="mt-4 space-y-3">
      <div className="bg-[#FFF1F2] border border-[#FCA5A5] rounded-xl px-4 py-3 text-sm text-[#991B1B]">
        No transactions detected. Raw text extracted from PDF shown below — share this with support.
      </div>
      <div className="bg-[#1F2033] rounded-xl p-3 max-h-64 overflow-auto">
        {rows.map((row, i) => (
          <p key={i} className="font-mono text-[10px] text-green-300 leading-5 whitespace-pre">{row}</p>
        ))}
      </div>
    </div>
  )
}

// ─── Upload Screen ────────────────────────────────────────────────────────────

function UploadScreen({
  onLoad,
  onUseSample,
}: {
  onLoad: (txs: Transaction[], names?: { main?: string; sub?: string }) => void
  onUseSample: () => void
}) {
  const [dragging, setDragging] = useState(false)
  const [parsing, setParsing] = useState(false)
  const [error, setError] = useState("")
  const [preview, setPreview] = useState<{
    transactions: Transaction[]
    pageCount: number
    mainCount: number
    subCount: number
    sectionSwitches: string[]
    detectedNames: { main?: string; sub?: string }
    debugRows: string[]
    fileName: string
  } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFile = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".pdf")) { setError("Please upload a PDF file."); return }
    setParsing(true); setError(""); setPreview(null)
    try {
      const result = await parsePDF(file)
      if (result.transactions.length === 0) {
        setPreview({ ...result, fileName: file.name, detectedNames: result.detectedNames, debugRows: result.debugRows })
        setError("no-transactions")
      } else {
        setPreview({ ...result, fileName: file.name, detectedNames: result.detectedNames, debugRows: result.debugRows })
      }
    } catch (e: any) {
      setError("Failed to read PDF: " + (e?.message ?? "unknown error"))
    } finally {
      setParsing(false)
    }
  }, [])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false)
    const f = e.dataTransfer.files[0]; if (f) handleFile(f)
  }, [handleFile])

  // Preview state: let user review before confirming
  if (preview) {
    return (
      <div className="min-h-screen bg-[#F7F6FB] flex flex-col items-center justify-center px-6 py-12">
        <div className="w-full max-w-2xl">
          <div className="text-center mb-8">
            <div className="w-12 h-12 rounded-xl bg-[#4F46E5] flex items-center justify-center mx-auto mb-4">
              <span className="text-white text-base font-bold">SB</span>
            </div>
            <h2 className="text-xl font-black text-[#1F2033] mb-1">Review parsed transactions</h2>
            <p className="text-sm text-[#6B7280]">{preview.fileName} · {preview.pageCount} page{preview.pageCount !== 1 ? "s" : ""}</p>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-3 mb-6">
            <div className="bg-white rounded-xl border border-[#E5E3F0] px-4 py-4 text-center">
              <p className="font-mono text-2xl font-black text-[#1F2033]">{preview.transactions.length}</p>
              <p className="text-xs text-[#6B7280] mt-1 font-medium">Transactions found</p>
            </div>
            <div className="bg-[#EEF2FF] rounded-xl border border-[#C7D2FE] px-4 py-4 text-center">
              <p className="font-mono text-2xl font-black text-[#312E81]">{preview.mainCount}</p>
              <p className="text-xs text-[#4F46E5] mt-1 font-medium">Main card charges</p>
            </div>
            <div className="bg-[#F5F3FF] rounded-xl border border-[#DDD6FE] px-4 py-4 text-center">
              <p className="font-mono text-2xl font-black text-[#7C3AED]">{preview.subCount}</p>
              <p className="text-xs text-[#7C3AED] mt-1 font-medium">Supplementary card charges</p>
            </div>
          </div>

          {/* Section switch log */}
          {preview.sectionSwitches.length > 0 && (
            <div className="bg-white border border-[#E5E3F0] rounded-xl px-4 py-3 mb-4">
              <p className="text-xs font-bold text-[#6B7280] uppercase tracking-widest mb-2">Card sections detected</p>
              {preview.sectionSwitches.map((s, i) => (
                <p key={i} className="text-xs font-mono text-[#4F46E5] leading-5 truncate">{s}</p>
              ))}
            </div>
          )}

          {/* Detected cardholder names */}
          {(preview.detectedNames.main || preview.detectedNames.sub) && (
            <div className="bg-[#EEF2FF] border border-[#C7D2FE] rounded-xl px-4 py-3 mb-4">
              <p className="text-xs font-bold text-[#4F46E5] mb-2">Cardholders detected from statement</p>
              <div className="flex gap-4">
                {preview.detectedNames.main && (
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] bg-[#4F46E5] text-white px-2 py-0.5 rounded-full font-bold">Main</span>
                    <span className="text-xs font-semibold text-[#1F2033]">{preview.detectedNames.main}</span>
                  </div>
                )}
                {preview.detectedNames.sub && (
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] bg-[#7C3AED] text-white px-2 py-0.5 rounded-full font-bold">Supp.</span>
                    <span className="text-xs font-semibold text-[#1F2033]">{preview.detectedNames.sub}</span>
                  </div>
                )}
              </div>
              <p className="text-[10px] text-[#6B7280] mt-2">These will be pre-filled as cardholder names in the app.</p>
            </div>
          )}

          {preview.subCount === 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-4">
              <p className="text-xs font-semibold text-amber-800 mb-1">Supplementary card section not detected</p>
              <p className="text-xs text-amber-700">
                All {preview.mainCount} transactions were assigned to the main card. If your statement has supplementary card charges,
                you can manually toggle the card source for each row inside the app.
              </p>
            </div>
          )}

          {/* Transaction preview list */}
          <div className="bg-white rounded-2xl border border-[#E5E3F0] overflow-hidden mb-6 max-h-72 overflow-y-auto">
            <div className="grid px-4 py-2.5 text-[10px] font-bold uppercase tracking-widest text-[#9CA3AF] border-b border-[#F7F6FB]"
              style={{ gridTemplateColumns: "80px 1fr 80px 90px" }}>
              <span>Date</span><span>Description</span><span className="text-right">Amount</span><span className="text-center">Card</span>
            </div>
            {preview.transactions.map((tx) => (
              <div key={tx.id} className="grid items-center px-4 py-2.5 border-b border-[#F7F6FB] last:border-0"
                style={{ gridTemplateColumns: "80px 1fr 80px 90px" }}>
                <span className="font-mono text-[11px] text-[#9CA3AF]">{tx.date}</span>
                <span className="text-xs text-[#1F2033] truncate pr-2">{tx.description}</span>
                <span className="font-mono text-xs font-semibold text-[#1F2033] text-right">${tx.amount.toFixed(2)}</span>
                <div className="flex justify-center">
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${tx.cardSource === "main" ? "bg-[#EEF2FF] text-[#4F46E5]" : "bg-[#F5F3FF] text-[#7C3AED]"}`}>
                    {tx.cardSource === "main" ? "Main" : "Supp."}
                  </span>
                </div>
              </div>
            ))}
          </div>

          <p className="text-xs text-[#9CA3AF] text-center mb-5">
            You can toggle any transaction's card (Main / Supplementary) inside the app if the detection was off.
          </p>

          <div className="flex gap-3 justify-center">
            <button onClick={() => setPreview(null)}
              className="h-11 px-6 rounded-full border border-[#E5E3F0] text-[#6B7280] text-sm font-semibold hover:bg-white cursor-pointer transition-colors">
              ← Upload different file
            </button>
            <button onClick={() => onLoad(preview.transactions, preview.detectedNames)}
              className="h-11 px-8 rounded-full bg-[#4F46E5] text-white text-sm font-bold hover:bg-[#4338CA] cursor-pointer transition-colors shadow-lg shadow-indigo-200">
              Continue with {preview.transactions.length} transactions →
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#F7F6FB] flex flex-col items-center justify-center px-6 py-16">
      <div className="w-full max-w-lg">
        <div className="text-center mb-10">
          <div className="w-12 h-12 rounded-xl bg-[#4F46E5] flex items-center justify-center mx-auto mb-5">
            <span className="text-white text-base font-bold">SB</span>
          </div>
          <h1 className="text-2xl font-black text-[#1F2033] mb-2">Upload your statement</h1>
          <p className="text-[#6B7280] text-sm leading-relaxed">
            Drop your credit card PDF — transactions from both main and supplementary cards
            are automatically separated.
          </p>
        </div>

        <div
          onDrop={onDrop}
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onClick={() => inputRef.current?.click()}
          className={`border-2 border-dashed rounded-2xl px-8 py-14 text-center cursor-pointer transition-all ${
            dragging ? "border-[#4F46E5] bg-[#EEF2FF]" : "border-[#D4D2E8] bg-white hover:border-[#4F46E5] hover:bg-[#F7F6FB]"
          }`}
        >
          <input ref={inputRef} type="file" accept=".pdf" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
          {parsing ? (
            <div className="space-y-3">
              <div className="w-10 h-10 mx-auto rounded-full border-2 border-[#4F46E5] border-t-transparent animate-spin" />
              <p className="text-sm font-medium text-[#1F2033]">Reading your statement…</p>
              <p className="text-xs text-[#9CA3AF]">Reconstructing rows from PDF positions</p>
            </div>
          ) : (
            <>
              <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-[#EEF2FF] flex items-center justify-center text-[#4F46E5]">
                <IconUpload />
              </div>
              <p className="font-semibold text-[#1F2033] text-sm mb-1">Drop PDF here or click to browse</p>
              <p className="text-xs text-[#9CA3AF]">Credit card statement · text-based PDF only</p>
            </>
          )}
        </div>

        {/* Supported banks */}
        <div className="mt-5 bg-white border border-[#E5E3F0] rounded-xl px-4 py-4">
          <p className="text-[10px] font-bold text-[#9CA3AF] uppercase tracking-widest mb-2">Detects card sections for</p>
          <div className="flex flex-wrap gap-2">
            {["DBS / POSB", "OCBC", "UOB", "Citibank", "HSBC", "Standard Chartered"].map((b) => (
              <span key={b} className="text-xs bg-[#F7F6FB] border border-[#E5E3F0] px-2.5 py-1 rounded-full text-[#6B7280] font-medium">{b}</span>
            ))}
          </div>
          <p className="text-[10px] text-[#9CA3AF] mt-3 leading-relaxed">
            The parser reads PDF text positions to reconstruct table rows and detect "Principal Cardholder" / "Supplementary Cardholder" section headers. Scanned / image PDFs are not supported.
          </p>
        </div>

        {error && error !== "no-transactions" && (
          <div className="mt-4 bg-[#FFF1F2] border border-[#FCA5A5] rounded-xl px-4 py-3 text-sm text-[#991B1B]">{error}</div>
        )}
        {error === "no-transactions" && DebugRows((preview as { debugRows: string[] } | null)?.debugRows ?? [])}

        <div className="text-center mt-8">
          <p className="text-xs text-[#9CA3AF] mb-3">Don't have a PDF ready?</p>
          <button onClick={onUseSample}
            className="h-10 px-6 rounded-full border border-[#4F46E5] text-[#4F46E5] text-sm font-semibold hover:bg-[#EEF2FF] transition-colors cursor-pointer">
            Load sample data →
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Assignment pill ──────────────────────────────────────────────────────────

const ASSIGN_OPTS: { value: Assignment; label: string; active: string; idle: string }[] = [
  { value: "main", label: "Mine", active: "bg-[#312E81] text-white", idle: "border border-[#C7D2FE] text-[#312E81] hover:bg-[#EEF2FF]" },
  { value: "sub", label: "Spouse", active: "bg-[#7C3AED] text-white", idle: "border border-[#DDD6FE] text-[#7C3AED] hover:bg-[#F5F3FF]" },
  { value: "split", label: "Split ½", active: "bg-[#D97706] text-white", idle: "border border-[#FDE68A] text-[#D97706] hover:bg-[#FFFBEB]" },
  { value: "skip", label: "Skip", active: "bg-[#6B7280] text-white", idle: "border border-[#E5E7EB] text-[#9CA3AF] hover:bg-[#F9FAFB]" },
]

function AssignPills({ value, onChange }: { value: Assignment; onChange: (a: Assignment) => void }) {
  return (
    <div className="flex gap-1">
      {ASSIGN_OPTS.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)}
          className={`px-2.5 py-1 rounded-full text-xs font-semibold transition-all cursor-pointer whitespace-nowrap ${value === o.value ? o.active : o.idle}`}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ─── App Shell ────────────────────────────────────────────────────────────────

function AppShell({
  transactions, setTransactions,
  manualExpenses, setManualExpenses,
  contributions, setContributions,
  settings, setSettings,
  onBack,
}: {
  transactions: Transaction[]
  setTransactions: React.Dispatch<React.SetStateAction<Transaction[]>>
  manualExpenses: ManualExpense[]
  setManualExpenses: React.Dispatch<React.SetStateAction<ManualExpense[]>>
  contributions: Contribution[]
  setContributions: React.Dispatch<React.SetStateAction<Contribution[]>>
  settings: Settings
  setSettings: React.Dispatch<React.SetStateAction<Settings>>
  onBack: () => void
}) {
  const [tab, setTab] = useState<AppTab>("cc")
  const [cardFilter, setCardFilter] = useState<"all" | CardSource>("all")
  const [editingSettings, setEditingSettings] = useState(false)

  const unassigned = transactions.filter((t) => t.assignment === "unassigned").length
  const { net } = calcSettlement(transactions, manualExpenses, contributions)

  const updateTx = (id: string, assignment: Assignment) =>
    setTransactions((p) => p.map((t) => (t.id === id ? { ...t, assignment } : t)))

  const toggleCardSource = (id: string) =>
    setTransactions((p) =>
      p.map((t) => (t.id === id ? { ...t, cardSource: t.cardSource === "main" ? "sub" : "main" } : t))
    )

  const bulkAssign = (a: Assignment) => {
    const ids = filtered.map((t) => t.id)
    setTransactions((p) => p.map((t) => (ids.includes(t.id) ? { ...t, assignment: a } : t)))
  }

  const addManual = () => setManualExpenses((p) => [...p, {
    id: crypto.randomUUID(), date: "", description: "", amount: 0, paidBy: "sub", assignment: "sub"
  }])

  const updateManual = (id: string, u: Partial<ManualExpense>) =>
    setManualExpenses((p) => p.map((e) => (e.id === id ? { ...e, ...u } : e)))

  const deleteManual = (id: string) => setManualExpenses((p) => p.filter((e) => e.id !== id))

  const addContribution = () => setContributions((p) => [...p, {
    id: crypto.randomUUID(), date: "", description: "", amount: 0, paidBy: "sub"
  }])
  const updateContribution = (id: string, u: Partial<Contribution>) =>
    setContributions((p) => p.map((c) => (c.id === id ? { ...c, ...u } : c)))
  const deleteContribution = (id: string) => setContributions((p) => p.filter((c) => c.id !== id))

  const exportSummary = () => {
    const lines = [
      `SplitBill — ${settings.month}`,
      ``,
      `CC Transactions`,
      ...transactions.filter((t) => t.assignment !== "skip" && t.assignment !== "unassigned")
        .map((t) => `${t.date}  ${t.description}  $${t.amount.toFixed(2)}  [${t.assignment}]`),
      ``,
      `Other Expenses`,
      ...manualExpenses.map((e) => `${e.date}  ${e.description}  $${(e.amount || 0).toFixed(2)}  [paid by ${e.paidBy === "main" ? settings.mainName : settings.subName}]  [${e.assignment}]`),
      ``,
      `Contributions / Credits`,
      ...contributions.map((c) => `${c.date}  ${c.description}  $${(c.amount || 0).toFixed(2)}  [${c.paidBy === "main" ? settings.mainName : settings.subName} contributed → reduces their balance]`),
      ``,
      net >= 0
        ? `${settings.subName} pays ${settings.mainName}: $${net.toFixed(2)}`
        : `${settings.mainName} pays ${settings.subName}: $${Math.abs(net).toFixed(2)}`,
    ]
    const blob = new Blob([lines.join("\n")], { type: "text/plain" })
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob)
    a.download = `splitbill-${settings.month.replace(/\s+/g, "-")}.txt`; a.click()
  }

  const filtered = cardFilter === "all" ? transactions : transactions.filter((t) => t.cardSource === cardFilter)

  const mainTotal = transactions.filter((t) => t.assignment === "main").reduce((s, t) => s + t.amount, 0)
  const subTotal = transactions.filter((t) => t.assignment === "sub").reduce((s, t) => s + t.amount, 0)
  const splitTotal = transactions.filter((t) => t.assignment === "split").reduce((s, t) => s + t.amount, 0)
  const manualTotal = manualExpenses.reduce((s, e) => s + (e.amount || 0), 0)

  return (
    <div className="min-h-screen flex flex-col bg-[#F7F6FB]">
      {/* Top nav */}
      <header className="bg-white border-b border-[#E5E3F0] px-6 h-14 flex items-center gap-4 sticky top-0 z-40">
        <button onClick={onBack} className="flex items-center gap-2 cursor-pointer group">
          <div className="w-7 h-7 rounded-lg bg-[#4F46E5] flex items-center justify-center">
            <span className="text-white text-[11px] font-bold">SB</span>
          </div>
          <span className="text-sm font-semibold text-[#1F2033] group-hover:text-[#4F46E5] transition-colors">SplitBill</span>
        </button>

        <div className="h-5 w-px bg-[#E5E3F0]" />

        {editingSettings ? (
          <div className="flex items-center gap-2">
            <input value={settings.mainName} onChange={(e) => setSettings((s) => ({ ...s, mainName: e.target.value }))}
              className="border border-[#E5E3F0] rounded-lg px-2 py-1 text-xs w-24 focus:outline-none focus:border-[#4F46E5]" placeholder="Main name" />
            <span className="text-[#9CA3AF] text-xs">/</span>
            <input value={settings.subName} onChange={(e) => setSettings((s) => ({ ...s, subName: e.target.value }))}
              className="border border-[#E5E3F0] rounded-lg px-2 py-1 text-xs w-24 focus:outline-none focus:border-[#4F46E5]" placeholder="Sub name" />
            <input value={settings.month} onChange={(e) => setSettings((s) => ({ ...s, month: e.target.value }))}
              className="border border-[#E5E3F0] rounded-lg px-2 py-1 text-xs w-32 focus:outline-none focus:border-[#4F46E5]" />
            <button onClick={() => setEditingSettings(false)}
              className="h-7 px-3 rounded-full bg-[#4F46E5] text-white text-xs font-semibold cursor-pointer hover:bg-[#4338CA]">Done</button>
          </div>
        ) : (
          <button onClick={() => setEditingSettings(true)}
            className="flex items-center gap-1.5 text-xs text-[#6B7280] hover:text-[#1F2033] cursor-pointer transition-colors">
            <span className="font-semibold text-[#1F2033]">{settings.mainName}</span>
            <span>&</span>
            <span className="font-semibold text-[#1F2033]">{settings.subName}</span>
            <span className="text-[#D1D5DB]">·</span>
            <span>{settings.month}</span>
            <svg width="10" height="10" fill="none" viewBox="0 0 10 10" className="opacity-40">
              <path d="M2 8l4-4-4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}

        <div className="flex-1" />

        {unassigned > 0 && (
          <span className="text-xs font-semibold bg-amber-100 text-amber-700 px-3 py-1 rounded-full">
            {unassigned} unassigned
          </span>
        )}

        <button onClick={exportSummary}
          className="flex items-center gap-1.5 h-8 px-4 rounded-full border border-[#4F46E5] text-[#4F46E5] text-xs font-semibold hover:bg-[#EEF2FF] cursor-pointer transition-colors">
          <IconExport /> Export
        </button>

        <button onClick={onBack}
          className="flex items-center gap-1.5 h-8 px-4 rounded-full bg-[#F7F6FB] text-[#6B7280] text-xs font-semibold hover:bg-[#EEEDF7] cursor-pointer transition-colors border border-[#E5E3F0]">
          ↑ New file
        </button>
      </header>

      {/* Summary bar */}
      <div className="bg-white border-b border-[#E5E3F0] px-6 py-3">
        <div className="max-w-6xl mx-auto flex items-center gap-6 flex-wrap">
          <StatChip label={`${settings.mainName}`} amount={mainTotal} color="text-[#312E81]" bg="bg-[#EEF2FF]" />
          <StatChip label={`${settings.subName}`} amount={subTotal} color="text-[#7C3AED]" bg="bg-[#F5F3FF]" />
          <StatChip label="Shared" amount={splitTotal} color="text-[#D97706]" bg="bg-[#FFFBEB]" />
          {manualExpenses.length > 0 && <StatChip label="Other" amount={manualTotal} color="text-[#6B7280]" bg="bg-[#F9FAFB]" />}
          <div className="flex-1" />
          <div className={`flex items-center gap-3 px-5 py-2 rounded-full font-bold text-sm ${net >= 0 ? "bg-[#4F46E5] text-white" : "bg-[#DC2626] text-white"}`}>
            <span className="font-normal text-xs opacity-80">
              {net >= 0 ? `${settings.subName} pays ${settings.mainName}` : `${settings.mainName} pays ${settings.subName}`}
            </span>
            <span className="font-mono">${Math.abs(net).toFixed(2)}</span>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="bg-white border-b border-[#E5E3F0] px-6">
        <div className="max-w-6xl mx-auto flex gap-0">
          {([
            { id: "cc", label: "Credit Card", count: transactions.length },
            { id: "manual", label: "Other Expenses", count: manualExpenses.length },
            { id: "summary", label: "Summary" },
          ] as const).map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 px-4 py-3.5 text-sm font-semibold border-b-2 transition-colors cursor-pointer ${tab === t.id ? "border-[#4F46E5] text-[#4F46E5]" : "border-transparent text-[#6B7280] hover:text-[#1F2033]"}`}>
              {t.label}
              {"count" in t && t.count !== undefined && (
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${tab === t.id ? "bg-[#EEF2FF] text-[#4F46E5]" : "bg-[#F3F4F6] text-[#9CA3AF]"}`}>
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <main className="flex-1 px-6 py-6">
        <div className="max-w-6xl mx-auto">

          {tab === "cc" && (
            <div className="flex flex-col gap-4">
              {/* Controls */}
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex bg-white border border-[#E5E3F0] rounded-xl overflow-hidden p-1 gap-1">
                  {([
                    { value: "all", label: "All cards" },
                    { value: "main", label: settings.mainName },
                    { value: "sub", label: settings.subName },
                  ] as const).map((f) => (
                    <button key={f.value} onClick={() => setCardFilter(f.value)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${cardFilter === f.value ? "bg-[#4F46E5] text-white shadow-sm" : "text-[#6B7280] hover:bg-[#F7F6FB]"}`}>
                      {f.label}
                    </button>
                  ))}
                </div>
                <div className="flex-1" />
                <span className="text-xs text-[#9CA3AF] font-medium">Bulk:</span>
                {ASSIGN_OPTS.map((o) => (
                  <button key={o.value} onClick={() => bulkAssign(o.value)}
                    className="text-xs px-3 py-1.5 rounded-full border border-[#E5E3F0] text-[#6B7280] hover:bg-white cursor-pointer transition-colors font-medium">
                    All → {o.label}
                  </button>
                ))}
              </div>

              {/* Table */}
              <div className="bg-white rounded-2xl border border-[#E5E3F0] overflow-hidden">
                <div className="grid px-5 py-3 text-[10px] font-bold uppercase tracking-widest text-[#9CA3AF] border-b border-[#F3F4F6]"
                  style={{ gridTemplateColumns: "72px 1fr 90px auto" }}>
                  <span>Date</span><span>Description</span><span className="text-right">Amount</span><span className="text-right">Assign</span>
                </div>
                {filtered.length === 0
                  ? <div className="py-16 text-center text-[#9CA3AF] text-sm">No transactions</div>
                  : filtered.map((tx, i) => (
                    <div key={tx.id}
                      className={`grid items-center gap-4 px-5 py-3.5 transition-colors ${tx.assignment === "skip" ? "opacity-40" : tx.assignment === "split" ? "bg-amber-50" : ""} ${i !== 0 ? "border-t border-[#F7F6FB]" : ""}`}
                      style={{ gridTemplateColumns: "72px 1fr 90px auto" }}>
                      <span className="font-mono text-xs text-[#9CA3AF]">{tx.date}</span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-[#1F2033] truncate">{tx.description}</p>
                        {/* Clickable card-source badge — tap to toggle between Main / Supplementary */}
                        <button
                          onClick={() => toggleCardSource(tx.id)}
                          title="Click to switch between Main card / Supplementary card"
                          className={`inline-flex items-center gap-1 mt-0.5 text-[10px] font-semibold px-2 py-px rounded-full cursor-pointer transition-colors ${
                            tx.cardSource === "main"
                              ? "bg-[#EEF2FF] text-[#4F46E5] hover:bg-[#C7D2FE]"
                              : "bg-[#F5F3FF] text-[#7C3AED] hover:bg-[#DDD6FE]"
                          }`}>
                          {tx.cardSource === "main" ? settings.mainName : settings.subName} card
                          <svg width="8" height="8" viewBox="0 0 8 8" fill="none" className="opacity-60">
                            <path d="M1 3l3-2 3 2M1 5l3 2 3-2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>
                      </div>
                      <span className="font-mono text-sm font-semibold text-[#1F2033] text-right">${tx.amount.toFixed(2)}</span>
                      <div className="flex justify-end">
                        <AssignPills value={tx.assignment} onChange={(a) => updateTx(tx.id, a)} />
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {tab === "manual" && (
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-[#6B7280]">Expenses paid outside the credit card — PayNow, bank transfer, cash.</p>
                <button onClick={addManual}
                  className="h-9 px-5 rounded-full bg-[#4F46E5] text-white text-sm font-semibold hover:bg-[#4338CA] cursor-pointer transition-colors">
                  + Add expense
                </button>
              </div>
              <div className="bg-white rounded-2xl border border-[#E5E3F0] overflow-hidden">
                <div className="grid px-5 py-3 text-[10px] font-bold uppercase tracking-widest text-[#9CA3AF] border-b border-[#F3F4F6]"
                  style={{ gridTemplateColumns: "96px 1fr 110px 100px 100px 32px" }}>
                  <span>Date</span><span>Description</span><span>Amount</span><span>Paid by</span><span>Assign to</span><span />
                </div>
                {manualExpenses.length === 0
                  ? (
                    <div className="py-16 text-center">
                      <p className="text-[#9CA3AF] text-sm mb-3">No manual expenses yet</p>
                      <button onClick={addManual} className="text-sm text-[#4F46E5] font-semibold hover:underline cursor-pointer">
                        + Add your first expense
                      </button>
                    </div>
                  )
                  : manualExpenses.map((exp, i) => (
                    <div key={exp.id}
                      className={`grid items-center gap-3 px-5 py-3 ${i !== 0 ? "border-t border-[#F7F6FB]" : ""}`}
                      style={{ gridTemplateColumns: "96px 1fr 110px 100px 100px 32px" }}>
                      <input type="text" value={exp.date} onChange={(e) => updateManual(exp.id, { date: e.target.value })}
                        placeholder="01 Sep" className="font-mono text-xs border border-[#E5E3F0] rounded-lg px-2 py-1.5 bg-[#F7F6FB] w-full focus:outline-none focus:border-[#4F46E5]" />
                      <input type="text" value={exp.description} onChange={(e) => updateManual(exp.id, { description: e.target.value })}
                        placeholder="Description" className="text-sm border border-[#E5E3F0] rounded-lg px-2 py-1.5 bg-[#F7F6FB] w-full focus:outline-none focus:border-[#4F46E5]" />
                      <div className="relative">
                        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#9CA3AF] text-xs">$</span>
                        <input type="number" value={exp.amount || ""} onChange={(e) => updateManual(exp.id, { amount: parseFloat(e.target.value) || 0 })}
                          placeholder="0.00" className="font-mono text-sm border border-[#E5E3F0] rounded-lg pl-6 pr-2 py-1.5 bg-[#F7F6FB] w-full focus:outline-none focus:border-[#4F46E5]" />
                      </div>
                      <select value={exp.paidBy} onChange={(e) => updateManual(exp.id, { paidBy: e.target.value as "main" | "sub" })}
                        className="text-xs border border-[#E5E3F0] rounded-lg px-2 py-1.5 bg-[#F7F6FB] focus:outline-none focus:border-[#4F46E5]">
                        <option value="main">{settings.mainName}</option>
                        <option value="sub">{settings.subName}</option>
                      </select>
                      <select value={exp.assignment} onChange={(e) => updateManual(exp.id, { assignment: e.target.value as Assignment })}
                        className="text-xs border border-[#E5E3F0] rounded-lg px-2 py-1.5 bg-[#F7F6FB] focus:outline-none focus:border-[#4F46E5]">
                        <option value="main">{settings.mainName}</option>
                        <option value="sub">{settings.subName}</option>
                        <option value="split">Split 50/50</option>
                      </select>
                      <button onClick={() => deleteManual(exp.id)}
                        className="text-[#D1D5DB] hover:text-[#EF4444] transition-colors text-xl leading-none cursor-pointer">×</button>
                    </div>
                  ))}
              </div>
            </div>

              {/* Contributions section */}
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold text-[#1F2033]">Contributions & Credits</p>
                    <p className="text-xs text-[#6B7280] mt-0.5">Payments already made that reduce the settlement — shared savings top-ups, advance transfers, etc.</p>
                  </div>
                  <button onClick={addContribution}
                    className="h-9 px-5 rounded-full bg-[#059669] text-white text-sm font-semibold hover:bg-[#047857] cursor-pointer transition-colors shrink-0">
                    + Add contribution
                  </button>
                </div>
                <div className="bg-white rounded-2xl border border-[#A7F3D0] overflow-hidden">
                  <div className="grid px-5 py-3 text-[10px] font-bold uppercase tracking-widest text-[#9CA3AF] border-b border-[#F3F4F6]"
                    style={{ gridTemplateColumns: "96px 1fr 110px 140px 32px" }}>
                    <span>Date</span><span>Description</span><span>Amount</span><span>Paid by (contributor)</span><span />
                  </div>
                  {contributions.length === 0
                    ? (
                      <div className="py-12 text-center">
                        <p className="text-[#9CA3AF] text-sm mb-1">No contributions yet</p>
                        <p className="text-[#C4B5FD] text-xs">e.g. "Shared savings top-up $500 by {settings.subName}"</p>
                      </div>
                    )
                    : contributions.map((c, i) => (
                      <div key={c.id}
                        className={`grid items-center gap-3 px-5 py-3 ${i !== 0 ? "border-t border-[#F7F6FB]" : ""}`}
                        style={{ gridTemplateColumns: "96px 1fr 110px 140px 32px" }}>
                        <input type="text" value={c.date} onChange={(e) => updateContribution(c.id, { date: e.target.value })}
                          placeholder="01 Sep" className="font-mono text-xs border border-[#E5E3F0] rounded-lg px-2 py-1.5 bg-[#F0FDF4] w-full focus:outline-none focus:border-[#059669]" />
                        <input type="text" value={c.description} onChange={(e) => updateContribution(c.id, { description: e.target.value })}
                          placeholder="e.g. Shared savings top-up" className="text-sm border border-[#E5E3F0] rounded-lg px-2 py-1.5 bg-[#F0FDF4] w-full focus:outline-none focus:border-[#059669]" />
                        <div className="relative">
                          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#9CA3AF] text-xs">$</span>
                          <input type="number" value={c.amount || ""} onChange={(e) => updateContribution(c.id, { amount: parseFloat(e.target.value) || 0 })}
                            placeholder="0.00" className="font-mono text-sm border border-[#E5E3F0] rounded-lg pl-6 pr-2 py-1.5 bg-[#F0FDF4] w-full focus:outline-none focus:border-[#059669]" />
                        </div>
                        <select value={c.paidBy} onChange={(e) => updateContribution(c.id, { paidBy: e.target.value as "main" | "sub" })}
                          className="text-xs border border-[#E5E3F0] rounded-lg px-2 py-1.5 bg-[#F0FDF4] focus:outline-none focus:border-[#059669]">
                          <option value="main">{settings.mainName}</option>
                          <option value="sub">{settings.subName}</option>
                        </select>
                        <button onClick={() => deleteContribution(c.id)}
                          className="text-[#D1D5DB] hover:text-[#EF4444] transition-colors text-xl leading-none cursor-pointer">×</button>
                      </div>
                    ))}
                </div>
                {contributions.length > 0 && (
                  <div className="flex items-center gap-2 px-4 py-3 bg-[#ECFDF5] border border-[#A7F3D0] rounded-xl">
                    <span className="text-[#059669] text-lg">↓</span>
                    <p className="text-sm text-[#065F46]">
                      Total contributions of <span className="font-mono font-bold">${contributions.reduce((s, c) => s + (c.amount || 0), 0).toFixed(2)}</span> will be deducted from the settlement.
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {tab === "summary" && (
            <SummaryTab
              transactions={transactions}
              manualExpenses={manualExpenses}
              contributions={contributions}
              settings={settings}
              net={net}
              onExport={exportSummary}
            />
          )}
        </div>
      </main>
    </div>
  )
}

function StatChip({ label, amount, color, bg }: { label: string; amount: number; color: string; bg: string }) {
  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full ${bg}`}>
      <span className={`text-xs font-semibold ${color}`}>{label}</span>
      <span className={`font-mono text-xs font-bold ${color}`}>${amount.toFixed(2)}</span>
    </div>
  )
}

// ─── Summary Tab ──────────────────────────────────────────────────────────────

function SummaryTab({ transactions, manualExpenses, contributions = [], settings, net, onExport }: {
  transactions: Transaction[]
  manualExpenses: ManualExpense[]
  contributions?: Contribution[]
  settings: Settings
  net: number
  onExport: () => void
}) {
  const columns = [
    { key: "main" as const, label: `${settings.mainName}'s charges`, bg: "bg-[#EEF2FF]", text: "text-[#312E81]", border: "border-[#C7D2FE]" },
    { key: "sub" as const, label: `${settings.subName}'s charges`, bg: "bg-[#F5F3FF]", text: "text-[#7C3AED]", border: "border-[#DDD6FE]" },
    { key: "split" as const, label: "Shared (split 50/50)", bg: "bg-[#FFFBEB]", text: "text-[#D97706]", border: "border-[#FDE68A]" },
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-black text-[#1F2033]">{settings.month} — Settlement Summary</h2>
        <button onClick={onExport}
          className="flex items-center gap-1.5 h-9 px-4 rounded-full border border-[#4F46E5] text-[#4F46E5] text-sm font-semibold hover:bg-[#EEF2FF] cursor-pointer transition-colors">
          <IconExport /> Export .txt
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {columns.map((col) => {
          const items = transactions.filter((t) => t.assignment === col.key)
          const total = items.reduce((s, t) => s + t.amount, 0)
          return (
            <div key={col.key} className={`bg-white rounded-2xl border ${col.border} overflow-hidden`}>
              <div className={`px-4 py-4 ${col.bg}`}>
                <p className={`text-xs font-bold ${col.text} mb-1`}>{col.label}</p>
                <p className={`font-mono text-2xl font-black ${col.text}`}>${total.toFixed(2)}</p>
                {col.key === "split" && <p className={`text-[10px] ${col.text} opacity-70 mt-0.5`}>each pays ${(total / 2).toFixed(2)}</p>}
              </div>
              <div className="divide-y divide-[#F7F6FB] max-h-52 overflow-auto">
                {items.length === 0
                  ? <p className="px-4 py-4 text-xs text-[#9CA3AF]">None assigned</p>
                  : items.map((t) => (
                    <div key={t.id} className="flex items-center justify-between px-4 py-2.5">
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-[#1F2033] truncate">{t.description}</p>
                        <p className="text-[10px] font-mono text-[#9CA3AF]">{t.date}</p>
                      </div>
                      <span className="font-mono text-xs font-semibold text-[#1F2033] ml-2 shrink-0">${t.amount.toFixed(2)}</span>
                    </div>
                  ))}
              </div>
            </div>
          )
        })}
      </div>

      {manualExpenses.length > 0 && (
        <div className="bg-white rounded-2xl border border-[#E5E3F0] overflow-hidden">
          <div className="px-4 py-4 bg-[#F7F6FB] border-b border-[#E5E3F0]">
            <p className="text-xs font-bold text-[#6B7280]">Other Expenses (non-credit card)</p>
            <p className="font-mono text-2xl font-black text-[#1F2033] mt-1">
              ${manualExpenses.reduce((s, e) => s + (e.amount || 0), 0).toFixed(2)}
            </p>
          </div>
          <div className="divide-y divide-[#F7F6FB]">
            {manualExpenses.map((e) => (
              <div key={e.id} className="flex items-center gap-3 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[#1F2033]">{e.description || "—"}</p>
                  <p className="text-[10px] font-mono text-[#9CA3AF]">{e.date}</p>
                </div>
                <span className="font-mono text-sm font-semibold text-[#1F2033]">${(e.amount || 0).toFixed(2)}</span>
                <span className="text-xs bg-[#F3F4F6] text-[#6B7280] px-2 py-0.5 rounded-full font-medium">
                  Paid by {e.paidBy === "main" ? settings.mainName : settings.subName}
                </span>
                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                  e.assignment === "split" ? "bg-[#FFFBEB] text-[#D97706]"
                  : e.assignment === "main" ? "bg-[#EEF2FF] text-[#312E81]"
                  : "bg-[#F5F3FF] text-[#7C3AED]"
                }`}>
                  {e.assignment === "split" ? "Split" : e.assignment === "main" ? settings.mainName : settings.subName}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {contributions.length > 0 && (
        <div className="bg-white rounded-2xl border border-[#A7F3D0] overflow-hidden">
          <div className="px-4 py-4 bg-[#ECFDF5] border-b border-[#A7F3D0]">
            <p className="text-xs font-bold text-[#059669]">Contributions & Credits</p>
            <p className="font-mono text-2xl font-black text-[#065F46] mt-1">
              −${contributions.reduce((s, c) => s + (c.amount || 0), 0).toFixed(2)}
            </p>
            <p className="text-[10px] text-[#059669] mt-0.5">Deducted from settlement total</p>
          </div>
          <div className="divide-y divide-[#F0FDF4]">
            {contributions.map((c) => (
              <div key={c.id} className="flex items-center gap-3 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[#1F2033]">{c.description || "—"}</p>
                  <p className="text-[10px] font-mono text-[#9CA3AF]">{c.date}</p>
                </div>
                <span className="font-mono text-sm font-semibold text-[#059669]">−${(c.amount || 0).toFixed(2)}</span>
                <span className="text-xs bg-[#ECFDF5] text-[#059669] px-2 py-0.5 rounded-full font-medium border border-[#A7F3D0]">
                  {c.paidBy === "sub" ? settings.subName : settings.mainName} contributed
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Net card */}
      <div className={`rounded-2xl px-6 py-6 flex items-center justify-between ${net >= 0 ? "bg-[#4F46E5]" : "bg-[#DC2626]"}`}>
        <div>
          <p className="text-xs font-bold text-white/60 uppercase tracking-widest mb-1">Final Settlement</p>
          <p className="text-base font-semibold text-white">
            {net >= 0
              ? `${settings.subName} pays ${settings.mainName}`
              : `${settings.mainName} pays ${settings.subName}`}
          </p>
        </div>
        <div className="text-right">
          <p className="font-mono text-4xl font-black text-white">${Math.abs(net).toFixed(2)}</p>
          <div className="flex items-center justify-end gap-1 mt-1">
            <IconCheck />
            <span className="text-xs text-white/60">via PayNow or bank transfer</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [view, setView] = useState<AppView>("landing")
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [manualExpenses, setManualExpenses] = useState<ManualExpense[]>([])
  const [contributions, setContributions] = useState<Contribution[]>([])
  const [settings, setSettings] = useState<Settings>({
    mainName: "Husband",
    subName: "Wife",
    month: "September 2026",
  })

  const handleLoad = (txs: Transaction[], names?: { main?: string; sub?: string }) => {
    setTransactions(txs)
    if (names?.main || names?.sub) {
      setSettings((s) => ({
        ...s,
        mainName: names.main ? toTitleCase(names.main) : s.mainName,
        subName: names.sub ? toTitleCase(names.sub) : s.subName,
      }))
    }
    setView("app")
  }

  function toTitleCase(s: string) {
    return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
  }

  const handleSample = () => {
    setTransactions(SAMPLE.map((t) => ({ ...t })))
    setView("app")
  }

  if (view === "landing") return <LandingPage onGetStarted={() => setView("upload")} />
  if (view === "upload") return <UploadScreen onLoad={(txs, names) => handleLoad(txs, names)} onUseSample={handleSample} />
  return (
    <AppShell
      transactions={transactions}
      setTransactions={setTransactions}
      manualExpenses={manualExpenses}
      setManualExpenses={setManualExpenses}
      contributions={contributions}
      setContributions={setContributions}
      settings={settings}
      setSettings={setSettings}
      onBack={() => setView("upload")}
    />
  )
}
