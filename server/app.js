var version = "0.3.13-beta";

var debug = require('debug')('pagermon:server');
var io = require('@pm2/io').init({
    http          : true,
    ignore_routes : [/socket\.io/, /notFound/],
    errors        : true,
    custom_probes : true,
    network       : true,
    ports         : true,
    transactions  : true
});
var http = require('http');
var compression = require('compression');
var express = require('express');
var path = require('path');
var favicon = require('serve-favicon');
var logger = require('./log');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');
var fs = require('fs');
var session = require('express-session');
var request = require('request');
var SQLiteStore = require('connect-sqlite3')(session);
var flash = require('connect-flash');

process.on('SIGINT', function() {
    console.log("\nGracefully shutting down from SIGINT (Ctrl-C)");
    process.exit(1);
});

var conf_defaults = require('./config/default.json');
var confFile = './config/config.json';
if (!fs.existsSync(confFile)) {
    fs.writeFileSync(confFile, JSON.stringify(conf_defaults, null, 2));
}
var nconf = require('nconf');
nconf.file({ file: confFile });
nconf.load();

var theme = nconf.get('global:theme');
if (!theme) {
  nconf.set('global:theme', "default");
  nconf.save();
  var theme = nconf.get('global:theme');
}

var dbtype = nconf.get('database:type');
if (dbtype == 'pg' || dbtype == 'mysql' || dbtype == 'mssql') {
    if (!nconf.get('database:port')) {
        nconf.set('database:port', 3306);
        nconf.save();
    }
}

var azureEnable = nconf.get('monitoring:azureEnable');
var azureKey = nconf.get('monitoring:azureKey');
if (azureEnable) {
  logger.main.debug('Starting Azure Application Insights');
  const appInsights = require('applicationinsights');
  appInsights.setup(azureKey)
             .setAutoDependencyCorrelation(true)
             .setAutoCollectRequests(true)
             .setAutoCollectPerformance(true)
             .setAutoCollectExceptions(true)
             .setAutoCollectDependencies(true)
             .setAutoCollectConsole(true)
             .setUseDiskRetryCaching(true)
             .start();
}

checkForDbDriver(nconf.get('database:type'));

var dbinit = require('./db');
dbinit.init();
var db = require('./knex/knex.js');

var passport = require('./auth/local');

// routes
var index = require('./routes/index');
var admin = require('./routes/admin');
var api = require('./routes/api');
var insights = require('./routes/insights');
var auth = require('./routes/auth');

var port = normalizePort(process.env.PORT || '3000');
var app = express();
app.set('port', port);
app.set('views', path.join(__dirname, 'themes', theme, 'views'));
app.set('view engine', 'ejs');
app.set('trust proxy', 'loopback, linklocal, uniquelocal');

var server = http.createServer(app);
var io = require('socket.io').listen(server);
server.listen(port);
server.on('error', onError);
server.on('listening', onListening);
server.on('connection', function(connection) {
  connection.setTimeout(600 * 1000);
});
io.sockets.setMaxListeners(20);
io.sockets.on('connection', function(socket) {
  socket.removeAllListeners();
  debug('client connect to normal socket');
});
var adminio = io.of('/adminio');
adminio.on('connection', function(socket) {
  socket.removeAllListeners();
  debug('client connect to admin socket');
});

app.use(favicon(path.join(__dirname, 'themes', theme, 'public', 'favicon.ico')));
app.use(function(req, res, next) {
    req.io = io;
    next();
});

var secret = nconf.get('global:sessionSecret');
app.use(compression());
app.use(require("morgan")("combined", { "stream": logger.http.stream }));
app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());

var sessSet = {
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 },
    store: new SQLiteStore,
    saveUninitialized: true,
    resave: 'true',
    secret: secret
};

if (process.env.HOSTNAME && process.env.USE_COOKIE_HOST)
    sessSet.cookie.domain = '.' + process.env.HOSTNAME;

app.use(session(sessSet));
app.use(passport.initialize());
app.use(passport.session());
app.use(flash());
app.use(express.static(path.join(__dirname, 'themes', theme, 'public')));
app.use('/node_modules', express.static(path.join(__dirname, 'node_modules')));
app.use(function(req, res, next) {
  res.locals.version = version;
  res.locals.loglevel = nconf.get('global:loglevel') || 'info';
  next();
});

app.use('/', index);
app.use('/admin', admin);
app.use('/post', api);
app.use('/api', api);
app.use('/api/insights', insights);
app.use('/auth', auth);

