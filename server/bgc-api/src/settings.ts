// The switches for moving the site over from n8n, kept in the settings table: Nathan's (key nathan_api, one mode) and
// the areas' (key api_areas, { area: mode }). A mode is 'off', 'admins' or 'everyone'.
import { z } from 'zod';
import type { Auth } from './auth.js';

export const Mode = z.enum(['off', 'admins', 'everyone']);
export type Mode = z.infer<typeof Mode>;

// A saved value as a mode; anything else (unset, mistyped, the wrong shape) is off
export const modeOf = (v: unknown): Mode => (Mode.safeParse(v).success ? (v as Mode) : 'off');

// Whether a switch lets this person through
export const modeOn = (m: Mode, a: Auth) => m === 'everyone' || (m === 'admins' && a.admin);
