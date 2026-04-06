const dns = require('dns');

// Set DNS servers to Google DNS to fix SRV lookup issues
dns.setServers(['8.8.8.8', '8.8.4.4']);

require('dotenv').config();

const connectDB = require('./db');
const Track = require('./models/Track');
const User = require('./models/User');

// Connect to MongoDB at startup
connectDB();

const express = require('express');
const session = require('express-session');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors({ origin: 'http://localhost:3000', credentials: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false
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
      { upsert: true, new: true }
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
    { upsert: true, new: true }
  );

  req.session.userId = profile.id;
  res.send('Auth successful! User and tracks saved to MongoDB.');
});

// Step 3: Test — fetch current user's top tracks
app.get('/api/top-tracks', async (req, res) => {
  const { data } = await axios.get('https://api.spotify.com/v1/me/top/tracks?limit=20', {
    headers: { Authorization: `Bearer ${req.session.accessToken}` }
  });
  res.json(data);
});

app.listen(process.env.PORT, () => {
  console.log(`Server running on port ${process.env.PORT}`);
});