app.use(function(req, res, next) {
  var err = new Error('Not Found');
  err.status = 404;
  next(err);
});

app.use(function(err, req, res, next) {
  var title = nconf.get('global:monitorName') || 'PagerMon';
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};
  res.locals.login = req.isAuthenticated();
  res.locals.gaEnable = nconf.get('monitoring:gaEnable');
  res.locals.monitorName = nconf.get('global:monitorName');
  res.locals.register = nconf.get('auth:registration');
  res.status(err.status || 500);
  res.render(path.join(__dirname, 'themes', theme, 'views', 'global', 'error'), { title: title });
});

var dbtype = nconf.get('database:type');
if (dbtype == 'mysql') {
  const cronvalidate = require('cron-validator');
  var cronartime = nconf.get('database:aliasRefreshInterval');
  if (!cronartime) { cronartime = "0 5,35 * * * *"; }
  if (!cronvalidate.isValidCron(cronartime, { seconds: true })) {
    logger.main.warn('CRON: Invalid CRON configuration in config file. Defaulting to: "0 5,35 * * * *" ');
    cronartime = "0 5,35 * * * *";
  }
  var aliasRefreshJob = require('cron').CronJob;
  new aliasRefreshJob(cronartime, function() {
    var refreshRequired = nconf.get('database:aliasRefreshRequired');
    logger.main.debug('CRON: Running Cronjob AliasRefresh');
    if (refreshRequired == 1) {
      console.time('updateMap');
      logger.main.info('CRON: Alias Refresh required, running.');
      db('messages').update('alias_id', function() {
        this.select('id')
          .from('capcodes')
          .where(db.ref('messages.address'), 'like', db.ref('capcodes.address'))
          .orderByRaw("REPLACE(address, '_', '%') DESC LIMIT 1");
      })
      .then(function(result) {
        console.timeEnd('updateMap');
        nconf.set('database:aliasRefreshRequired', 0);
        nconf.save();
        logger.main.info('CRON: Alias Refresh Successful');
      })
      .catch(function(err) {
        logger.main.error('CRON: Error refreshing aliases' + err);
        console.timeEnd('updateMap');
      });
    } else {
      logger.main.debug('CRON: Alias Refresh not Required, Skipping.');
    }
  }, null, true);
}

if (process.env.NODE_ENV === 'test') {
  logger.main.silent = true;
  logger.auth.silent = true;
  logger.db.silent = true;
  logger.http.silent = true;
}

module.exports = app;

function normalizePort(val) {
  var port = parseInt(val, 10);
  if (isNaN(port)) return val;
  if (port >= 0) return port;
  return false;
}

function onError(error) {
  if (error.syscall !== 'listen') throw error;
  var bind = typeof port === 'string' ? 'Pipe ' + port : 'Port ' + port;
  switch (error.code) {
    case 'EACCES':
      console.error(bind + ' requires elevated privileges');
      process.exit(1);
      break;
    case 'EADDRINUSE':
      console.error(bind + ' is already in use');
      process.exit(1);
      break;
    default:
      throw error;
  }
}

function checkForDbDriver(driver) {
  switch (driver) {
    case 'sqlite3':
      try { require('sqlite3'); }
      catch (e) {
        logger.main.error('Selected database type is sqlite3, but npm package sqlite3 was not installed.');
        logger.main.error('Please run npm i sqlite3 to install or refer to https://www.npmjs.com/package/sqlite3 for reference');
        process.exit(1);
      }
      break;
    case 'mysql':
      try { require('knex'); }
      catch (e) {
        logger.main.error('Selected database type is mysql, but npm package knex was not installed.');
        logger.main.error('Please run npm i knex to install or refer to https://www.npmjs.com/package/knex for reference');
        process.exit(1);
      }
      break;
    case 'oracledb':
      try { require('oracledb'); }
      catch (e) {
        logger.main.error('Selected database type is oracledb, but npm package oracledb was not installed.');
        logger.main.error('Please run npm i oracledb to install or refer to https://www.npmjs.com/package/oracledb for reference');
        process.exit(1);
      }
      break;
    default:
      logger.main.error('No database type was specified.');
      process.exit(1);
  }
}

function onListening() {
  var addr = server.address();
  var bind = typeof addr === 'string' ? 'pipe ' + addr : 'port ' + addr.port;
  logger.main.info('Listening on ' + bind);
}
