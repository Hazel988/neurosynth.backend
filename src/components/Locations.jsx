// Locations.jsx
import { useEffect, useMemo, useState } from 'react'
import { API_BASE } from '../config/api'

function cls (...xs) { return xs.filter(Boolean).join(' ') }

export function Locations ({ query }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [r, setR] = useState(6.0)
  const [limit, setLimit] = useState(200)
  const [offset, setOffset] = useState(0)

  const [sortKey, setSortKey] = useState('study_id')
  const [sortDir, setSortDir] = useState('asc')
  const pageSize = 30
  const [page, setPage] = useState(1)

  useEffect(() => { setPage(1); setOffset(0) }, [query])

  useEffect(() => {
    if (!query) return
    let alive = true
    const ac = new AbortController()
    ;(async () => {
      setLoading(true); setErr('')
      try {
        const u = API_BASE.startsWith('http')
          ? new URL(`${API_BASE}/query/${encodeURIComponent(query)}/locations`)
          : new URL(`${API_BASE}/query/${encodeURIComponent(query)}/locations`, window.location.origin)
        u.searchParams.set('r', String(r))
        if (limit != null) u.searchParams.set('limit', String(limit))
        if (offset) u.searchParams.set('offset', String(offset))
        const res = await fetch(u.toString(), { signal: ac.signal })
        const data = await res.json().catch(()=>({}))
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
        if (!alive) return
        setRows(Array.isArray(data?.results) ? data.results : [])
      } catch (e) {
        if (!alive) return
        setErr(e?.message || String(e))
        setRows([])
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false; ac.abort() }
  }, [query, r, limit, offset])

  const sorted = useMemo(() => {
    const arr = [...rows]
    const dir = sortDir === 'asc' ? 1 : -1
    arr.sort((a,b) => {
      const A = a?.[sortKey], B = b?.[sortKey]
      if (sortKey === 'study_id' || sortKey === 'x' || sortKey === 'y' || sortKey === 'z') {
        return ((Number(A)||0) - (Number(B)||0)) * dir
      }
      return String(A||'').localeCompare(String(B||'')) * dir
    })
    return arr
  }, [rows, sortKey, sortDir])

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize))
  const pageRows = sorted.slice((page - 1) * pageSize, page * pageSize)

  const changeSort = (k) => {
    if (k === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(k); setSortDir('asc') }
  }

  return (
    <div className='flex flex-col rounded-2xl border'>
      <div className='flex items-center justify-between p-3'>
        <div className='font-semibold'>Locations</div>
        <div className='text-sm text-gray-500'>{query ? `query: ${query}` : 'Build a query above'}</div>
      </div>

      <div className='flex flex-wrap items-end gap-3 px-3 pb-2 text-sm'>
        <label className='flex flex-col'>r (mm)
          <input type='number' step='0.5' value={r} onChange={e=>setR(Number(e.target.value)||6)} className='w-24 rounded-lg border px-2 py-1'/>
        </label>
        <label className='flex flex-col'>limit
          <input type='number' step='10' value={limit} onChange={e=>setLimit(Math.max(0, Number(e.target.value)||0))} className='w-24 rounded-lg border px-2 py-1'/>
        </label>
        <label className='flex flex-col'>offset
          <input type='number' step='10' value={offset} onChange={e=>setOffset(Math.max(0, Number(e.target.value)||0))} className='w-24 rounded-lg border px-2 py-1'/>
        </label>
      </div>

      {!query && <div className='px-3 pb-4 text-sm text-gray-500'>No query provided.</div>}
      {query && loading && (
        <div className='grid gap-3 p-3'>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className='h-10 animate-pulse rounded-lg bg-gray-100' />
          ))}
        </div>
      )}
      {query && err && (
        <div className='mx-3 mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700'>
          {err}
        </div>
      )}

      {query && !loading && !err && (
        <div className='overflow-auto'>
          <table className='min-w-full text-sm'>
            <thead className='sticky top-0 bg-gray-50 text-left'>
              <tr>
                {[
                  { key: 'study_id', label: 'Study ID' },
                  { key: 'x', label: 'X' },
                  { key: 'y', label: 'Y' },
                  { key: 'z', label: 'Z' }
                ].map(({ key, label }) => (
                  <th key={key} className='cursor-pointer px-3 py-2 font-semibold' onClick={() => changeSort(key)}>
                    <span className='inline-flex items-center gap-2'>
                      {label}
                      <span className='text-xs text-gray-500'>{sortKey === key ? (sortDir === 'asc' ? '▲' : '▼') : ''}</span>
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageRows.length === 0 ? (
                <tr><td colSpan={4} className='px-3 py-4 text-gray-500'>No data</td></tr>
              ) : (
                pageRows.map((r, i) => (
                  <tr key={i} className={cls(i % 2 ? 'bg-white' : 'bg-gray-50')}>
                    <td className='px-3 py-2 align-top'>{r.study_id}</td>
                    <td className='px-3 py-2 align-top'>{r.x}</td>
                    <td className='px-3 py-2 align-top'>{r.y}</td>
                    <td className='px-3 py-2 align-top'>{r.z}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {query && !loading && !err && (
        <div className='flex items-center justify-between border-t p-3 text-sm'>
          <div>Total <b>{sorted.length}</b> records, page <b>{page}</b>/<b>{totalPages}</b></div>
          <div className='flex items-center gap-2'>
            <button disabled={page <= 1} onClick={() => setPage(1)} className='rounded-lg border px-2 py-1 disabled:opacity-40'>First</button>
            <button disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))} className='rounded-lg border px-2 py-1 disabled:opacity-40'>Previous</button>
            <button disabled={page >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))} className='rounded-lg border px-2 py-1 disabled:opacity-40'>Next</button>
            <button disabled={page >= totalPages} onClick={() => setPage(totalPages)} className='rounded-lg border px-2 py-1 disabled:opacity-40'>Last</button>
          </div>
        </div>
      )}
    </div>
  )
}

