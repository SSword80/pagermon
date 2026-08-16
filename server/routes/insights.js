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
  for (var bucket = firstBucket; bucket <= lastBucket; bucket += hour) buckets[bucket] = 0;
  rows.forEach(function (row) {
    var timestamp = Number(row.timestamp);
    if (!isNaN(timestamp)) {
      var bucket = Math.floor(timestamp / hour) * hour;
      if (buckets.hasOwnProperty(bucket)) buckets[bucket]++;
    }
  });
  return Object.keys(buckets).map(function (bucket) { return { timestamp: Number(bucket), count: buckets[bucket] }; });
}

function buildPeakActivity(activity) {
  if (!activity || !activity.length) return { timestamp: null, count: 0, averagePerHour: 0 };
  var total = activity.reduce(function (sum, point) { return sum + (Number(point.count) || 0); }, 0);
  var peak = activity.reduce(function (best, point) { return (Number(point.count) || 0) > (Number(best.count) || 0) ? point : best; }, activity[0]);
  return { timestamp: Number(peak.timestamp), count: Number(peak.count) || 0, averagePerHour: Math.round((total / activity.length) * 10) / 10 };
}

function buildAnomaly(activity, livePulseCount) {
  var hour = 60 * 60;
  var current = Number(livePulseCount || 0);
  var now = Math.floor(Date.now() / 1000);
  var currentWindowStart = now - hour;
  var previousWindows = (activity || []).filter(function (point) {
    var timestamp = Number(point.timestamp);
    return timestamp < Math.floor(currentWindowStart / hour) * hour;
  });

  if (previousWindows.length < 3) {
    return { status: 'normal', current: current, baseline: 0, percent: 0, sufficientData: false };
  }

  var total = previousWindows.reduce(function (sum, point) {
    return sum + (Number(point.count) || 0);
  }, 0);

  var baseline = total / previousWindows.length;
  var percent = baseline === 0
    ? (current === 0 ? 0 : 100)
    : Math.round(((current - baseline) / baseline) * 1000) / 10;

  var status = 'normal';
  if (baseline === 0) {
    status = current > 0 ? 'spike' : 'normal';
  } else if (current >= baseline * 1.5) {
    status = 'spike';
  } else if (current <= baseline * 0.5) {
    status = 'drop';
  }

  return {
    status: status,
    current: current,
    baseline: Math.round(baseline * 10) / 10,
    percent: percent,
    sufficientData: true
  };
}

function buildTrend(current, previous) {
  var currentCount = Number(current || 0);
  var previousCount = Number(previous || 0);
  var change = currentCount - previousCount;
  var percent = previousCount === 0 ? (currentCount === 0 ? 0 : 100) : Math.round((change / previousCount) * 1000) / 10;
  return { current: currentCount, previous: previousCount, change: change, percent: percent, direction: change > 0 ? 'up' : (change < 0 ? 'down' : 'flat') };
}

function buildCategoryTrends(currentRows, previousRows, field) {
  var previousMap = {};
  (previousRows || []).forEach(function (row) { previousMap[String(row[field])] = Number(row.count || 0); });
  return (currentRows || []).map(function (row) {
    var name = String(row[field]);
    var trend = buildTrend(Number(row.count || 0), previousMap[name] || 0);
    trend[field] = name;
    return trend;
  }).sort(function (a, b) { return Math.abs(b.percent) - Math.abs(a.percent); });
}

router.get('/', authHelper.isLoggedInMessages, function (req, res) {
  var range = getRange(req);
  if (!range) return res.status(400).json({ error: 'Invalid date range' });
  var duration = range.end - range.start;
  var previousRange = { start: range.start - duration, end: range.start };
  var messages = db('messages').where('timestamp', '>=', range.start).andWhere('timestamp', '<=', range.end);
  var livePulseStart = Math.floor(Date.now() / 1000) - (60 * 60);
  var livePulse = db('messages').where('timestamp', '>=', livePulseStart).andWhere('timestamp', '<=', Math.floor(Date.now() / 1000));
  var previousMessages = db('messages').where('timestamp', '>=', previousRange.start).andWhere('timestamp', '<', previousRange.end);

  Promise.all([
    messages.clone().count('* as count'),
    messages.clone().countDistinct('address as count'),
    messages.clone().countDistinct('alias_id as count'),
    messages.clone().select('messages.address').count('* as count').groupBy('messages.address').orderBy('count', 'desc').limit(10),
    messages.clone().leftJoin('capcodes', 'capcodes.id', 'messages.alias_id').select('capcodes.address', 'capcodes.alias', 'capcodes.agency').count('messages.id as count').whereNotNull('messages.alias_id').groupBy('capcodes.id', 'capcodes.address', 'capcodes.alias', 'capcodes.agency').orderBy('count', 'desc').limit(10),
    messages.clone().leftJoin('capcodes', 'capcodes.id', 'messages.alias_id').select(db.raw("COALESCE(NULLIF(capcodes.agency, ''), 'UNKNOWN') as agency")).count('messages.id as count').groupBy(db.raw("COALESCE(NULLIF(capcodes.agency, ''), 'UNKNOWN')")).orderBy('count', 'desc').limit(10),
    messages.clone().select('messages.source').count('messages.id as count').groupBy('messages.source').orderBy('count', 'desc').limit(10),
    messages.clone().select(db.raw("COALESCE(NULLIF(messages.protocol, ''), 'UNKNOWN') as protocol")).count('messages.id as count').groupBy(db.raw("COALESCE(NULLIF(messages.protocol, ''), 'UNKNOWN')")).orderBy('count', 'desc').limit(10),
    messages.clone().select('timestamp'),
    previousMessages.clone().count('* as count'),
    previousMessages.clone().leftJoin('capcodes', 'capcodes.id', 'messages.alias_id').select(db.raw("COALESCE(NULLIF(capcodes.agency, ''), 'UNKNOWN') as agency")).count('messages.id as count').groupBy(db.raw("COALESCE(NULLIF(capcodes.agency, ''), 'UNKNOWN')")),
    previousMessages.clone().select(db.raw("COALESCE(NULLIF(messages.protocol, ''), 'UNKNOWN') as protocol")).count('messages.id as count').groupBy(db.raw("COALESCE(NULLIF(messages.protocol, ''), 'UNKNOWN')")),
    livePulse.clone().count('* as count')
  ]).then(function (results) {
    var activity = buildActivity(results[8], range.start, range.end);
    res.status(200).json({ range: range, messages: Number(results[0][0].count || 0), uniqueAddresses: Number(results[1][0].count || 0), uniqueCapcodes: Number(results[2][0].count || 0), topAddresses: results[3], topCapcodes: results[4], topAgencies: results[5], topSources: results[6], topProtocols: results[7], livePulse: { count: Number(results[12][0].count || 0) }, anomaly: buildAnomaly(activity, results[12][0].count), activity: activity, peakActivity: buildPeakActivity(activity), trends: { period: buildTrend(results[0][0].count, results[9][0].count), agencies: buildCategoryTrends(results[5], results[10], 'agency'), protocols: buildCategoryTrends(results[7], results[11], 'protocol') } });
  }).catch(function (err) { res.status(500).json({ error: 'Unable to calculate insights' }); });
});

module.exports = router;
