const express = require('express');
const path = require('node:path');

// Never expose the application root: it can contain the database, backups,
// backend source, and local configuration when running node server.js.
module.exports = function attachUiFiles(app) {
    app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
    app.get('/style.css', (req, res) => res.sendFile(path.join(__dirname, 'style.css')));
    app.use('/js', express.static(path.join(__dirname, 'js')));
    app.use('/assets', express.static(path.join(__dirname, 'assets')));
};
