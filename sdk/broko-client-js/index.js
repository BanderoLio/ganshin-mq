'use strict';

const { connect, Connection } = require('./lib/connection');
const { Channel } = require('./lib/channel');

module.exports = {
    connect,
    Connection,
    Channel,
    version: '0.1.0',
};
