'use strict';

// Aliases for the consolidated-navigation path names used in planning docs
// (Employees & Teams / Calls & Library / Settings & Security). The actual
// pages still live at their original /admin/* routes — see
// views/partials/management-tabs.ejs — so nothing else has to change if
// someone bookmarks or links one of these shorter names.

const express = require('express');
const router = express.Router();

router.get('/employees-teams', (req, res) => res.redirect('/admin/employees'));
router.get('/calls-library', (req, res) => res.redirect('/admin/library'));
router.get('/settings-security', (req, res) => res.redirect('/admin/settings'));

module.exports = router;
