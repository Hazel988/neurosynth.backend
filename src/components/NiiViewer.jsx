import { useEffect, useMemo, useRef, useState } from 'react'
import * as nifti from 'nifti-reader-js'
import { Niivue } from '@niivue/niivue'
import { API_BASE } from '../config/api'

// Display setting: make x > 0 appear on screen right (right brain on right)
const X_RIGHT_ON_SCREEN_RIGHT = true

const MNI_BG_URL = `${import.meta.env.BASE_URL}static/mni_2mm.nii.gz`

// Detect MNI152 2mm template dims & spacing (91x109x91, 2mm iso)
function isStandardMNI2mm(dims, voxelMM) {
  const okDims = Array.isArray(dims) && dims[0] === 91 && dims[1] === 109 && dims[2] === 91
  const okSp = voxelMM && Math.abs(voxelMM[0] - 2) < 1e-3 && Math.abs(voxelMM[1] - 2) < 1e-3 && Math.abs(voxelMM[2] - 2) < 1e-3
  return okDims && okSp
}
// Standard MNI152 2mm affine (voxel i,j,k -> MNI mm):
// x = -2*i + 90;  y = 2*j - 126;  z = 2*k - 72
const MNI2MM = { x0: 90, y0: -126, z0: -72, vx: 2, vy: 2, vz: 2 }
const AXIS_SIGN = { x: -1, y: 1, z: 1 }

// Default fixed overlay / backend params
const voxel = 2.0
const kernel = 'gauss'
const r = 6.0
const posOnly = true
const useAbs = false

// ---------- module-level utils (no component state dependencies) ----------

function asTypedArray(header, buffer) {
  switch (header.datatypeCode) {
    case nifti.NIFTI1.TYPE_INT8: return new Int8Array(buffer)
    case nifti.NIFTI1.TYPE_UINT8: return new Uint8Array(buffer)
    case nifti.NIFTI1.TYPE_INT16: return new Int16Array(buffer)
    case nifti.NIFTI1.TYPE_UINT16: return new Uint16Array(buffer)
    case nifti.NIFTI1.TYPE_INT32: return new Int32Array(buffer)
    case nifti.NIFTI1.TYPE_UINT32: return new Uint32Array(buffer)
    case nifti.NIFTI1.TYPE_FLOAT32: return new Float32Array(buffer)
    case nifti.NIFTI1.TYPE_FLOAT64: return new Float64Array(buffer)
    default: return new Float32Array(buffer)
  }
}

function minmax(arr) {
  let mn = Infinity, mx = -Infinity
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i]
    if (v < mn) mn = v
    if (v > mx) mx = v
  }
  return [mn, mx]
}

function percentile(arr, p, step = Math.ceil(arr.length / 200000)) {
  if (!arr.length) return 0
  const samp = []
  for (let i = 0; i < arr.length; i += step) samp.push(arr[i])
  samp.sort((a, b) => a - b)
  const k = Math.floor((p / 100) * (samp.length - 1))
  return samp[Math.max(0, Math.min(samp.length - 1, k))]
}

async function loadNifti(url) {
  const res = await fetch(url)
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`GET ${url} → ${res.status} ${t}`)
  }
  let ab = await res.arrayBuffer()
  if (nifti.isCompressed(ab)) ab = nifti.decompress(ab)
  if (!nifti.isNIFTI(ab)) throw new Error('not a NIfTI file')
  const header = nifti.readHeader(ab)
  const image = nifti.readImage(header, ab)
  const ta = asTypedArray(header, image)
  let f32
  if (ta instanceof Float32Array) f32 = ta
  else if (ta instanceof Float64Array) f32 = Float32Array.from(ta)
  else {
    const [mn, mx] = minmax(ta)
    const range = (mx - mn) || 1
    f32 = new Float32Array(ta.length)
    for (let i = 0; i < ta.length; i++) f32[i] = (ta[i] - mn) / range
  }
  const nx = header.dims[1] | 0
  const ny = header.dims[2] | 0
  const nz = header.dims[3] | 0
  if (!nx || !ny || !nz) throw new Error('invalid dims')
  const [mn, mx] = minmax(f32)
  const vx = Math.abs(header.pixDims?.[1] ?? 1)
  const vy = Math.abs(header.pixDims?.[2] ?? 1)
  const vz = Math.abs(header.pixDims?.[3] ?? 1)
  const rawHeader = ab.slice(0, 352)
  return { data: f32, dims: [nx, ny, nz], voxelMM: [vx, vy, vz], min: mn, max: mx, rawHeader }
}

