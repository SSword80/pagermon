process.env.NODE_ENV = 'test';

const chai = require('chai');
const should = chai.should();
const chaiHttp = require('chai-http');

chai.use(chaiHttp);

const confFile = './config/config.json';
const nconf = require('nconf');
const server = require('../app');
const db = require('../knex/knex.js');
const passportStub = require('passport-stub');

passportStub.install(server);

nconf.file({ file: confFile });
nconf.load();

beforeEach(() => db.migrate.rollback().then(() => db.migrate.latest().then(() => db.seed.run())));

afterEach(() => db.migrate.rollback().then(() => passportStub.logout()));

describe('GET /api/insights', () => {
    it('should return message insights for a requested range', done => {
        nconf.set('messages:apiSecurity', false);
        nconf.save();

        chai.request(server)
            .get('/api/insights?start=1529487000&end=1529500000')
            .end((err, res) => {
                should.not.exist(err);
                res.status.should.eql(200);
                res.body.messages.should.eql(5);
                res.body.uniqueAddresses.should.eql(4);
                res.body.uniqueCapcodes.should.eql(0);
                res.body.topAddresses[0].address.should.eql('1234567');
                Number(res.body.topAddresses[0].count).should.eql(2);
                res.body.topSources[0].source.should.eql('Client 1');
                Number(res.body.topSources[0].count).should.eql(2);
                res.body.activity.should.be.an('array');
                res.body.activity.reduce((total, point) => total + Number(point.count), 0).should.eql(5);

                res.body.livePulse.should.be.an('object');
                res.body.livePulse.count.should.be.a('number');

                res.body.peakActivity.should.be.an('object');
                res.body.peakActivity.should.have.property('timestamp');
                res.body.peakActivity.should.have.property('count');
                res.body.peakActivity.should.have.property('averagePerHour');

                res.body.trends.should.be.an('object');
                res.body.trends.period.should.be.an('object');
                res.body.trends.agencies.should.be.an('array');
                res.body.trends.protocols.should.be.an('array');

                res.body.anomaly.should.be.an('object');
                res.body.anomaly.should.have.property('status');
                res.body.anomaly.should.have.property('current');
                res.body.anomaly.should.have.property('baseline');
                res.body.anomaly.should.have.property('percent');
                res.body.anomaly.should.have.property('sufficientData');
                res.body.anomaly.current.should.be.a('number');
                res.body.anomaly.baseline.should.be.a('number');
                res.body.anomaly.percent.should.be.a('number');
                res.body.anomaly.sufficientData.should.be.a('boolean');

                done();
            });
    });

    it('should report a spike when current traffic follows zero-traffic history', done => {
        nconf.set('messages:apiSecurity', false);
        nconf.save();

        var now = Math.floor(Date.now() / 1000);
        var currentHour = Math.floor(now / 3600) * 3600;

        db('messages')
            .del()
            .then(() => db('messages').insert({
                address: '9999999',
                message: 'Anomaly test message',
                source: 'ANOMALY-TEST',
                timestamp: currentHour + 60
            }))
            .then(() => chai.request(server)
                .get('/api/insights?start=' + (currentHour - (4 * 3600)) + '&end=' + (currentHour + 3600))
            )
            .then(res => {
                res.status.should.eql(200);
                res.body.anomaly.status.should.eql('spike');
                res.body.anomaly.current.should.eql(1);
                res.body.anomaly.baseline.should.eql(0);
                res.body.anomaly.percent.should.eql(100);
                res.body.anomaly.sufficientData.should.eql(true);
                done();
            })
            .catch(done);
    });

    it('should return 400 for an invalid date range', done => {
        nconf.set('messages:apiSecurity', false);
        nconf.save();

        chai.request(server)
            .get('/api/insights?start=1529500000&end=1529487000')
            .end((err, res) => {
                should.not.exist(err);
                res.status.should.eql(400);
                res.body.error.should.eql('Invalid date range');
                done();
            });
    });
});
