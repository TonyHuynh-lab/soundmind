const dns = require('dns');

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
  res.redirect('http://127.0.0.1:5173/dashboard');
});

// Step 3: Test — fetch current user's top tracks
app.get('/api/top-tracks', async (req, res) => {
  const { data } = await axios.get('https://api.spotify.com/v1/me/top/tracks?limit=20', {
    headers: { Authorization: `Bearer ${req.session.accessToken}` }
  });
  res.json(data);
});

app.get('/api/recommend', async (req, res) => {
  const { song, artist, n = 10, trackId, genre } = req.query;
  if (!song || !artist) return res.status(400).json({ error: 'song and artist required' });

  const body = { Song: song, Artists: artist, n: parseInt(n) };
  if (genre) body.Genre = genre;

  // Fetch Spotify audio features for Tier 2 fallback
  if (trackId && req.session.accessToken) {
    try {
      const { data: f } = await axios.get(
        `https://api.spotify.com/v1/audio-features/${trackId}`,
        { headers: { Authorization: `Bearer ${req.session.accessToken}` } }
      );
      body.Danceability     = f.danceability;
      body.Energy           = f.energy;
      body.Loudness         = f.loudness;
      body.Speechiness      = f.speechiness;
      body.Acousticness     = f.acousticness;
      body.Instrumentalness = f.instrumentalness;
      body.Valence          = f.valence;
      body.Tempo            = f.tempo;
    } catch {
      // feature fetch failed — FastAPI will use Tier 3 genre fallback
    }
  }

  try {
    const { data } = await axios.post('http://localhost:8000/recommend', body);
    res.json(data);
  } catch (err) {
    console.error('FastAPI error:', err.response?.data ?? err.message);
    const status = err.response?.status || 500;
    const detail = err.response?.data?.detail ?? err.response?.data ?? err.message ?? 'Recommendation failed';
    res.status(status).json({ error: detail });
  }
});

app.post('/api/feedback', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'not authenticated' });
  const { trackId, action, context, source } = req.body;
  if (!trackId || !action) return res.status(400).json({ error: 'trackId and action required' });
  await Feedback.create({ userId: req.session.userId, trackId, action, context, source });
  res.json({ ok: true });
});

app.listen(process.env.PORT, () => {
  console.log(`Server running on port ${process.env.PORT}`);
});