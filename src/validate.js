import { ApiError } from './errors.js';

export const bad = (msg) => new ApiError(400, 'invalid_request', msg);

export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function requireString(v, name, max) {
  if (typeof v !== 'string' || v.trim() === '') throw bad(`"${name}" must be a non-empty string`);
  if (v.length > max) throw bad(`"${name}" exceeds ${max} characters`);
  return v;
}

export const optionalString = (v, name, max) =>
  v === undefined ? undefined : requireString(v, name, max);

export function optionalBool(v, name, def) {
  if (v === undefined) return def;
  if (typeof v !== 'boolean') throw bad(`"${name}" must be a boolean`);
  return v;
}
