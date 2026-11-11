import { useEffect, useMemo, useRef, useState } from 'react'
import { useTerms } from '../hooks/useTerms'
import { findTermMatches } from '../utils/termUtils'

export function QueryBuilder({ query, setQuery }) {
  const { terms } = useTerms()
  const [activeWord, setActiveWord] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef(null)
  const dropdownRef = useRef(null)

  // Extract the word being typed at current cursor position
  const extractActiveWord = (val, cursorPos) => {
    if (!val || cursorPos == null) return ''
    const leftText = val.slice(0, cursorPos)
    const match = leftText.match(/([a-zA-Z0-9_\-]+)$/)
    return match ? match[1] : ''
  }

  const handleInputChange = (e) => {
    const val = e.target.value
    setQuery(val)
    const word = extractActiveWord(val, e.target.selectionStart)
    setActiveWord(word)
    setShowSuggestions(word.length >= 2)
    setSelectedIndex(0)
  }

  const handleInputClick = (e) => {
    const word = extractActiveWord(e.target.value, e.target.selectionStart)
    setActiveWord(word)
    setShowSuggestions(word.length >= 2)
  }

  // Suggestions with morphological/variant matching
  const suggestions = useMemo(() => {
    if (!activeWord || activeWord.length < 2 || !terms.length) return []
    return findTermMatches(activeWord, terms, 8)
  }, [activeWord, terms])

  const applySuggestion = (suggestedTerm) => {
    const input = inputRef.current
    if (!input) {
      setQuery((q) => (q ? `${q} ${suggestedTerm}` : suggestedTerm))
      return
    }

    const val = query || ''
    const cursorPos = input.selectionStart || val.length
    const leftText = val.slice(0, cursorPos)
    const rightText = val.slice(cursorPos)

    const formattedTerm = suggestedTerm.includes(' ') ? `"${suggestedTerm}"` : suggestedTerm
    const newLeft = leftText.replace(/([a-zA-Z0-9_\-]+)$/, formattedTerm)
    const nextQuery = newLeft + (rightText.startsWith(' ') ? '' : ' ') + rightText

    setQuery(nextQuery)
    setShowSuggestions(false)
    setActiveWord('')

    setTimeout(() => {
      input.focus()
      const nextPos = newLeft.length + 1
      input.setSelectionRange(nextPos, nextPos)
    }, 50)
  }

  const handleKeyDown = (e) => {
    if (showSuggestions && suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((prev) => (prev + 1) % suggestions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((prev) => (prev - 1 + suggestions.length) % suggestions.length)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        if (suggestions[selectedIndex]) {
          applySuggestion(suggestions[selectedIndex].term)
        }
        return
      }
      if (e.key === 'Escape') {
        setShowSuggestions(false)
        return
      }
    }

    if (e.key === 'Enter') {
      e.preventDefault()
      setQuery(e.currentTarget.value)
    }
  }

  const append = (token) => {
    setQuery((q) => (q ? `${q} ${token}` : token))
    inputRef.current?.focus()
  }

  useEffect(() => {
    const handleOutsideClick = (e) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target) &&
        inputRef.current &&
        !inputRef.current.contains(e.target)
      ) {
        setShowSuggestions(false)
      }
    }
    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [])

  return (
    <div className="flex flex-col gap-3 qb">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="card__title">Query Builder</div>
      </div>

      {/* Input container with autocomplete dropdown */}
      <div className="relative w-full">
        <input
          ref={inputRef}
          value={query}
          onChange={handleInputChange}
          onClick={handleInputClick}
          onKeyDown={handleKeyDown}
          placeholder="Create a query here, e.g.: [-22,-4,18] NOT emotion"
          className="qb__input w-full rounded-xl border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white"
          style={{ width: '100%', boxSizing: 'border-box' }}
        />

        {/* Autocomplete dropdown */}
        {showSuggestions && suggestions.length > 0 && (
          <div
            ref={dropdownRef}
            className="absolute left-0 right-0 top-full mt-1 z-50 rounded-xl border border-gray-200 bg-white shadow-xl overflow-hidden"
          >
            <div className="bg-gray-50 px-3 py-1 text-[11px] font-semibold text-gray-500 border-b border-gray-100 flex justify-between">
              <span>Suggestions:</span>
              <span className="font-mono text-gray-400">Up/Down to navigate, Enter to select, Esc to close</span>
            </div>
            <ul className="max-h-52 overflow-y-auto py-1">
              {suggestions.map((item, idx) => (
                <li
                  key={item.term}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    applySuggestion(item.term)
                  }}
                  className={`px-3 py-1.5 text-xs cursor-pointer flex items-center justify-between transition ${
                    idx === selectedIndex ? 'bg-blue-600 text-white' : 'text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{item.term}</span>
                    {item.matchType === 'variant' && (
                      <span
                        className={`text-[10px] px-1.5 py-0.2 rounded ${
                          idx === selectedIndex ? 'bg-blue-700 text-blue-100' : 'bg-amber-100 text-amber-800'
                        }`}
                      >
                        variant
                      </span>
                    )}
                  </div>
                  <span
                    className={`text-[10px] ${
                      idx === selectedIndex ? 'text-blue-200' : 'text-gray-400'
                    }`}
                  >
                    {item.matchType}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Operators + Reset (Clearly visible single row directly below input) */}
      <div className="flex gap-2 flex-wrap items-center">
        {[
          { label: 'AND', onClick: () => append('AND') },
          { label: 'OR', onClick: () => append('OR') },
          { label: 'NOT', onClick: () => append('NOT') },
          { label: '(', onClick: () => append('(') },
          { label: ')', onClick: () => append(')') },
          { label: 'Reset', onClick: () => setQuery('') },
        ].map((b) => (
          <button
            key={b.label}
            type="button"
            onClick={b.onClick}
            style={{
              backgroundColor: b.label === 'Reset' ? '#ef4444' : '#2563eb',
              color: '#ffffff',
              border: 'none',
              borderRadius: '8px',
              padding: '6px 14px',
              fontSize: '12px',
              fontWeight: '600',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              lineHeight: '1.2',
              boxShadow: '0 1px 2px rgba(0,0,0,0.1)'
            }}
          >
            {b.label}
          </button>
        ))}
      </div>
    </div>
  )
}

