var express = require('express');
var router = express.Router();
var db = require('../knex/knex.js');
var authHelper = require('../middleware/authhelper');

function getRange(req) {
  var now = Math.floor(Date.now() / 1000);
  var start = parseInt(req.query.start, 10);
  var end = parseInt(req.query.end, 10);

  if (isNaN(end)) end = now;
  if (isNaN(start)) start = end - (24 * 60 * 60);
  if (end <= start) return null;

  return { start: start, end: end };
}

router.get('/', authHelper.isLoggedInMessages, function (req, res) {
  var range = getRange(req);

  if (!range) {
    return res.status(400).json({ error: 'Invalid date range' });
  }

  var messages = db('messages')
    .where('timestamp', '>=', range.start)
    .andWhere('timestamp', '<=', range.end);

  Promise.all([
    messages.clone().count('* as count'),
    messages.clone().countDistinct('address as count'),
    messages.clone().countDistinct('alias_id as count'),
    messages.clone().select('address').count('* as count').groupBy('address').orderBy('count', 'desc').limit(10),
    messages.clone().select('source').count('* as count').groupBy('source').orderBy('count', 'desc').limit(10)
  ]).then(function (results) {
    res.status(200).json({
      range: range,
      messages: Number(results[0][0].count || 0),
      uniqueAddresses: Number(results[1][0].count || 0),
      uniqueCapcodes: Number(results[2][0].count || 0),
      topAddresses: results[3],
      topSources: results[4]
    });
  }).catch(function () {
    res.status(500).json({ error: 'Unable to calculate insights' });
  });
});

module.exports = router;
