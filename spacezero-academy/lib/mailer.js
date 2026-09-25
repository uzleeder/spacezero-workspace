'use strict';

const nodemailer = require('nodemailer');

function isEmailConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM && process.env.APP_ORIGIN);
}

function mailConfig() {
  const port = Number(process.env.SMTP_PORT || 587);
  if (!isEmailConfigured()) throw new Error('Email delivery is not configured');
  return {
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    requireTLS: process.env.NODE_ENV !== 'test',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    logger: false, debug: false,
  };
}

async function sendAccountEmail(email, rawToken, kind) {
  const transport = nodemailer.createTransport(mailConfig());
  const invitation = kind === 'invite';
  const url = new URL(`/${invitation ? 'accept-invite' : 'reset-password'}/${rawToken}`, process.env.APP_ORIGIN).href;
  const info = await transport.sendMail({
    from: process.env.SMTP_FROM,
    to: email,
    subject: invitation ? 'Activate your SpaceZero Academy account' : 'Reset your SpaceZero Academy password',
    text: `${invitation ? 'Your administrator invited you to SpaceZero Academy. Create your own password to activate your account.' : 'A password reset was requested for your SpaceZero Academy account.'}\n\n${url}\n\nThis single-use link expires in ${invitation ? '24 hours' : '1 hour'}. If you did not expect this email, ignore it. Never share this link.`,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  if (!info.accepted?.length || info.rejected?.length) throw new Error('Email was not accepted by the mail server');
}

module.exports = { sendAccountEmail, mailConfig, isEmailConfigured };
