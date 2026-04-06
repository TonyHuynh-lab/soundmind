import { useEffect, useState } from 'react'
import axios from 'axios'

export default function Dashboard() {
  const [tracks, setTracks] = useState([])
  const [tab, setTab] = useState('top')

  useEffect(() => {
    axios.get('http://127.0.0.1:5000/api/top-tracks', { withCredentials: true })
      .then(res => setTracks(res.data.items || []))
      .catch(console.error)
  }, [])

  return (
    <div>
      {/* Header, stats, tab bar, track list — mirror the preview above */}
      {/* Recommendations tab shows placeholder until ML service is ready */}
    </div>
  )
}