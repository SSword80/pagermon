var express = require('express');
var bodyParser = require('body-parser');
var router = express.Router();
var basicAuth = require('express-basic-auth');
var bcrypt = require('bcryptjs');
var util = require('util');
var _ = require('underscore');
var pluginHandler = require('../plugins/pluginHandler');
var logger = require('../log');
var db = require('../knex/knex.js');
var converter = require('json-2-csv');

var nconf = require('nconf');

var confFile = './config/config.json';
nconf.file({ file: confFile });
nconf.load();

router.use(bodyParser.json());       // to support JSON-encoded bodies
router.use(bodyParser.urlencoded({     // to support URL-encoded bodies
  extended: true
}));

const passport = require('../auth/local');
var authHelper = require('../middleware/authhelper')

router.use(function (req, res, next) {
  res.locals.login = req.isAuthenticated();
  res.locals.user = req.user || false;
  next();
});

// defaults
var initData = {};
initData.limit = nconf.get('messages:defaultLimit');
initData.replaceText = nconf.get('messages:replaceText');
initData.currentPage = 0;
initData.pageCount = 0;
initData.msgCount = 0;
initData.offset = 0;

// auth variables
var HideCapcode = nconf.get('messages:HideCapcode');
var apiSecurity = nconf.get('messages:apiSecurity');
var dbtype = nconf.get('database:type');

// dupe init
var msgBuffer = [];


