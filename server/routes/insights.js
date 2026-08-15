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

function buildActivity(rows, start, end) {
  var hour = 60 * 60;
  var firstBucket = Math.floor(start / hour) * hour;
  var lastBucket = Math.floor(end / hour) * hour;
  var buckets = {};

  for (var bucket = firstBucket; bucket <= lastBucket; bucket += hour) {
    buckets[bucket] = 0;
  }

  rows.forEach(function (row) {
    var timestamp = Number(row.timestamp);
    if (!isNaN(timestamp)) {
      var bucket = Math.floor(timestamp / hour) * hour;
      if (buckets.hasOwnProperty(bucket)) buckets[bucket]++;
    }
  });

  return Object.keys(buckets).map(function (bucket) {
    return {
      timestamp: Number(bucket),
      count: buckets[bucket]
    };
  });
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
    messages.clone()
      .select('messages.address')
      .count('* as count')
      .groupBy('messages.address')
      .orderBy('count', 'desc')
      .limit(10),
    messages.clone()
      .leftJoin('capcodes', 'capcodes.id', 'messages.alias_id')
      .select('capcodes.address', 'capcodes.alias', 'capcodes.agency')
      .count('messages.id as count')
      .whereNotNull('messages.alias_id')
      .groupBy('capcodes.id', 'capcodes.address', 'capcodes.alias', 'capcodes.agency')
      .orderBy('count', 'desc')
      .limit(10),
    messages.clone()
      .leftJoin('capcodes', 'capcodes.id', 'messages.alias_id')
      .select(db.raw("COALESCE(NULLIF(capcodes.agency, ''), 'UNKNOWN') as agency"))
      .count('messages.id as count')
      .groupBy(db.raw("COALESCE(NULLIF(capcodes.agency, ''), 'UNKNOWN')"))
      .orderBy('count', 'desc')
      .limit(10),
    messages.clone()
      .select('messages.source')
      .count('messages.id as count')
      .groupBy('messages.source')
      .orderBy('count', 'desc')
      .limit(10),
    messages.clone().select('timestamp')
  ]).then(function (results) {
    res.status(200).json({
      range: range,
      messages: Number(results[0][0].count || 0),
      uniqueAddresses: Number(results[1][0].count || 0),
      uniqueCapcodes: Number(results[2][0].count || 0),
      topAddresses: results[3],
      topCapcodes: results[4],
      topAgencies: results[5],
      topSources: results[6],
      activity: buildActivity(results[7], range.start, range.end)
    });
  }).catch(function (err) {
    res.status(500).json({ error: 'Unable to calculate insights' });
  });
});

module.exports = router;
