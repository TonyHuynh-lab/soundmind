import { useEffect, useRef, useState, useCallback } from 'react'
import axios from 'axios'

const API = 'http://127.0.0.1:5000'

const PALETTE = [
  '#1db954', '#e74c3c', '#3498db', '#f39c12', '#9b59b6',
  '#1abc9c', '#e67e22', '#ff6b9d', '#00bcd4', '#cddc39',
]

const W = 760
const H = 540
const PAD = 28

function projectPoints(points) {
  if (!points.length) return []
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity
  for (const p of points) {
    if (p.x < xMin) xMin = p.x
    if (p.x > xMax) xMax = p.x
    if (p.y < yMin) yMin = p.y
    if (p.y > yMax) yMax = p.y
  }
  const xRange = xMax - xMin || 1
  const yRange = yMax - yMin || 1
  return points.map(p => ({
    ...p,
    cx: PAD + ((p.x - xMin) / xRange) * (W - 2 * PAD),
    cy: PAD + ((p.y - yMin) / yRange) * (H - 2 * PAD),
  }))
}

function buildGenreColors(points) {
  const counts = {}
  for (const p of points) counts[p.genre] = (counts[p.genre] || 0) + 1
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([g]) => g)
  const map = {}
  top.forEach((g, i) => { map[g] = PALETTE[i] })
  return map
}

export default function UMAPPlot() {
  const canvasRef = useRef(null)
  const [status, setStatus] = useState('idle')
  const [projected, setProjected] = useState([])
  const [genreColors, setGenreColors] = useState({})
  const [tooltip, setTooltip] = useState(null)

  function load() {
    setStatus('loading')
    axios.get(`${API}/api/umap`, { withCredentials: true, timeout: 120000 })
      .then(res => {
        const pts = res.data.points || []
        const colors = buildGenreColors(pts)
        setGenreColors(colors)
        setProjected(projectPoints(pts))
        setStatus('ready')
      })
      .catch(() => setStatus('error'))
  }

  useEffect(() => {
    if (status !== 'ready' || !canvasRef.current) return
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')

    ctx.fillStyle = '#0d0d0d'
    ctx.fillRect(0, 0, W, H)

    for (const pt of projected) {
      const color = genreColors[pt.genre] || '#2a2a2a'
      ctx.beginPath()
      ctx.arc(pt.cx, pt.cy, 2.5, 0, Math.PI * 2)
      ctx.fillStyle = color + 'bb'
      ctx.fill()
    }
  }, [status, projected, genreColors])

  const handleMouseMove = useCallback((e) => {
    if (status !== 'ready') return
    const rect = canvasRef.current.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    let nearest = null, minDist = Infinity
    for (const pt of projected) {
      const dx = pt.cx - mx, dy = pt.cy - my
      const d = dx * dx + dy * dy
      if (d < minDist) { minDist = d; nearest = pt }
    }
    setTooltip(minDist < 225 ? { x: mx, y: my, pt: nearest } : null)
  }, [status, projected])

  return (
    <div>
      {status === 'idle' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem', padding: '4rem 2rem', color: '#888' }}>
          <p style={{ margin: 0, fontSize: '0.95rem' }}>
            Visualize 5,000 tracks in 2D audio-feature space, colored by genre.
          </p>
          <p style={{ margin: 0, fontSize: '0.82rem', color: '#555' }}>
            First run takes ~20 seconds. Result is cached until FastAPI restarts.
          </p>
          <button onClick={load} style={{
            marginTop: '0.5rem',
            background: '#1db954', color: '#fff', border: 'none',
            padding: '0.6rem 1.6rem', borderRadius: '20px', cursor: 'pointer',
            fontWeight: '600', fontSize: '0.9rem',
          }}>
            Generate Map
          </button>
        </div>
      )}

      {status === 'loading' && (
        <p style={{ color: '#888', padding: '2rem', fontSize: '0.9rem' }}>
          Computing UMAP… this takes ~20 seconds on first run.
        </p>
      )}

      {status === 'error' && (
        <div style={{ padding: '2rem' }}>
          <p style={{ color: '#e74c3c', marginBottom: '0.75rem' }}>
            Failed — make sure <code style={{ background: '#282828', padding: '0.1rem 0.4rem', borderRadius: '4px' }}>umap-learn</code> is installed and FastAPI is running.
          </p>
          <button onClick={load} style={{
            background: '#282828', color: '#ccc', border: 'none',
            padding: '0.4rem 1rem', borderRadius: '12px', cursor: 'pointer', fontSize: '0.85rem',
          }}>Retry</button>
        </div>
      )}

      {status === 'ready' && (
        <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'flex-start' }}>
          <div style={{ position: 'relative', cursor: 'crosshair', flexShrink: 0 }}>
            <canvas
              ref={canvasRef}
              width={W}
              height={H}
              onMouseMove={handleMouseMove}
              onMouseLeave={() => setTooltip(null)}
              style={{ borderRadius: '8px', display: 'block' }}
            />
            {tooltip && (
              <div style={{
                position: 'absolute',
                left: tooltip.x + 14,
                top: tooltip.y - 10,
                background: '#1e1e1e',
                border: '1px solid #383838',
                padding: '0.45rem 0.75rem',
                borderRadius: '7px',
                fontSize: '0.8rem',
                pointerEvents: 'none',
                maxWidth: '220px',
                zIndex: 10,
                boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
              }}>
                <div style={{ fontWeight: '600', color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {tooltip.pt.song}
                </div>
                <div style={{ color: '#aaa', marginTop: '0.15rem' }}>{tooltip.pt.artists}</div>
                <div style={{
                  color: genreColors[tooltip.pt.genre] || '#888',
                  marginTop: '0.25rem', fontSize: '0.75rem',
                }}>
                  {tooltip.pt.genre}
                </div>
              </div>
            )}
          </div>

          <div style={{ paddingTop: '0.5rem' }}>
            <div style={{ color: '#555', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.6rem' }}>
              Top genres
            </div>
            {Object.entries(genreColors).map(([genre, color]) => (
              <div key={genre} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.4rem' }}>
                <div style={{ width: '9px', height: '9px', borderRadius: '50%', background: color, flexShrink: 0 }} />
                <span style={{ fontSize: '0.78rem', color: '#ccc', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '130px' }}>
                  {genre}
                </span>
              </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.2rem' }}>
              <div style={{ width: '9px', height: '9px', borderRadius: '50%', background: '#2a2a2a', border: '1px solid #444', flexShrink: 0 }} />
              <span style={{ fontSize: '0.78rem', color: '#555' }}>other</span>
            </div>
            <div style={{ marginTop: '1.5rem', color: '#444', fontSize: '0.72rem' }}>
              {projected.length.toLocaleString()} tracks
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
