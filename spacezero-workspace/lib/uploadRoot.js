'use strict';
const path = require('node:path');
module.exports = { UPLOAD_ROOT: path.resolve(process.env.UPLOAD_ROOT || path.join(__dirname, '..', 'public', 'uploads')) };
