const dns = require('dns');
const path = require('path');

// set DNS servers to Google DNS to fix SRV lookup issues
dns.setServers(['8.8.8.8', '8.8.4.4']);

require('dotenv').config();

const connectDB = require('./db');
const Track = require('./models/Track');
const User = require('./models/User');
const Feedback = require('./models/Feedback');

// connect to MongoDB at startup
connectDB();

const express = require('express');
const session = require('express-session');
const { MongoStore } = require('connect-mongo');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors({ origin: ['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:5173'], credentials: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGO_URI }),
}));

// Step 1: Redirect user to Spotify login
app.get('/auth/login', (req, res) => {
  const scopes = [
    'user-top-read',
    'user-read-recently-played',
    'user-library-read',
    'streaming'
  ].join(' ');

  const authURL = new URL('https://accounts.spotify.com/authorize');
  authURL.searchParams.set('response_type', 'code');
  authURL.searchParams.set('client_id', process.env.SPOTIFY_CLIENT_ID);
  authURL.searchParams.set('scope', scopes);
  authURL.searchParams.set('redirect_uri', process.env.SPOTIFY_REDIRECT_URI);

  res.redirect(authURL.toString());
});

// Step 2: Spotify redirects here with a code
app.get('/callback', async (req, res) => {
  const code = req.query.code;

  const tokenRes = await axios.post('https://accounts.spotify.com/api/token',
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
    }), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(
          process.env.SPOTIFY_CLIENT_ID + ':' + process.env.SPOTIFY_CLIENT_SECRET
        ).toString('base64')
      }
    });

  const accessToken = tokenRes.data.access_token;
  req.session.accessToken = accessToken;

  const headers = { Authorization: `Bearer ${accessToken}` };

  // Fetch user profile
  const { data: profile } = await axios.get('https://api.spotify.com/v1/me', { headers });

  // Fetch top tracks
  const { data: topData } = await axios.get('https://api.spotify.com/v1/me/top/tracks?limit=20', { headers });
  const tracks = topData.items;

  // Save tracks WITHOUT audio features for now
  const trackIds = [];
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];

    await Track.findOneAndUpdate(
      { spotifyId: t.id },
      {
        spotifyId:  t.id,
        name:       t.name,
        artists:    t.artists.map(a => ({ name: a.name, id: a.id })),
        album:      t.album.name,
        previewUrl: t.preview_url,
      },
      { upsert: true, returnDocument: 'after' }
    );
    trackIds.push(t.id);
  }

  // Save or update user
  await User.findOneAndUpdate(
    { spotifyId: profile.id },
    {
      spotifyId:   profile.id,
      displayName: profile.display_name,
      email:       profile.email,
      topTracks:   trackIds,
    },
    { upsert: true, returnDocument: 'after' }
  );

  req.session.userId = profile.id;
  res.redirect('/dashboard');
});

// Step 3: Test — fetch current user's top tracks
app.get('/api/top-tracks', async (req, res) => {
  const { data } = await axios.get('https://api.spotify.com/v1/me/top/tracks?limit=20', {
    headers: { Authorization: `Bearer ${req.session.accessToken}` }
  });
  res.json(data);
});

app.post('/api/recommend', async (req, res) => {
  const { seeds, n = 10 } = req.body;
  if (!seeds?.length) return res.status(400).json({ error: 'seeds required' });

  const top5 = seeds.slice(0, 5);

  // Batch-fetch Spotify audio features for all seeds in one API call
  let featuresMap = {};
  if (req.session.accessToken) {
    try {
      const ids = top5.map(s => s.trackId).filter(Boolean).join(',');
      const { data: af } = await axios.get(
        `https://api.spotify.com/v1/audio-features?ids=${ids}`,
        { headers: { Authorization: `Bearer ${req.session.accessToken}` } }
      );
      for (const f of af.audio_features || []) {
        if (f) featuresMap[f.id] = f;
      }
    } catch { /* proceed without features */ }
  }

  function withFeatures(body, trackId) {
    const f = featuresMap[trackId];
    if (!f) return body;
    return {
      ...body,
      Danceability: f.danceability, Energy: f.energy,       Loudness: f.loudness,
      Speechiness:  f.speechiness,  Acousticness: f.acousticness,
      Instrumentalness: f.instrumentalness, Valence: f.valence, Tempo: f.tempo,
    };
  }

  // Tier 1: KNN — try each of the top 5 seeds, return on first dataset hit
  for (const seed of top5) {
    try {
      const body = withFeatures({ Song: seed.song, Artists: seed.artist, n }, seed.trackId);
      const { data } = await axios.post('http://localhost:8000/recommend', body);
      if (data.fallback === 'knn') return res.json(data);
    } catch { /* try next seed */ }
  }

  // Tier 2 & 3: feature/genre fallback on seeds[0] — FastAPI handles internally
  const seed0 = top5[0];
  try {
    const body = withFeatures({ Song: seed0.song, Artists: seed0.artist, n }, seed0.trackId);
    const { data } = await axios.post('http://localhost:8000/recommend', body);
    return res.json(data);
  } catch (err) {
    console.error('FastAPI error:', err.response?.data ?? err.message);
    const status = err.response?.status || 500;
    const detail = err.response?.data?.detail ?? err.response?.data ?? err.message ?? 'Recommendation failed';
    return res.status(status).json({ error: detail });
  }
});

app.post('/api/train-mf', async (req, res) => {
  try {
    const { data } = await axios.post('http://localhost:8000/train-mf');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.detail ?? 'Training failed' });
  }
});

app.get('/api/recommend-mf', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'not authenticated' });
  try {
    const { data } = await axios.post('http://localhost:8000/recommend-mf', {
      userId: req.session.userId,
      n: 10,
    });
    res.json(data);
  } catch (err) {
    console.error('MF error:', err.response?.data ?? err.message);
    res.status(500).json({ error: 'MF recommendation failed' });
  }
});

app.get('/api/umap', async (req, res) => {
  try {
    const { data } = await axios.get('http://localhost:8000/umap')
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: 'UMAP unavailable' })
  }
});

app.post('/api/feedback', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'not authenticated' });
  const { trackId, action, context, source } = req.body;
  if (!trackId || !action) return res.status(400).json({ error: 'trackId and action required' });
  await Feedback.create({ userId: req.session.userId, trackId, action, context, source });
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, '../client/dist')));
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/dist/index.html'));
});

app.listen(process.env.PORT, () => {
  console.log(`Server running on port ${process.env.PORT}`);
});