function idx2coord(i, n, axis, dims, voxelMM) {
  const [nx, ny, nz] = dims || [0, 0, 0]
  const vm = voxelMM || [1, 1, 1]
  const vx = Array.isArray(vm) ? (vm[0] ?? 1) : (vm.x ?? 1)
  const vy = Array.isArray(vm) ? (vm[1] ?? 1) : (vm.y ?? 1)
  const vz = Array.isArray(vm) ? (vm[2] ?? 1) : (vm.z ?? 1)
  const isStd = isStandardMNI2mm([nx, ny, nz], [vx, vy, vz])
  if (isStd) {
    if (axis === 'x') return (-MNI2MM.vx * i + MNI2MM.x0)
    if (axis === 'y') return (MNI2MM.vy * i + MNI2MM.y0)
    if (axis === 'z') return (MNI2MM.vz * i + MNI2MM.z0)
  }
  const mmPerVoxel = axis === 'x' ? vx : axis === 'y' ? vy : vz
  return AXIS_SIGN[axis] * (i - Math.floor(n / 2)) * mmPerVoxel
}

function coord2idx(c_mm, n, axis, dims, voxelMM) {
  const [nx, ny, nz] = dims || [0, 0, 0]
  const vm = voxelMM || [1, 1, 1]
  const vx = Array.isArray(vm) ? (vm[0] ?? 1) : (vm.x ?? 1)
  const vy = Array.isArray(vm) ? (vm[1] ?? 1) : (vm.y ?? 1)
  const vz = Array.isArray(vm) ? (vm[2] ?? 1) : (vm.z ?? 1)
  const isStd = isStandardMNI2mm([nx, ny, nz], [vx, vy, vz])
  if (isStd) {
    let v
    if (axis === 'x') v = ((MNI2MM.x0 - c_mm) / MNI2MM.vx)
    else if (axis === 'y') v = ((c_mm - MNI2MM.y0) / MNI2MM.vy)
    else v = ((c_mm - MNI2MM.z0) / MNI2MM.vz)
    const idx = Math.round(v)
    return Math.max(0, Math.min(n - 1, idx))
  }
  const mmPerVoxel = axis === 'x' ? vx : axis === 'y' ? vy : vz
  const sign = AXIS_SIGN[axis]
  const v = (sign * (c_mm / mmPerVoxel)) + Math.floor(n / 2)
  const idx = Math.round(v)
  return Math.max(0, Math.min(n - 1, idx))
}

// Build a minimal NIfTI-1 file in memory from raw Float32 data + header/dims.
// Preserves or synthesizes standard MNI152 affine matrices (srow_x/y/z, qform, sform)
// so Niivue aligns the 3D overlay precisely onto the brain surface instead of floating beside it.
function buildNifti1Blob(f32Data, rawHeader, dimArr, voxelMM) {
  const [nx, ny, nz] = dimArr || [91, 109, 91]
  const [vx, vy, vz] = voxelMM || [2, 2, 2]
  const totalHdr = 352 // 348 header + 4 extension bytes
  const buf = new ArrayBuffer(totalHdr + f32Data.byteLength)
  const view = new DataView(buf)
  const u8 = new Uint8Array(buf)

  if (rawHeader && (rawHeader.byteLength >= 348 || rawHeader.length >= 348)) {
    // Clone original NIfTI header bytes to preserve exact affine matrices
    const src = rawHeader instanceof Uint8Array
      ? rawHeader
      : new Uint8Array(rawHeader.buffer || rawHeader, rawHeader.byteOffset || 0, Math.min(352, rawHeader.byteLength || 352))
    u8.set(src.subarray(0, Math.min(352, src.length)))
  } else {
    // Fallback: generate standard MNI152 2mm header from scratch
    view.setInt32(0, 348, true)
    view.setInt16(40, 3, true)
    view.setInt16(42, nx, true)
    view.setInt16(44, ny, true)
    view.setInt16(46, nz, true)
    view.setInt16(48, 1, true); view.setInt16(50, 1, true)
    view.setInt16(52, 1, true); view.setInt16(54, 1, true)

    // pixdim: qfac = -1.0 for radiologic MNI orientation, vx, vy, vz
    view.setFloat32(76, -1.0, true)
    view.setFloat32(80, vx, true)
    view.setFloat32(84, vy, true)
    view.setFloat32(88, vz, true)

    // xyzt_units = mm (2)
    view.setUint8(123, 2)

    // Standard MNI152 affine:
    // x = -2*i + 90; y = 2*j - 126; z = 2*k - 72
    view.setInt16(252, 4, true) // qform_code = 4 (MNI_152)
    view.setInt16(254, 4, true) // sform_code = 4 (MNI_152)
    view.setFloat32(256, 0.0, true) // quatern_b
    view.setFloat32(260, 1.0, true) // quatern_c
    view.setFloat32(264, 0.0, true) // quatern_d
    view.setFloat32(268, 90.0, true) // qoffset_x
    view.setFloat32(272, -126.0, true) // qoffset_y
    view.setFloat32(276, -72.0, true) // qoffset_z

    // srow_x = [-2, 0, 0, 90]
    view.setFloat32(280, -vx, true); view.setFloat32(284, 0, true); view.setFloat32(288, 0, true); view.setFloat32(292, 90, true)
    // srow_y = [0, 2, 0, -126]
    view.setFloat32(296, 0, true); view.setFloat32(300, vy, true); view.setFloat32(304, 0, true); view.setFloat32(308, -126, true)
    // srow_z = [0, 0, 2, -72]
    view.setFloat32(312, 0, true); view.setFloat32(316, 0, true); view.setFloat32(320, vz, true); view.setFloat32(324, -72, true)
  }

  // Ensure datatype & offset match our single Float32 volume payload
  view.setInt32(0, 348, true) // sizeof_hdr
  view.setInt16(70, 16, true) // datatype = FLOAT32
  view.setInt16(72, 32, true) // bitpix = 32
  view.setFloat32(108, 352.0, true) // vox_offset = 352
  view.setFloat32(112, 1.0, true) // scl_slope = 1.0
  view.setFloat32(116, 0.0, true) // scl_inter = 0.0

  // magic = "n+1\0"
  u8[344] = 110; u8[345] = 43; u8[346] = 49; u8[347] = 0
  // extension: 4 zero bytes
  u8[348] = 0; u8[349] = 0; u8[350] = 0; u8[351] = 0

  // image data starting at byte 352
  new Float32Array(buf, 352, f32Data.length).set(f32Data)

  return new Blob([buf], { type: 'application/octet-stream' })
}

