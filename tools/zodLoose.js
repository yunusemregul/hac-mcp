import { z } from 'zod';

export function optionalLooseNumber() {
  return z.preprocess((val) => {
    if (val === undefined || val === null) return undefined;
    if (typeof val === 'number') return val;
    if (typeof val === 'string' && val.trim() !== '') {
      const n = Number(val);
      if (!isNaN(n)) return n;
    }
    return val;
  }, z.number().optional());
}

export function optionalLooseBool() {
  return z.preprocess((val) => {
    if (val === undefined || val === null) return undefined;
    if (typeof val === 'boolean') return val;
    if (typeof val === 'string') {
      const t = val.trim().toLowerCase();
      if (t === 'true' || t === '1' || t === 'yes') return true;
      if (t === 'false' || t === '0' || t === 'no') return false;
    }
    return val;
  }, z.boolean().optional());
}
