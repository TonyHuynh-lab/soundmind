const express = require('express');
const session = require('express-session');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

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

  req.session.accessToken = tokenRes.data.access_token;
  req.session.refreshToken = tokenRes.data.refresh_token;

  res.send('Auth successful! You are logged in.');
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