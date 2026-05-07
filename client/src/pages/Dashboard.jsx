import { useEffect, useState } from 'react'
import axios from 'axios'
import UMAPPlot from '../components/UMAPPlot'

const API = 'http://127.0.0.1:5000'

function FeedbackButtons({ onPlay, onSkip, onLike }) {
  return (
    <div style={{ display: 'flex', gap: '0.4rem', flexShrink: 0 }}>
      {[['▶', onPlay, '#1db954'], ['✕', onSkip, '#888'], ['♥', onLike, '#e74c3c']].map(([icon, handler, color]) => (
        <button key={icon} onClick={handler} style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: '#555', fontSize: '0.85rem', padding: '0.2rem 0.35rem',
          borderRadius: '4px',
        }}
          onMouseEnter={e => e.currentTarget.style.color = color}
          onMouseLeave={e => e.currentTarget.style.color = '#555'}
        >{icon}</button>
      ))}
    </div>
  )
}

export default function Dashboard() {
  const [tracks, setTracks]         = useState([])
  const [tab, setTab]               = useState('top')

  const [recs, setRecs]             = useState(null)
  const [recsLoading, setRecsLoad]  = useState(false)
  const [recsError, setRecsError]   = useState(null)

  const [forYou, setForYou]         = useState(null)
  const [fyLoading, setFyLoad]      = useState(false)
  const [fyError, setFyError]       = useState(null)

  useEffect(() => {
    axios.get(`${API}/api/top-tracks`, { withCredentials: true })
      .then(res => setTracks(res.data.items || []))
      .catch(console.error)
  }, [])

  useEffect(() => {
    if (tab !== 'recommendations' || !tracks.length || recs) return
    setRecsLoad(true)
    setRecsError(null)
    axios.post(`${API}/api/recommend`, {
      seeds: tracks.slice(0, 5).map(t => ({
        song: t.name,
        artist: t.artists[0].name,
        trackId: t.id,
      })),
      n: 10,
    }, { withCredentials: true })
      .then(res => setRecs(res.data))
      .catch(err => setRecsError(err.response?.data?.error || 'No recommendations found'))
      .finally(() => setRecsLoad(false))
  }, [tab, tracks])

  useEffect(() => {
    if (tab !== 'foryou' || forYou) return
    setFyLoad(true)
    setFyError(null)
    axios.get(`${API}/api/recommend-mf`, { withCredentials: true })
      .then(res => setForYou(res.data))
      .catch(() => setFyError('Could not load personalized recommendations'))
      .finally(() => setFyLoad(false))
  }, [tab])

  function sendFeedback(trackId, action, context, source) {
    axios.post(`${API}/api/feedback`, { trackId, action, context, source }, { withCredentials: true })
      .catch(console.error)
  }

  const tabs = [['top', 'Top Tracks'], ['recommendations', 'Recommendations'], ['foryou', 'For You'], ['explore', 'Explore']]

  return (
    <div style={{ padding: '2rem', fontFamily: 'DM Sans, sans-serif', background: '#121212', minHeight: '100vh', color: '#fff' }}>
      <h1 style={{ marginBottom: '1.5rem', fontSize: '1.8rem' }}>Your Dashboard</h1>

      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.5rem' }}>
        {tabs.map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)} style={{
            padding: '0.5rem 1.25rem',
            borderRadius: '20px',
            border: 'none',
            cursor: 'pointer',
            background: tab === key ? '#1db954' : '#282828',
            color: '#fff',
            fontWeight: tab === key ? '600' : '400',
            fontSize: '0.9rem',
          }}>
            {label}
          </button>
        ))}
      </div>

      {/* ── Top Tracks ── */}
      {tab === 'top' && (
        <div>
          {tracks.map((track, i) => (
            <div key={track.id} style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '0.6rem 0', borderBottom: '1px solid #282828' }}>
              <span style={{ color: '#888', width: '1.5rem', textAlign: 'right', flexShrink: 0 }}>{i + 1}</span>
              {track.album.images[2] && (
                <img src={track.album.images[2].url} alt="" style={{ width: '40px', height: '40px', borderRadius: '4px', flexShrink: 0 }} />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: '500' }}>{track.name}</div>
                <div style={{ color: '#888', fontSize: '0.85rem' }}>{track.artists.map(a => a.name).join(', ')}</div>
              </div>
              <FeedbackButtons
                onPlay={() => sendFeedback(track.id, 'play', 'top-tracks')}
                onSkip={() => sendFeedback(track.id, 'skip', 'top-tracks')}
                onLike={() => sendFeedback(track.id, 'like', 'top-tracks')}
              />
            </div>
          ))}
        </div>
      )}

      {/* ── Recommendations ── */}
      {tab === 'recommendations' && (
        <div>
          {recsLoading && <p style={{ color: '#888' }}>Loading recommendations…</p>}
          {recsError   && <p style={{ color: '#e74c3c' }}>{recsError}</p>}
          {recs && (
            <>
              <p style={{ color: '#888', marginBottom: '0.5rem', fontSize: '0.9rem' }}>
                Based on <strong style={{ color: '#fff' }}>{recs.seed_track}</strong> by {recs.seed_artist}
              </p>
              {recs.fallback !== 'knn' && (
                <p style={{ color: '#f39c12', fontSize: '0.78rem', marginBottom: '1rem' }}>
                  {recs.fallback === 'feature'
                    ? 'Track not in catalog — matched by audio features'
                    : 'Track not in catalog — showing genre picks'}
                </p>
              )}
              {recs.recommendations.map((rec, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.6rem 0', borderBottom: '1px solid #282828' }}>
                  <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', minWidth: 0 }}>
                    <span style={{ color: '#888', width: '1.5rem', textAlign: 'right', flexShrink: 0 }}>{i + 1}</span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: '500' }}>{rec.Song}</div>
                      <div style={{ color: '#888', fontSize: '0.85rem' }}>{rec.Artists} · {rec.Genre}</div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
                    <span style={{ color: '#1db954', fontWeight: '600', fontSize: '0.85rem' }}>
                      {Math.round(rec.Similarity * 100)}% match
                    </span>
                    <FeedbackButtons
                      onPlay={() => sendFeedback(rec.Song, 'play', 'recommendations', recs.fallback)}
                      onSkip={() => sendFeedback(rec.Song, 'skip', 'recommendations', recs.fallback)}
                      onLike={() => sendFeedback(rec.Song, 'like', 'recommendations', recs.fallback)}
                    />
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {/* ── For You (MF) ── */}
      {tab === 'foryou' && (
        <div>
          {fyLoading && <p style={{ color: '#888' }}>Loading your picks…</p>}
          {fyError   && <p style={{ color: '#e74c3c' }}>{fyError}</p>}
          {forYou && forYou.message === 'not_trained' && (
            <p style={{ color: '#f39c12', fontSize: '0.9rem' }}>
              Run <code style={{ background: '#282828', padding: '0.1rem 0.4rem', borderRadius: '4px' }}>python train_mf.py</code> in <code style={{ background: '#282828', padding: '0.1rem 0.4rem', borderRadius: '4px' }}>ml-service/</code> to train the model.
            </p>
          )}
          {forYou && forYou.message === 'no_feedback' && (
            <p style={{ color: '#888', fontSize: '0.9rem' }}>
              Interact with tracks (▶ ♥) to get personalized picks.
            </p>
          )}
          {forYou && forYou.recommendations.length > 0 && (() => {
            const scores = forYou.recommendations.map(r => r.Similarity)
            const maxScore = Math.max(...scores)
            const showPct = isFinite(maxScore) && maxScore > 0
            return forYou.recommendations.map((rec, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.6rem 0', borderBottom: '1px solid #282828' }}>
                <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', minWidth: 0 }}>
                  <span style={{ color: '#888', width: '1.5rem', textAlign: 'right', flexShrink: 0 }}>{i + 1}</span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: '500' }}>{rec.Song}</div>
                    <div style={{ color: '#888', fontSize: '0.85rem' }}>{rec.Artists} · {rec.Genre}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
                  {showPct && (
                    <span style={{ color: '#1db954', fontWeight: '600', fontSize: '0.85rem' }}>
                      {Math.round((rec.Similarity / maxScore) * 100)}% relevant
                    </span>
                  )}
                  <FeedbackButtons
                    onPlay={() => sendFeedback(rec.Song, 'play', 'foryou', 'mf')}
                    onSkip={() => sendFeedback(rec.Song, 'skip', 'foryou', 'mf')}
                    onLike={() => sendFeedback(rec.Song, 'like', 'foryou', 'mf')}
                  />
                </div>
              </div>
            ))
          })()}
        </div>
      )}

      {/* ── Explore (UMAP) ── */}
      {tab === 'explore' && <UMAPPlot />}
    </div>
  )
}
