const mongoose = require('mongoose');

const TrackSchema = new mongoose.Schema({
  spotifyId:   { type: String, required: true, unique: true },
  name:        { type: String, required: true },
  artists:     [{ name: String, id: String }],
  album:       { type: String },
  previewUrl:  { type: String },
  features: {
    tempo:        Number,
    energy:       Number,
    valence:      Number,
    danceability: Number,
    acousticness: Number,
    instrumentalness: Number,
    loudness:     Number,
    speechiness:  Number,
    key:          Number,
  }
}, { timestamps: true });

module.exports = mongoose.model('Track', TrackSchema);