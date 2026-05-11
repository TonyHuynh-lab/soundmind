const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  spotifyId:    { type: String, required: true, unique: true },
  displayName:  { type: String },
  email:        { type: String },
  topTracks:    [{ type: String }], // array of spotifyIds
  listenHistory:[{ type: String }], // array of spotifyIds
}, { timestamps: true });

module.exports = mongoose.model('User', UserSchema);