const mongoose = require('mongoose');

const FeedbackSchema = new mongoose.Schema({
  userId:  { type: String, required: true },
  trackId: { type: String, required: true },
  action:  { type: String, enum: ['play', 'skip', 'like'], required: true },
  context: { type: String, enum: ['top-tracks', 'recommendations'] },
  source:  { type: String, enum: ['knn', 'feature', 'genre'] },
}, { timestamps: true });

module.exports = mongoose.model('Feedback', FeedbackSchema);
