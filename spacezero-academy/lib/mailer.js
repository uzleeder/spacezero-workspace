'use strict';

const nodemailer = require('nodemailer');

function isEmailConfigured() {
  const resend = process.env.RESEND_API_KEY || process.env.RESEND_API;
  return Boolean((process.env.ACCOUNT_EMAIL_ORIGIN || process.env.APP_ORIGIN) && (resend
    ? (process.env.RESEND_FROM || process.env.SMTP_FROM)
    : (process.env.SMTP_HOST && process.env.SMTP_FROM)));
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
  if (!isEmailConfigured()) throw new Error('Email delivery is not configured');
  const invitation = kind === 'invite';
  const url = new URL(`/${invitation ? 'accept-invite' : 'reset-password'}/${rawToken}`, process.env.ACCOUNT_EMAIL_ORIGIN || process.env.APP_ORIGIN).href;
  const message = {
    from: process.env.RESEND_FROM || process.env.SMTP_FROM,
    to: email,
    subject: invitation ? 'Activate your SpaceZero Workspace account' : 'Reset your SpaceZero Workspace password',
    text: `${invitation ? 'Your administrator invited you to SpaceZero Workspace. Create your own password to activate your account.' : 'A password reset was requested for your SpaceZero Workspace account.'}\n\n${url}\n\nThis single-use link expires in ${invitation ? '24 hours' : '1 hour'}. If you did not expect this email, ignore it. Never share this link.`,
  };
  const key = process.env.RESEND_API_KEY || process.env.RESEND_API;
  if (key) {
    let response;
    try {
      response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...message, to: [email] }),
        signal: AbortSignal.timeout(15000),
      });
    } catch { throw new Error('Resend email request failed'); }
    // Never log response bodies: they may contain recipient information or activation links.
    if (!response.ok) throw new Error(`Resend rejected email (HTTP ${response.status})`);
    const result = await response.json().catch(() => null);
    if (!result?.id) throw new Error('Resend did not confirm email acceptance');
    return;
  }
  const transport = nodemailer.createTransport(mailConfig());
  const info = await transport.sendMail({ ...message, disableFileAccess: true, disableUrlAccess: true });
  if (!info.accepted?.length || info.rejected?.length) throw new Error('Email was not accepted by the mail server');
}

module.exports = { sendAccountEmail, mailConfig, isEmailConfigured };
