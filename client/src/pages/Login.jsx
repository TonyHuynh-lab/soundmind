import './Login.css'

export default function Login() {
  const handleLogin = () => {
    window.location.href = 'http://127.0.0.1:5000/auth/login'
  }

  return (
    <div className="login-wrap">
      <div className="login-logo">soundmind</div>
      <p className="login-sub">your music, understood</p>
      <div className="login-card">
        <h2 className="login-title">Welcome back</h2>
        <p className="login-desc">Connect your Spotify account to get personalized recommendations powered by ML.</p>
        <button className="login-btn" onClick={handleLogin}>
          Continue with Spotify
        </button>
      </div>
    </div>
  )
}