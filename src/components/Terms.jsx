import { useMemo, useState } from 'react'
import { useTerms } from '../hooks/useTerms'
import { findTermMatches } from '../utils/termUtils'

const COMMON_TERMS = [
  'emotion',
  'language',
  'working memory',
  'attention',
  'reward',
  'pain',
  'motor',
  'visual',
  'auditory',
  'default mode',
  'amygdala',
  'hippocampus',
]

const COMMON_COORDINATES = [
  { label: 'Left Amygdala', coord: '[-22,-4,-18]' },
  { label: 'Right Amygdala', coord: '[24,-2,-18]' },
  { label: 'PCC (Default Mode)', coord: '[0,-52,26]' },
  { label: "Broca's Area", coord: '[-44,18,22]' },
  { label: 'Motor Hand', coord: '[-38,-22,56]' },
]

export function Terms({ onPickTerm }) {
  const { terms, loading, err } = useTerms()
  const [search, setSearch] = useState('')

  const isSearching = Boolean(search.trim())

  // Ensure common terms are always part of the searchable corpus
  const allTermsList = useMemo(() => {
    const set = new Set([...COMMON_TERMS, ...(terms || [])])
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [terms])

  // Filter terms with stemming & morphological variant matching
  const filteredTerms = useMemo(() => {
    const s = search.trim().toLowerCase()
    if (!s) return allTermsList
    const matches = findTermMatches(s, allTermsList, 1000)
    return matches.map(m => m.term)
  }, [allTermsList, search])

  // Unified chip style for recommended items
  const chipStyle = {
    background: '#eff6ff',
    color: '#1d4ed8',
    border: '1px solid #bfdbfe',
    borderRadius: '6px',
    padding: '3px 8px',
    fontSize: '11px',
    fontWeight: '500',
    cursor: 'pointer',
    userSelect: 'none',
    display: 'inline-block',
    transition: 'background 0.15s ease'
  }

  return (
    <div className="flex flex-col h-full terms-container select-none">
      {/* Top summary count */}
      <div className="text-xs text-gray-500 mb-2 font-medium">
        {loading ? `Total: ${filteredTerms.length} terms (syncing...)` : `Total: ${filteredTerms.length} terms`}
      </div>

      {/* Search box controls */}
      <div className="flex gap-2 mb-3 items-center">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search terms..."
          className="w-full rounded-xl border border-gray-300 px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
          style={{ width: '100%', boxSizing: 'border-box' }}
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch('')}
            className="rounded-lg border px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-100 shrink-0"
            style={{ fontSize: '11px' }}
          >
            Clear
          </button>
        )}
      </div>

      {err && (
        <div className="mb-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
          {err}
        </div>
      )}

      <div
        className="overflow-y-auto pr-1 flex-1"
        style={{ maxHeight: 'calc(100vh - 200px)' }}
      >
        {/* When no search is entered: show Common Terms and Common Coordinates */}
        {!isSearching && (
          <div className="flex flex-col gap-3 pb-3 mb-3 border-b border-gray-200">
            {/* Common Terms */}
            <div>
              <div className="text-xs font-semibold text-gray-700 mb-1.5">
                Common Terms
              </div>
              <div className="flex flex-wrap gap-1.5">
                {COMMON_TERMS.map((t) => (
                  <span
                    key={t}
                    onClick={() => onPickTerm?.(t)}
                    style={chipStyle}
                    title={`Add ${t} to query`}
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>

            {/* Common Coordinates (unified with the recommended terms color) */}
            <div>
              <div className="text-xs font-semibold text-gray-700 mb-1.5">
                Common Coordinates
              </div>
              <div className="flex flex-wrap gap-1.5">
                {COMMON_COORDINATES.map((item) => (
                  <span
                    key={item.label}
                    onClick={() => onPickTerm?.(item.coord)}
                    style={chipStyle}
                    title={`Add ${item.label} ${item.coord} to query`}
                  >
                    {item.label} {item.coord}
                  </span>
                ))}
              </div>
            </div>

            <div className="text-xs font-semibold text-gray-500 mt-1">
              All Terms (A-Z)
            </div>
          </div>
        )}

        {/* Clean list of terms */}
        {filteredTerms.length === 0 ? (
          <div className="p-4 text-center text-xs text-gray-400">
            No matching terms
          </div>
        ) : (
          <ul className="terms__ul space-y-1">
            {filteredTerms.map((t) => (
              <li key={t} className="terms__li">
                <a
                  href="#"
                  className="terms__name block px-2 py-1 text-xs text-gray-700 hover:text-blue-600 hover:bg-gray-50 rounded transition"
                  title={t}
                  onClick={(e) => {
                    e.preventDefault()
                    onPickTerm?.(t)
                  }}
                >
                  {t}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

