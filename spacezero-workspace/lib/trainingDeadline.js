'use strict';
// Assignment forms use the company's Tashkent clock, independent of the server's timezone.
function trainingDeadline(date, time = '23:59') {
  if (!date) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Enter a valid due date and time.');
  const day = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== date) throw new Error('Enter a valid due date.');
  return new Date(`${date}T${time}:00+05:00`);
}
function formatDeadline(date) {
  return date ? `${date.toLocaleString('en-GB', { timeZone: 'Asia/Tashkent', dateStyle: 'medium', timeStyle: 'short' })} (Tashkent, UTC+05:00)` : 'No deadline';
}
module.exports = { trainingDeadline, formatDeadline };