export function NiiViewer({ query }) {
  const [loadingBG, setLoadingBG] = useState(false)
  const [loadingMap, setLoadingMap] = useState(false)
  const [errBG, setErrBG] = useState('')
  const [errMap, setErrMap] = useState('')

  // backend params (map generation)
  const [fwhm, setFwhm] = useState(10.0)

  // overlay controls
  const [overlayAlpha, setOverlayAlpha] = useState(0.5)
  const [thrMode, setThrMode] = useState('pctl') // default: Percentile
  const [pctl, setPctl] = useState(95)
  const [thrValue, setThrValue] = useState(0) // used when mode === 'value'

  // volumes
  const bgRef = useRef(null) // { data, dims:[nx,ny,nz], voxelMM:[vx,vy,vz], min, max }
  const mapRef = useRef(null) // { data, dims:[nx,ny,nz], voxelMM:[vx,vy,vz], min, max }
  const [mapData, setMapData] = useState(null)

  const getVoxelMM = () => bgRef.current?.voxelMM ?? mapRef.current?.voxelMM ?? [1, 1, 1]
  const [dims, setDims] = useState([0, 0, 0]) // canvas dims (prefer BG; overlay only if same dims)

  // slice indices (voxel coordinates in [0..N-1])
  const [ix, setIx] = useState(0) // sagittal (X)
  const [iy, setIy] = useState(0) // coronal  (Y)
  const [iz, setIz] = useState(0) // axial    (Z)

  // 2D vs 3D view mode toggle
  const [viewMode, setViewMode] = useState('2d') // '2d' | '3d'
  const canvas3DRef = useRef(null)
  const nvRef = useRef(null)

  // Neurosynth-style displayed coords: signed, centered at middle voxel
  const [cx, setCx] = useState('0')
  const [cy, setCy] = useState('0')
  const [cz, setCz] = useState('0')

  const canvasAxialRef = useRef(null) // z
  const canvasCoronalRef = useRef(null) // y
  const canvasSagittalRef = useRef(null) // x

  const mapUrl = useMemo(() => {
    if (!query) return ''
    const u = API_BASE.startsWith('http')
      ? new URL(`${API_BASE}/query/${encodeURIComponent(query)}/nii`)
      : new URL(`${API_BASE}/query/${encodeURIComponent(query)}/nii`, window.location.origin)
    u.searchParams.set('voxel', String(voxel))
    u.searchParams.set('fwhm', String(fwhm))
    u.searchParams.set('kernel', String(kernel))
    u.searchParams.set('r', String(r))
    return u.toString()
  }, [query, fwhm])

  // Track object URL for 3D overlay blob so we can revoke it on cleanup
  const overlayBlobUrlRef = useRef(null)

  const mapThreshold = useMemo(() => {
    const mv = mapData || mapRef.current
    if (!mv) return null
    if (thrMode === 'value') return Number(thrValue) || 0
    return percentile(mv.data, Math.max(0, Math.min(100, Number(pctl) || 95)))
  }, [thrMode, thrValue, pctl, mapData])

  // Initialize Niivue and reload volumes when map data or threshold changes.
  // Uses the same pass/fail logic as the 2D canvas overlay for identical red-dot appearance.
  useEffect(() => {
    let active = true
    if (!canvas3DRef.current) return

    const setupNiivue = async () => {
      try {
        let nv = nvRef.current
        if (!nv) {
          nv = new Niivue({
            show3Dcrosshair: true,
            backColor: [0.08, 0.09, 0.12, 1],
            isColorbar: false,
          })
          await nv.attachToCanvas(canvas3DRef.current)
          nv.setSliceType(nv.sliceTypeRender)
          nv.setVolumeRenderIllumination(0.6)
          nvRef.current = nv
        }

        const bgUrl = new URL(MNI_BG_URL, window.location.href).href
        const volumeList = [
          { url: bgUrl, name: 'mni_2mm.nii.gz', colormap: 'gray', opacity: 0.8 }
        ]

        // Build binary overlay matching 2D logic exactly
        const mv = mapData || mapRef.current
        if (mv) {
          const thr = mapThreshold
          const binary = new Float32Array(mv.data.length)
          for (let i = 0; i < mv.data.length; i++) {
            const raw = mv.data[i]
            const val = useAbs ? Math.abs(raw) : raw
            let pass = (thr == null || thr <= 0) ? (raw > 0) : (val >= thr)
            if (posOnly && raw <= 0) pass = false
            binary[i] = pass ? 1.0 : 0.0
          }

          // Revoke previous blob URL if any
          if (overlayBlobUrlRef.current) {
            URL.revokeObjectURL(overlayBlobUrlRef.current)
            overlayBlobUrlRef.current = null
          }

          const rawHeader = mv.rawHeader || bgRef.current?.rawHeader
          const blob = buildNifti1Blob(binary, rawHeader, mv.dims, mv.voxelMM)
          const blobUrl = URL.createObjectURL(blob)
          overlayBlobUrlRef.current = blobUrl

          volumeList.push({
            url: blobUrl,
            name: 'overlay_mask.nii.gz',
            colormap: 'red',
            opacity: typeof overlayAlpha === 'number' ? overlayAlpha : 0.8,
            cal_min: 0.5,
            cal_max: 1.0,
          })
        }

        await nv.loadVolumes(volumeList)
        if (!active) return
        nv.setSliceType(nv.sliceTypeRender)
        nv.setVolumeRenderIllumination(0.6)
        nv.resizeListener()
        nv.drawScene()
      } catch (err) {
        console.warn('Niivue 3D setup error:', err)
      }
    }

    setupNiivue()
    return () => {
      active = false
    }
  }, [mapData, mapThreshold, posOnly, useAbs]) // eslint-disable-line react-hooks/exhaustive-deps

  // Live alpha update — set opacity on existing volume without reloading
  useEffect(() => {
    const nv = nvRef.current
    if (!nv || !nv.volumes || nv.volumes.length < 2) return
    try {
      nv.setOpacity(1, overlayAlpha) // index 1 = overlay volume
      nv.drawScene()
    } catch (e) {
      console.warn('Niivue setOpacity error:', e)
    }
  }, [overlayAlpha])

  // When switching to 3D mode: resize and redraw WebGL scene after a paint cycle
  useEffect(() => {
    if (viewMode === '3d' && nvRef.current) {
      // rAF ensures the browser has painted the newly visible container
      const rafId = requestAnimationFrame(() => {
        const timer = setTimeout(() => {
          try {
            nvRef.current?.resizeListener()
            nvRef.current?.setSliceType(nvRef.current.sliceTypeRender)
            nvRef.current?.setVolumeRenderIllumination(0.6)
            nvRef.current?.drawScene()
          } catch (e) {
            console.warn('Niivue 3D resize warning:', e)
          }
        }, 50)
        return () => clearTimeout(timer)
      })
      return () => cancelAnimationFrame(rafId)
    }
  }, [viewMode])

  // Load background on mount
  useEffect(() => {
    let alive = true
    setLoadingBG(true)
    setErrBG('')
    ;(async () => {
      try {
        const bg = await loadNifti(MNI_BG_URL)
        if (!alive) return
        bgRef.current = bg
        setDims(bg.dims)
        const [nx, ny, nz] = bg.dims
        const mx = Math.floor(nx / 2), my = Math.floor(ny / 2), mz = Math.floor(nz / 2)
        setIx(mx)
        setIy(my)
        setIz(mz)
        setCx('0')
        setCy('0')
        setCz('0')
      } catch (e) {
        if (!alive) return
        setErrBG(e?.message || String(e))
        bgRef.current = null
      }
      if (alive) setLoadingBG(false)
    })()
    return () => { alive = false }
  }, [])

  // Keep thrValue within current map range when map changes
  useEffect(() => {
    const mn = (mapData || mapRef.current)?.min ?? 0
    const mx = (mapData || mapRef.current)?.max ?? 1
    setThrValue((cur) => {
      if (cur < mn || cur > mx) {
        return Math.min(mx, Math.max(mn, cur))
      }
      return cur
    })
  }, [mapData, dims])

  // Load meta-analytic map when query or map params change
  useEffect(() => {
    if (!mapUrl) {
      mapRef.current = null
      setMapData(null)
      return
    }
    let alive = true
    setLoadingMap(true)
    setErrMap('')
    ;(async () => {
      try {
        const mv = await loadNifti(mapUrl)
        if (!alive) return
        mapRef.current = mv
        setMapData(mv)

        const [nx, ny, nz] = bgRef.current?.dims || mv.dims
        if (!bgRef.current) {
          setDims(mv.dims)
        }

        const vm = bgRef.current?.voxelMM ?? mv.voxelMM ?? [1, 1, 1]

        // Auto-center on coordinates if query contains [x,y,z]
        const coordMatch = query.match(/\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/)
        if (coordMatch && nx && ny && nz) {
          const qx = parseFloat(coordMatch[1])
          const qy = parseFloat(coordMatch[2])
          const qz = parseFloat(coordMatch[3])
          setCx(String(qx))
          setCy(String(qy))
          setCz(String(qz))
          setIx(coord2idx(qx, nx, 'x', [nx, ny, nz], vm))
          setIy(coord2idx(qy, ny, 'y', [nx, ny, nz], vm))
          setIz(coord2idx(qz, nz, 'z', [nx, ny, nz], vm))
        } else if (mv.max > 0 && nx && ny && nz) {
          // If query has no coordinate, jump crosshair to peak activation voxel
          let maxVal = -Infinity
          let maxIdx = -1
          for (let i = 0; i < mv.data.length; i++) {
            if (mv.data[i] > maxVal) {
              maxVal = mv.data[i]
              maxIdx = i
            }
          }
          if (maxIdx >= 0 && maxVal > 0) {
            const pk = Math.floor(maxIdx / (nx * ny))
            const rem = maxIdx % (nx * ny)
            const pj = Math.floor(rem / nx)
            const pi = rem % nx
            setIx(pi)
            setIy(pj)
            setIz(pk)
            setCx(String(idx2coord(pi, nx, 'x', [nx, ny, nz], vm)))
            setCy(String(idx2coord(pj, ny, 'y', [nx, ny, nz], vm)))
            setCz(String(idx2coord(pk, nz, 'z', [nx, ny, nz], vm)))
          }
        }
      } catch (e) {
        if (!alive) return
        setErrMap(e?.message || String(e))
        mapRef.current = null
        setMapData(null)
      }
      if (alive) setLoadingMap(false)
    })()
    return () => { alive = false }
  }, [mapUrl, query])

  // Click-to-move crosshairs
  function onCanvasClick(e, axis) {
    const canvas = e.currentTarget
    const rect = canvas.getBoundingClientRect()
    const x = Math.floor((e.clientX - rect.left) * canvas.width / rect.width)
    const y = Math.floor((e.clientY - rect.top) * canvas.height / rect.height)
    const srcY = canvas.height - 1 - y
    const [nx, ny, nz] = dims
    const vm = getVoxelMM()

    const toIdxX = (screenX) => (X_RIGHT_ON_SCREEN_RIGHT ? (nx - 1 - screenX) : screenX)
    if (axis === 'z') {
      const xi = toIdxX(x)
      setIx(xi)
      setIy(srcY)
      setCx(String(idx2coord(xi, nx, 'x', dims, vm)))
      setCy(String(idx2coord(srcY, ny, 'y', dims, vm)))
    } else if (axis === 'y') {
      const xi = toIdxX(x)
      setIx(xi)
      setIz(srcY)
      setCx(String(idx2coord(xi, nx, 'x', dims, vm)))
      setCz(String(idx2coord(srcY, nz, 'z', dims, vm)))
    } else {
      setIy(x)
      setIz(srcY)
      setCy(String(idx2coord(x, ny, 'y', dims, vm)))
      setCz(String(idx2coord(srcY, nz, 'z', dims, vm)))
    }
  }

  // Keep display coords in sync when ix/iy/iz/dims change
  useEffect(() => {
    const [nx, ny, nz] = dims
    if (!nx) return
    const vm = getVoxelMM()
    setCx(String(idx2coord(ix, nx, 'x', dims, vm)))
    setCy(String(idx2coord(iy, ny, 'y', dims, vm)))
    setCz(String(idx2coord(iz, nz, 'z', dims, vm)))
  }, [ix, iy, iz, dims])

  // Commit handlers: parse signed integer, map to index, clamp to volume
  const commitCoord = (axis) => {
    const [nx, ny, nz] = dims
    let vStr = axis === 'x' ? cx : axis === 'y' ? cy : cz
    if (vStr === '' || vStr === '-') return
    const parsed = parseFloat(vStr)
    if (Number.isNaN(parsed)) return
    const vm = getVoxelMM()
    if (axis === 'x') setIx(coord2idx(parsed, nx, 'x', dims, vm))
    if (axis === 'y') setIy(coord2idx(parsed, ny, 'y', dims, vm))
    if (axis === 'z') setIz(coord2idx(parsed, nz, 'z', dims, vm))
  }

  // Redraw on state changes and viewMode switch
  useEffect(() => {
    if (viewMode !== '2d') return
    const [nx, ny, nz] = dims
    if (!nx) return

    function drawSlice(canvas, axis /* 'z' | 'y' | 'x' */, index) {
      // Flip horizontal axis if right brain is placed on screen right
      const sx = (x) => (X_RIGHT_ON_SCREEN_RIGHT ? (nx - 1 - x) : x)
      const bg = bgRef.current
      const map = mapData || mapRef.current

      const dimsStr = dims.join('x')
      const bgOK = !!(bg && bg.dims.join('x') === dimsStr)
      const mapOK = !!(map && map.dims.join('x') === dimsStr)

      let w = 0, h = 0, getBG = null, getMap = null
      if (axis === 'z') {
        w = nx
        h = ny
        if (bgOK) getBG = (x, y) => bg.data[sx(x) + y * nx + index * nx * ny]
        if (mapOK) getMap = (x, y) => map.data[sx(x) + y * nx + index * nx * ny]
      }
      if (axis === 'y') {
        w = nx
        h = nz
        if (bgOK) getBG = (x, y) => bg.data[sx(x) + index * nx + y * nx * ny]
        if (mapOK) getMap = (x, y) => map.data[sx(x) + index * nx + y * nx * ny]
      }
      if (axis === 'x') {
        w = ny
        h = nz
        if (bgOK) getBG = (x, y) => bg.data[index + x * nx + y * nx * ny]
        if (mapOK) getMap = (x, y) => map.data[index + x * nx + y * nx * ny]
      }

      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d', { willReadFrequently: false })
      const img = ctx.createImageData(w, h)

      const alpha = Math.max(0, Math.min(1, overlayAlpha))
      const R = 255, G = 0, B = 0
      const thr = mapThreshold

      // Background normalization based on its min/max
      const bgMin = bg?.min ?? 0
      const bgMax = bg?.max ?? 1
      const bgRange = (bgMax - bgMin) || 1

      let p = 0
      for (let yy = 0; yy < h; yy++) {
        const srcY = h - 1 - yy // flip vertically
        for (let xx = 0; xx < w; xx++) {
          // Draw background
          let gray = 0
          if (getBG) {
            const vbg = getBG(xx, srcY)
            let g = (vbg - bgMin) / bgRange
            if (g < 0) g = 0
            if (g > 1) g = 1
            gray = (g * 255) | 0
          }
          img.data[p] = gray
          img.data[p + 1] = gray
          img.data[p + 2] = gray
          img.data[p + 3] = 255

          // Overlay map (activation clusters / red dots)
          if (getMap) {
            let mv = getMap(xx, srcY)
            const raw = mv
            if (useAbs) mv = Math.abs(mv)
            let pass = (thr == null || thr <= 0) ? (raw > 0) : (mv >= thr)
            if (posOnly && raw <= 0) pass = false
            if (pass) {
              img.data[p] = ((1 - alpha) * img.data[p] + alpha * R) | 0
              img.data[p + 1] = ((1 - alpha) * img.data[p + 1] + alpha * G) | 0
              img.data[p + 2] = ((1 - alpha) * img.data[p + 2] + alpha * B) | 0
            }
          }
          p += 4
        }
      }
      ctx.putImageData(img, 0, 0)

      // Draw green crosshairs
      ctx.save()
      ctx.strokeStyle = '#00ff00'
      ctx.lineWidth = 1
      let crossX = 0, crossY = 0
      if (axis === 'z') {
        crossX = Math.max(0, Math.min(w - 1, (X_RIGHT_ON_SCREEN_RIGHT ? (w - 1 - ix) : ix)))
        crossY = Math.max(0, Math.min(h - 1, iy))
      } else if (axis === 'y') {
        crossX = Math.max(0, Math.min(w - 1, (X_RIGHT_ON_SCREEN_RIGHT ? (w - 1 - ix) : ix)))
        crossY = Math.max(0, Math.min(h - 1, iz))
      } else {
        crossX = Math.max(0, Math.min(w - 1, iy))
        crossY = Math.max(0, Math.min(h - 1, iz))
      }
      const screenY = h - 1 - crossY
      ctx.beginPath()
      ctx.moveTo(crossX + 0.5, 0)
      ctx.lineTo(crossX + 0.5, h)
      ctx.stroke()

      ctx.beginPath()
      ctx.moveTo(0, screenY + 0.5)
      ctx.lineTo(w, screenY + 0.5)
      ctx.stroke()
      ctx.restore()
    }

    const c0 = canvasAxialRef.current
    const c1 = canvasCoronalRef.current
    const c2 = canvasSagittalRef.current
    if (c0 && iz >= 0 && iz < nz) drawSlice(c0, 'z', iz)
    if (c1 && iy >= 0 && iy < ny) drawSlice(c1, 'y', iy)
    if (c2 && ix >= 0 && ix < nx) drawSlice(c2, 'x', ix)
  }, [
    viewMode, dims, ix, iy, iz,
    overlayAlpha, mapThreshold, mapData
  ])

  const [nx, ny, nz] = dims

  // Slice configs
  const sliceConfigs = [
    { key: 'y', name: 'Coronal', axisLabel: 'Y', index: iy, setIndex: setIy, max: Math.max(0, ny - 1), canvasRef: canvasCoronalRef },
    { key: 'x', name: 'Sagittal', axisLabel: 'X', index: ix, setIndex: setIx, max: Math.max(0, nx - 1), canvasRef: canvasSagittalRef },
    { key: 'z', name: 'Axial', axisLabel: 'Z', index: iz, setIndex: setIz, max: Math.max(0, nz - 1), canvasRef: canvasAxialRef },
  ]

  const nsInputCls = 'w-16 rounded border border-gray-400 px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400'
  const nsLabelCls = 'mr-1 text-sm'

  return (
    <div className='flex flex-col gap-3' style={{ position: 'relative' }}>
      {/* Header with Mode Toggle */}
      <div className='flex items-center justify-between'>
        <div className='card__title mb-0'>NIfTI Viewer</div>
        <div className='flex items-center gap-2 text-sm text-gray-500'>
          <div className='flex items-center gap-1 bg-gray-100 p-0.5 rounded-lg border border-gray-200'>
            <button
              type='button'
              onClick={() => setViewMode('2d')}
              className='px-3 py-1 rounded text-xs font-semibold'
              style={{
                background: viewMode === '2d' ? '#2563eb' : 'transparent',
                color: viewMode === '2d' ? '#ffffff' : '#4b5563',
                border: 'none',
                cursor: 'pointer'
              }}
            >
              2D Slices
            </button>
            <button
              type='button'
              onClick={() => setViewMode('3d')}
              className='px-3 py-1 rounded text-xs font-semibold'
              style={{
                background: viewMode === '3d' ? '#2563eb' : 'transparent',
                color: viewMode === '3d' ? '#ffffff' : '#4b5563',
                border: 'none',
                cursor: 'pointer'
              }}
            >
              3D Volume
            </button>
          </div>
          {query && (
            <a
              href={mapUrl}
              className='rounded-lg border px-2.5 py-1 text-xs hover:bg-gray-50 text-gray-600'
              style={{ textDecoration: 'none' }}
            >
              Download map
            </a>
          )}
        </div>
      </div>

      {/* Threshold mode & value */}
      <div className='rounded-xl border p-3 text-sm'>
        <div className='flex items-center gap-4 flex-wrap'>
          <label className='flex items-center gap-2'>
            <span>Threshold mode:</span>
            <select
              value={thrMode}
              onChange={(e) => setThrMode(e.target.value)}
              className='rounded-lg border px-2 py-1 text-xs'
            >
              <option value='value'>Value</option>
              <option value='pctl'>Percentile</option>
            </select>
          </label>

          {thrMode === 'value' ? (
            <label className='flex items-center gap-2'>
              <span>Threshold:</span>
              <input
                type='number'
                step='0.01'
                value={thrValue}
                onChange={(e) => setThrValue(Number(e.target.value))}
                className='w-24 rounded-lg border px-2 py-1 text-xs'
              />
            </label>
          ) : (
            <label className='flex items-center gap-2'>
              <span>Percentile:</span>
              <input
                type='number'
                min={50}
                max={99.9}
                step={0.5}
                value={pctl}
                onChange={(e) => setPctl(Number(e.target.value) || 95)}
                className='w-24 rounded-lg border px-2 py-1 text-xs'
              />
            </label>
          )}
        </div>

        {/* Neurosynth-style coordinate inputs (signed, centered at 0) */}
        <div className='mt-2.5 flex items-center gap-4 flex-wrap'>
          <label className='flex items-center'>
            <span className={nsLabelCls}>X (mm):</span>
            <input
              type='text'
              inputMode='decimal'
              pattern='-?[0-9]*([.][0-9]+)?'
              className={nsInputCls}
              value={cx}
              onChange={(e) => setCx(e.target.value)}
              onBlur={() => commitCoord('x')}
              onKeyDown={(e) => { if (e.key === 'Enter') commitCoord('x') }}
              aria-label='X coordinate (centered)'
            />
          </label>
          <label className='flex items-center'>
            <span className={nsLabelCls}>Y (mm):</span>
            <input
              type='text'
              inputMode='decimal'
              pattern='-?[0-9]*([.][0-9]+)?'
              className={nsInputCls}
              value={cy}
              onChange={(e) => setCy(e.target.value)}
              onBlur={() => commitCoord('y')}
              onKeyDown={(e) => { if (e.key === 'Enter') commitCoord('y') }}
              aria-label='Y coordinate (centered)'
            />
          </label>
          <label className='flex items-center'>
            <span className={nsLabelCls}>Z (mm):</span>
            <input
              type='text'
              inputMode='decimal'
              pattern='-?[0-9]*([.][0-9]+)?'
              className={nsInputCls}
              value={cz}
              onChange={(e) => setCz(e.target.value)}
              onBlur={() => commitCoord('z')}
              onKeyDown={(e) => { if (e.key === 'Enter') commitCoord('z') }}
              aria-label='Z coordinate (centered)'
            />
          </label>
        </div>
      </div>

      {/* Loading indicator */}
      {(loadingBG || loadingMap) && (
        <div className='grid gap-3 lg:grid-cols-3'>
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className='h-64 animate-pulse rounded-xl border bg-gray-100' />
          ))}
        </div>
      )}

      {/* Error display */}
      {(errBG || errMap) && (
        <div className='rounded-lg border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800'>
          {errBG && <div>Background: {errBG}</div>}
          {errMap && <div>Map: {errMap}</div>}
        </div>
      )}

      {/* 3D Volume View — kept in DOM at all times so Niivue has real pixel dimensions.
          When in 2D mode: hidden via visibility+position so it still occupies no visual space. */}
      <div
        className='rounded-xl border border-gray-300 overflow-hidden bg-gray-950 flex flex-col shadow-inner'
        style={
          viewMode === '3d'
            ? { width: '100%', position: 'relative' }
            : { position: 'absolute', visibility: 'hidden', pointerEvents: 'none', width: '100%', top: 0, left: 0 }
        }
      >
        <div className='px-3 py-2 text-xs text-gray-300 bg-gray-900 border-b border-gray-800 w-full'>
          <span>3D View: Left-click + drag to rotate | Scroll to zoom | Right-click to pan</span>
        </div>
        <div style={{ position: 'relative', width: '100%', paddingBottom: '100%', backgroundColor: '#14171f', flexShrink: 0 }}>
          <canvas
            ref={canvas3DRef}
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', display: 'block', cursor: 'grab' }}
          />
        </div>
      </div>

      {/* 2D Multiplanar Slices (kept mounted in DOM) */}
      <div
        className='grid grid-cols-3 gap-3'
        style={{
          display: viewMode === '2d' && !!nx ? 'grid' : 'none',
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gap: 12
        }}
      >
        {sliceConfigs.map(({ key, name, axisLabel, canvasRef }) => (
          <div key={key} className='flex flex-col gap-2'>
            <div className='text-xs text-gray-600 font-medium'>{name} ({axisLabel})</div>
            <div className='flex items-center gap-2'>
              <canvas
                ref={canvasRef}
                className='h-64 w-full rounded-xl border'
                onClick={(e) => onCanvasClick(e, key)}
                style={{ cursor: 'crosshair', display: 'block' }}
              />
            </div>
          </div>
        ))}
      </div>

      {/* Map generation params */}
      <div className='rounded-xl border p-3 text-sm'>
        <label className='flex flex-col gap-1'>
          <span className='font-medium text-xs text-gray-700'>Gaussian FWHM (mm):</span>
          <input
            type='number'
            step='0.5'
            value={fwhm}
            onChange={(e) => setFwhm(Number(e.target.value) || 0)}
            className='w-28 rounded-lg border px-2 py-1 text-xs'
          />
        </label>
      </div>

      {/* Overlay controls */}
      <div className='rounded-xl border p-3 text-sm'>
        <label className='flex items-center gap-2'>
          <span className='font-medium text-xs text-gray-700'>Overlay alpha:</span>
          <input
            type='range'
            min={0}
            max={1}
            step={0.05}
            value={overlayAlpha}
            onChange={(e) => setOverlayAlpha(Number(e.target.value))}
            className='w-40'
          />
          <span className='text-xs text-gray-500 font-mono'>{overlayAlpha.toFixed(2)}</span>
        </label>
      </div>
    </div>
  )
}

