import { useCallback, useRef, useState } from 'react'
import { Terms } from './components/Terms'
import { QueryBuilder } from './components/QueryBuilder'
import { Studies } from './components/Studies'
import { NiiViewer } from './components/NiiViewer'
import { useUrlQueryState } from './hooks/useUrlQueryState'
import './App.css'

export default function App () {
  const [query, setQuery] = useUrlQueryState('q')

  const handlePickTerm = useCallback((t) => {
    setQuery((q) => (q ? `${q} ${t}` : t))
  }, [setQuery])

  // Panel visibility toggles (columns are always horizontal regardless of window size)
  const [showTerms, setShowTerms] = useState(true)
  const [showMiddle, setShowMiddle] = useState(true)
  const [showViewer, setShowViewer] = useState(true)

  // 3-column resizable layout — sizes stored as pixel widths during drag,
  // then converted to percentages. Using refs to avoid stale-closure lag.
  const gridRef = useRef(null)
  const sizesRef = useRef([26, 48, 26]) // percentages [left, mid, right]
  const [sizes, setSizes] = useState([26, 48, 26])
  const MIN_PX = 220

  const startDrag = (which, e) => {
    e.preventDefault()
    const grid = gridRef.current
    if (!grid) return

    // Snapshot current pixel widths at drag start
    const totalW = grid.getBoundingClientRect().width
    let pxL = (sizesRef.current[0] / 100) * totalW
    let pxM = (sizesRef.current[1] / 100) * totalW
    let pxR = (sizesRef.current[2] / 100) * totalW
    let lastX = e.clientX

    const onMove = (ev) => {
      const dx = ev.clientX - lastX
      lastX = ev.clientX
      const curTotal = grid.getBoundingClientRect().width

      if (which === 0) {
        // drag between Left and Middle
        if (showTerms && showViewer) {
          pxL = Math.max(MIN_PX, pxL + dx)
          pxM = Math.max(MIN_PX, curTotal - pxL - pxR - 16) // 16 = 2 resizers * 8px
        } else if (showTerms && !showViewer) {
          pxL = Math.max(MIN_PX, Math.min(pxL + dx, curTotal - MIN_PX - 8))
          pxM = curTotal - pxL - 8
        }
      } else {
        // drag between Middle and Right
        if (showTerms && showViewer) {
          pxR = Math.max(MIN_PX, pxR - dx)
          pxM = Math.max(MIN_PX, curTotal - pxL - pxR - 16)
        } else if (!showTerms && showViewer) {
          pxR = Math.max(MIN_PX, Math.min(pxR - dx, curTotal - MIN_PX - 8))
          pxM = curTotal - pxR - 8
        }
      }

      const total = pxL + pxM + pxR
      const next = [
        (pxL / total) * 100,
        (pxM / total) * 100,
        (pxR / total) * 100,
      ]
      sizesRef.current = next
      setSizes(next)
    }

    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Calculate flex-basis for middle column (only used when showMiddle is true)
  const getMiddleFlexBasis = () => {
    if (!showTerms && !showViewer) return '100%'
    if (showTerms && !showViewer) return `${100 - sizes[0]}%`
    if (!showTerms && showViewer) return `${100 - sizes[2]}%`
    return `${sizes[1]}%`
  }

  const toggleBtnStyle = (active) => ({
    background: active ? '#2563eb' : '#ffffff',
    color: active ? '#ffffff' : '#374151',
    border: active ? '1px solid #2563eb' : '1px solid #d1d5db',
    padding: '6px 12px',
    borderRadius: '8px',
    fontSize: '12px',
    fontWeight: 600,
    cursor: 'pointer',
  })

  return (
    <div className="app">
      <style>{`
        .card input[type="text"],
        .card input[type="search"],
        .card input[type="number"],
        .card select,
        .card textarea {
          width: 100% !important;
          max-width: 100% !important;
          display: block;
        }
      `}</style>

      {/* Navigation header and pane toggles */}
      <header className="app__header flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h1 className="app__title text-xl font-extrabold tracking-tight">LoTUS-BF</h1>
          <div className="app__subtitle text-xs text-gray-500">
            Location-or-Term Unified Search for Brain Functions
          </div>
        </div>

        {/* Pane visibility toggles */}
        <div className="flex items-center gap-2 flex-wrap">
          <button type="button" onClick={() => setShowTerms(p => !p)}
            style={toggleBtnStyle(showTerms)} title="Toggle Terms column">
            {showTerms ? 'Hide Terms' : 'Show Terms'}
          </button>

          <button type="button" onClick={() => setShowMiddle(p => !p)}
            style={toggleBtnStyle(showMiddle)} title="Toggle middle column">
            {showMiddle ? 'Hide Builder' : 'Show Builder'}
          </button>

          <button type="button" onClick={() => setShowViewer(p => !p)}
            style={toggleBtnStyle(showViewer)} title="Toggle Viewer column">
            {showViewer ? 'Hide Viewer' : 'Show Viewer'}
          </button>

          <button
            type="button"
            onClick={() => { sizesRef.current = [26, 48, 26]; setSizes([26, 48, 26]); setShowTerms(true); setShowMiddle(true); setShowViewer(true) }}
            style={{ background: '#f3f4f6', color: '#4b5563', border: '1px solid #d1d5db', padding: '6px 10px', borderRadius: '8px', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
            title="Reset layout proportions"
          >
            Reset Layout
          </button>
        </div>
      </header>

      {/* Main Grid — always horizontal flex, fills remaining viewport height */}
      <main className="app__grid" ref={gridRef}>
        {/* Left Column: Terms */}
        {showTerms && (
          <section
            className="card overflow-auto"
            style={{ flexBasis: `${sizes[0]}%`, minWidth: `${MIN_PX}px`, flexShrink: 0 }}
          >
            <div className="card__title font-semibold mb-2">Terms</div>
            <Terms onPickTerm={handlePickTerm} />
          </section>
        )}

        {/* Resizer between Left and Middle */}
        {showTerms && showMiddle && (
          <div className="resizer" aria-label="Resize left/middle" onMouseDown={(e) => startDrag(0, e)} />
        )}

        {/* Middle Column: QueryBuilder + Studies */}
        {showMiddle && (
          <section
            className="card card--stack overflow-auto"
            style={{ flexBasis: getMiddleFlexBasis(), minWidth: '320px', flexShrink: 0, flexGrow: 1, minHeight: 0 }}
          >
            <QueryBuilder query={query} setQuery={setQuery} />
            <div className="divider my-3 border-t border-gray-200" />
            <Studies query={query} />
          </section>
        )}

        {/* Resizer between Middle and Right */}
        {showMiddle && showViewer && (
          <div className="resizer" aria-label="Resize middle/right" onMouseDown={(e) => startDrag(1, e)} />
        )}

        {/* Right Column: NiiViewer */}
        {showViewer && (
          <section
            className="card overflow-auto"
            style={{ flexBasis: `${sizes[2]}%`, minWidth: '260px', flexShrink: 0 }}
          >
            <NiiViewer query={query} />
          </section>
        )}
      </main>
    </div>
  )
}