router.route('/messages')
  .get(authHelper.isLoggedInMessages, function (req, res, next) {
    nconf.load();
    console.time('init');
    var pdwMode = nconf.get('messages:pdwMode');
    var adminShow = nconf.get('messages:adminShow');
    var maxLimit = nconf.get('messages:maxLimit');
    var defaultLimit = nconf.get('messages:defaultLimit');
    var HideCapcode = nconf.get('messages:HideCapcode');

    initData.replaceText = nconf.get('messages:replaceText');
    if (typeof req.query.page !== 'undefined') {
      var page = parseInt(req.query.page, 10);
      if (page > 0) {
        initData.currentPage = page - 1;
      } else {
        initData.currentPage = 0;
      }
    }
    if (req.query.limit && req.query.limit <= maxLimit) {
      initData.limit = parseInt(req.query.limit, 10);
    } else {
      initData.limit = parseInt(defaultLimit, 10);
    }
    if (pdwMode) {
      if (adminShow && req.isAuthenticated() && req.user.role == 'admin') {
        var subquery = db.from('capcodes').where('ignore', '=', 1).select('id')
      } else {
        var subquery = db.from('capcodes').where('ignore', '=', 0).select('id')
      }
    } else {
      var subquery = db.from('capcodes').where('ignore', '=', 1).select('id')
    }
    db.from('messages').where(function () {
      if (pdwMode) {
        if (adminShow && req.isAuthenticated() && req.user.role == 'admin') {
          this.from('messages').where('alias_id', 'not in', subquery).orWhereNull('alias_id')
        } else {
          this.from('messages').where('alias_id', 'in', subquery)
        }
      } else {
        this.from('messages').where('alias_id', 'not in', subquery).orWhereNull('alias_id')
      }
    }).count('* as msgcount')
      .then(function (initcount) {
        var count = initcount[0]
        if (count) {
          initData.msgCount = count.msgcount;
          initData.pageCount = Math.ceil(initData.msgCount / initData.limit);
          if (initData.currentPage > initData.pageCount) {
            initData.currentPage = 0;
          }
          initData.offset = initData.limit * initData.currentPage;
          if (initData.offset < 0) {
            initData.offset = 0;
          }
          initData.offsetEnd = initData.offset + initData.limit;
          console.timeEnd('init');
          console.time('sql');

          var result = [];
          var rowCount

          db.from('messages')
            .select('messages.*', 'capcodes.alias', 'capcodes.agency', 'capcodes.icon', 'capcodes.color', 'capcodes.ignore', db.raw('CASE WHEN NOT capcodes.address = messages.address THEN 1 ELSE 0 END as wildcard'))
            .modify(function (queryBuilder) {
              if (pdwMode) {
                if (adminShow && req.isAuthenticated() && req.user.role == 'admin') {
                  queryBuilder.leftJoin('capcodes', 'capcodes.id', '=', 'messages.alias_id').where('capcodes.ignore', 0).orWhereNull('capcodes.ignore')
                } else {
                  queryBuilder.innerJoin('capcodes', 'capcodes.id', '=', 'messages.alias_id').where('capcodes.ignore', 0)
                }
              } else {
                queryBuilder.leftJoin('capcodes', 'capcodes.id', '=', 'messages.alias_id').where('capcodes.ignore', 0).orWhereNull('capcodes.ignore')
              }
            })
            .orderBy('messages.timestamp', 'desc')
            .limit(initData.limit)
            .offset(initData.offset)
            .then(rows => {
              rowCount = rows.length
              for (row of rows) {
                //outRow = JSON.parse(newrow);
                if (HideCapcode) {
                  if (!req.isAuthenticated() || (req.isAuthenticated() && req.user.role == 'user')) {
                    row = {
                      "id": row.id,
                      "message": row.message,
                      "source": row.source,
                      "timestamp": row.timestamp,
                      "alias_id": row.alias_id,
                      "alias": row.alias,
                      "agency": row.agency,
                      "icon": row.icon,
                      "color": row.color,
                      "ignore": row.ignore
                    };
                  }
                }
                if (row) {
                  result.push(row);
                } else {
                  logger.main.info('empty results');
                }
              }
            })
            .catch(err => {
              logger.main.error(err);
            })
            .finally(() => {
              if (rowCount > 0) {
                console.timeEnd('sql');
                //var limitResults = result.slice(initData.offset, initData.offsetEnd);
                console.time('send');
                res.status(200).json({ 'init': initData, 'messages': result });
                console.timeEnd('send');
              } else {
                res.status(200).json({ 'init': {}, 'messages': [] });
              }
            });
        }
      });
  })
  .post(authHelper.isAdmin, function (req, res, next) {
    nconf.load();
    if (req.body.address && req.body.message) {
      var dbtype = nconf.get('database:type');
      var filterDupes = nconf.get('messages:duplicateFiltering');
      var dupeLimit = nconf.get('messages:duplicateLimit') || 0; // default 0
      var dupeTime = nconf.get('messages:duplicateTime') || 0; // default 0
      var pdwMode = nconf.get('messages:pdwMode');
      var adminShow = nconf.get('messages:adminShow');
      var data = req.body;
      data.pluginData = {};

      if (filterDupes) {
        // this is a bad solution and tech debt that will bite us in the ass if we ever go HA, but that's a problem for future me and that guy's a dick
        var datetime = data.datetime || 1;
        var timeDiff = datetime - dupeTime;
        // if duplicate filtering is enabled, we want to populate the message buffer and check for duplicates within the limits
        var matches = _.where(msgBuffer, { message: data.message, address: data.address });
        if (matches.length > 0) {
          if (dupeTime != 0) {
            // search the matching messages and see if any match the time constrain
            var timeFind = _.find(matches, function (msg) { return msg.datetime > timeDiff; });
            if (timeFind) {
              logger.main.info(util.format('Ignoring duplicate: %o', data.message));
              res.status(200);
              return res.send('Ignoring duplicate');
            }
          } else {
            // if no dupeTime then just end the search now, we have matches
            logger.main.info(util.format('Ignoring duplicate: %o', data.message));
            res.status(200);
            return res.send('Ignoring duplicate');
          }
        }
        // no matches, maintain the array
        var dupeArrayLimit = dupeLimit;
        if (dupeArrayLimit == 0) {
          dupeArrayLimit == 25; // should provide sufficient buffer, consider increasing if duplicates appear when users have no dupeLimit
        }
        if (msgBuffer.length > dupeArrayLimit) {
          msgBuffer.shift();
        }
        msgBuffer.push({ message: data.message, datetime: data.datetime, address: data.address });
      }

      // send data to pluginHandler before proceeding
      logger.main.debug('beforeMessage start');
      pluginHandler.handle('message', 'before', data, function (response) {
        logger.main.debug(util.format('%o', response));
        logger.main.debug('beforeMessage done');
        if (response && response.pluginData) {
          // only set data to the response if it's non-empty and still contains the pluginData object
          data = response;
        }
        if (data.pluginData.ignore) {
          // stop processing
          res.status(200);
          return res.send('Ignoring filtered');
        }
        var address = data.address || '0000000';
        var message = data.message || 'null';
        var datetime = data.datetime || 1;
        var timeDiff = datetime - dupeTime;
        var source = data.source || 'UNK';
        db.from('messages')
          .select('*')
          .modify(function (queryBuilder) {
            if ((dupeLimit != 0) && (dupeTime != 0)) {
              queryBuilder.where('id', 'in', function () {
                this.select('*')
                  //this wierd subquery is to keep mysql happy
                  .from(function () {
                    this.select('id')
                      .from('messages')
                      .where('timestamp', '>', timeDiff)
                      .orderBy('id', 'desc')
                      .limit(dupeLimit)
                      .as('temp_tab')
                  })
              })
                .andWhere('message', '=', message)
                .andWhere('address', '=', address)
            } else if ((dupeLimit != 0) && (dupeTime == 0)) {
              queryBuilder.where('id', 'in', function () {
                this.select('*')
                  //this wierd subquery is to keep mysql happy
                  .from(function () {
                    this.select('id')
                      .from('messages')
                      .orderBy('id', 'desc')
                      .limit(dupeLimit)
                      .as('temp_tab')
                  })
              })
                .andWhere('message', '=', message)
                .andWhere('address', '=', address)
            } else if ((dupeLimit == 0) && (dupeTime != 0)) {
              queryBuilder.where('id', 'in', function () {
                this.select('id')
                  .from('messages')
                  .where('timestamp', '>', timeDiff)
              })
                .andWhere('message', '=', message)
                .andWhere('address', '=', address)
            } else {
              queryBuilder.where('message', '=', message)
                .andWhere('address', '=', address)
            }
          })
          .then((row) => {
            if (row.length > 0 && filterDupes) {
              logger.main.info(util.format('Ignoring duplicate: %o', message));
              res.status(200);
              res.send('Ignoring duplicate');
            } else {
              db.from('capcodes')
                .select('id', 'ignore')
                // TODO: test this doesn't break other DBs - there's a lot of quote changes here
                .modify(function (queryBuilder) {
                  if (dbtype == 'oracledb') {
                    queryBuilder.whereRaw(`'${address}' LIKE "address"`)
                    queryBuilder.orderByRaw(`REPLACE("address", '_', '%') DESC`);
                  } else {
                    queryBuilder.whereRaw(`"${address}" LIKE address`)
                    queryBuilder.orderByRaw(`REPLACE(address, '_', '%') DESC`)
                  }
                })
                .then((row) => {
                  var insert;
                  var alias_id = null;
                  if (row.length > 0) {
                    row = row[0]
                    if (row.ignore == 1) {
                      insert = false;
                      logger.main.info('Ignoring filtered address: ' + address + ' alias: ' + row.id);
                    } else {
                      insert = true;
                      alias_id = row.id;
                    }
                  } else {
                    insert = true;
                  }

                  // overwrite alias_id if set from plugin
                  if (data.pluginData.aliasId) {
                    alias_id = data.pluginData.aliasId;
                  }

                  if (insert == true) {
                    var insertmsg = { address: address, message: message, timestamp: datetime, source: source, alias_id: alias_id, protocol: data.protocol || null }
                    db('messages').insert(insertmsg).returning('id')
                      .then((result) => {
                        // emit the full message
                        var msgId;
                        if (Array.isArray(result)) {
                          msgId = result[0];
                        } else {
                          msgId = result;
                        }
                        logger.main.debug(result);

                        if (dbtype == 'oracledb') {
                          // oracle requires update of search index after insert, can't be trigger for some reason
                          db.raw(`BEGIN CTX_DDL.SYNC_INDEX('search_idx'); END;`)
                            .then((resp) => {
                              logger.main.debug('search_idx sync complete');
                              logger.main.debug(resp);
                            }).catch((err) => {
                              logger.main.error('search_idx sync failed');
                              logger.main.error(err)
                            });
                        }

                        db.from('messages')
                          .select('messages.*', 'capcodes.alias', 'capcodes.agency', 'capcodes.icon', 'capcodes.color', 'capcodes.ignore', 'capcodes.pluginconf')
                          .modify(function (queryBuilder) {
                            queryBuilder.leftJoin('capcodes', 'capcodes.id', '=', 'messages.alias_id')
                          })
                          .where('messages.id', '=', msgId)
                          .then((row) => {
                            if (row.length > 0) {
                              row = row[0]
                              // send data to pluginHandler after processing
                              row.pluginData = data.pluginData;

                              if (row.pluginconf) {
                                row.pluginconf = parseJSON(row.pluginconf);
                              } else {
                                row.pluginconf = {};
                              }
                              logger.main.debug('afterMessage start');
                              pluginHandler.handle('message', 'after', row, function (response) {
                                logger.main.debug(util.format('%o', response));
                                logger.main.debug('afterMessage done');
                                // remove the pluginconf object before firing socket message
                                delete row.pluginconf;
                                //begin socket handling - this is the most horrible block of spaghetti code i've seen in my life and i hate myself for being involved in it
                                if (HideCapcode) {
                                  if (pdwMode) {
                                    if (adminShow) {
                                      //If PDWMode on and AdminShow is on send always
                                      req.io.of('adminio').emit('messagePost', row);
                                      if (row.alias_id != null) {
                                        // send to normal user as well if not null alias_id
                                        rowuser = {
                                          "id": row.id,
                                          "message": row.message,
                                          "source": row.source,
                                          "timestamp": row.timestamp,
                                          "alias_id": row.alias_id,
                                          "alias": row.alias,
                                          "agency": row.agency,
                                          "icon": row.icon,
                                          "color": row.color,
                                          "ignore": row.ignore
                                        };
                                        req.io.emit('messagePost', rowuser);
                                      }
                                    } else {
                                      //If AdminShow not on only send if not null alias_id
                                      if (row.alias_id != null) {
                                        req.io.of('adminio').emit('messagePost', row);
                                        rowuser = {
                                          "id": row.id,
                                          "message": row.message,
                                          "source": row.source,
                                          "timestamp": row.timestamp,
                                          "alias_id": row.alias_id,
                                          "alias": row.alias,
                                          "agency": row.agency,
                                          "icon": row.icon,
                                          "color": row.color,
                                          "ignore": row.ignore
                                        };
                                        req.io.emit('messagePost', rowuser);
                                      }
                                    }
                                  } else {
                                    req.io.of('adminio').emit('messagePost', row);
                                    rowuser = {
                                      "id": row.id,
                                      "message": row.message,
                                      "source": row.source,
                                      "timestamp": row.timestamp,
                                      "alias_id": row.alias_id,
                                      "alias": row.alias,
                                      "agency": row.agency,
                                      "icon": row.icon,
                                      "color": row.color,
                                      "ignore": row.ignore
                                    };
                                    req.io.emit('messagePost', rowuser);
                                  }
                                } else {
                                  req.io.of('adminio').emit('messagePost', row);
                                  req.io.emit('messagePost', row);
                                }
                              });
                            } else {
                              logger.main.info('empty results');
                            }
                          })
                          .catch((err) => {
                            logger.main.error(err);
                          });
                      })
                      .catch((err) => {
                        logger.main.error(err);
                      });
                    res.status(200);
                    res.send(msgId.toString());
                  } else {
                    res.status(200);
                    res.send('Ignored');
                  }
                })
                .catch((err) => {
                  logger.main.error(err);
                });
            }
          })
          .catch((err) => {
            logger.main.error(err);
          });
      }
    } else {
      res.status(500);
      res.send('Error - address or message missing');
    }
  });

// GET a message by ID
router.route('/messages/:id')
  .get(authHelper.isLoggedInMessages, function (req, res, next) {
    nconf.load();
    var pdwMode = nconf.get('messages:pdwMode');
    var HideCapcode = nconf.get('messages:HideCapcode');
    var apiSecurity = nconf.get('messages:apiSecurity');
    var id = req.params.id;
    db.from('messages')
      .select('messages.*', 'capcodes.alias', 'capcodes.agency', 'capcodes.icon', 'capcodes.color', 'capcodes.ignore', db.raw('CASE WHEN NOT capcodes.address = messages.address THEN 1 ELSE 0 END as wildcard'))
      .leftJoin('capcodes', 'capcodes.id', '=', 'messages.alias_id')
      .where('messages.id', id)
      .then((row) => {
        if (HideCapcode) {
          if (!req.isAuthenticated() || (req.isAuthenticated() && req.user.role == 'user')) {
            row = {
              "id": row[0].id,
              "message": row[0].message,
              "source": row[0].source,
              "timestamp": row[0].timestamp,
              "alias_id": row[0].alias_id,
              "alias": row[0].alias,
              "agency": row[0].agency,
              "icon": row[0].icon,
              "color": row[0].color,
              "ignore": row[0].ignore
            };
          }
        }
        res.status(200);
        res.json(row);
      })
      .catch(function (err) {
        logger.main.error(err);
        return next(err);
      });
  });

// Get all the messages
router.route('/messages/all/:id')
  .get(authHelper.isLoggedInMessages, function (req, res, next) {
    nconf.load();
    var id = req.params.id;
    db.from('messages')
      .select('messages.*', 'capcodes.alias', 'capcodes.agency', 'capcodes.icon', 'capcodes.color', 'capcodes.ignore', db.raw('CASE WHEN NOT capcodes.address = messages.address THEN 1 ELSE 0 END as wildcard'))
      .where('messages.id', '>', id)
      .then((rows) => {
        res.status(200).json(rows);
      })
      .catch(function (err) {
        logger.main.error(err);
        return next(err);
      });
  });

